// CodeBuddy intl gateway answers 400 {"code":11128,"msg":"request illegal"}
// ("failed channel verification") unless every chat request carries
// X-Conversation-* IDs, like the official client sends. Verified A/B against
// the live gateway: all three headers present -> 200, any subset -> 11128.
//
// X-Conversation-ID is stable per conversation (the upstream buckets its
// prompt-prefix cache by it); Request-ID and Message-ID are fresh per request.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

import { CodeBuddyIntlExecutor, deriveConversationId } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

const SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
// What the executor hands to buildHeaders: the transformed (typed-block) body.
const bodyOf = (...turns) => ({ messages: [{ role: "system", content: SYSTEM }, ...turns] });
const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: text });

describe("CodeBuddyIntlExecutor conversation headers (#11128)", () => {
  const exec = new CodeBuddyIntlExecutor();
  const creds = { accessToken: "tok-abc", connectionId: "conn-1" };
  const conversationId = (c, b) => exec.buildHeaders(c, true, "url", "glm-5.2", b)["X-Conversation-ID"];

  it("adds X-Conversation-ID as a UUID v4", () => {
    expect(exec.buildHeaders(creds, true)["X-Conversation-ID"]).toMatch(UUID_V4);
    expect(conversationId(creds, bodyOf(user("hi")))).toMatch(UUID_V4);
  });

  it("adds X-Conversation-Request-ID and X-Conversation-Message-ID as 32 lowercase hex chars", () => {
    const h = exec.buildHeaders(creds, true, "url", "glm-5.2", bodyOf(user("hi")));
    expect(h["X-Conversation-Request-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Message-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Request-ID"]).not.toBe(h["X-Conversation-Message-ID"]);
  });

  it("generates fresh Request/Message IDs on every call, even for the same conversation", () => {
    const body = bodyOf(user("hi"));
    const a = exec.buildHeaders(creds, true, "url", "glm-5.2", body);
    const b = exec.buildHeaders(creds, true, "url", "glm-5.2", body);
    for (const key of ["X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
      expect(a[key]).toBeTruthy();
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it("falls back to a fresh random Conversation ID when there is nothing to derive it from", () => {
    const a = exec.buildHeaders(creds, true);
    const b = exec.buildHeaders(creds, true);
    expect(a["X-Conversation-ID"]).toMatch(UUID_V4);
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
    expect(conversationId(creds, bodyOf())).not.toBe(conversationId(creds, bodyOf())); // system prompt only
  });

  describe("stable X-Conversation-ID", () => {
    it("is identical across turns of the same conversation", () => {
      const turn1 = bodyOf(user("fix the parser"));
      const turn2 = bodyOf(user("fix the parser"), assistant("done, see parser.js"), user("now add tests"));
      const turn3 = bodyOf(user("fix the parser"), assistant("done"), user("now add tests"), assistant("added"), user("thanks"));
      expect(conversationId(creds, turn1)).toBe(conversationId(creds, turn2));
      expect(conversationId(creds, turn2)).toBe(conversationId(creds, turn3));
    });

    it("does not depend on the system prompt (it is identical across conversations)", () => {
      const a = { messages: [{ role: "system", content: "prompt v1" }, user("same first message")] };
      const b = { messages: [{ role: "system", content: "prompt v2" }, user("same first message")] };
      expect(conversationId(creds, a)).toBe(conversationId(creds, b));
    });

    it("reads typed-block user content the same as the plain string (before/after the shape transform)", () => {
      const plain = bodyOf(user("fix the parser"));
      const typed = bodyOf({ role: "user", content: [{ type: "text", text: "fix the parser" }] });
      expect(conversationId(creds, plain)).toBe(conversationId(creds, typed));
    });

    it("differs across conversations with different first user messages", () => {
      expect(conversationId(creds, bodyOf(user("fix the parser")))).not.toBe(conversationId(creds, bodyOf(user("write a poem"))));
    });

    it("differs across connections for the same conversation", () => {
      const body = bodyOf(user("fix the parser"));
      expect(conversationId({ ...creds, connectionId: "conn-1" }, body)).not.toBe(conversationId({ ...creds, connectionId: "conn-2" }, body));
    });

    it("prefers a client-provided session id over the first user message", () => {
      const withSession = (sid) => ({ ...creds, rawHeaders: { "x-claude-code-session-id": sid } });
      const a1 = conversationId(withSession("sess-A"), bodyOf(user("first")));
      const a2 = conversationId(withSession("sess-A"), bodyOf(user("something else entirely")));
      const b = conversationId(withSession("sess-B"), bodyOf(user("first")));
      expect(a1).toBe(a2);
      expect(a1).not.toBe(b);
      expect(a1).not.toBe(conversationId(creds, bodyOf(user("first"))));
      // session ids stay scoped per connection (the prefix cache is per account)
      expect(a1).not.toBe(conversationId({ ...withSession("sess-A"), connectionId: "conn-2" }, bodyOf(user("first"))));
    });

    it("exposes the derivation directly", () => {
      expect(deriveConversationId(creds, bodyOf(user("x")))).toBe(deriveConversationId(creds, bodyOf(user("x"))));
    });
  });

  it("keeps the registry headers and bearer auth", () => {
    const h = exec.buildHeaders(creds, true);
    expect(h["x-codebuddy-request"]).toBe("1");
    expect(h["X-Product"]).toBe("SaaS");
    expect(h["Authorization"]).toBe("Bearer tok-abc");
    expect(h["Accept"]).toBe("text/event-stream");
  });

  it("prefers apiKey over accessToken for the bearer token", () => {
    const h = exec.buildHeaders({ apiKey: "key-xyz", accessToken: "tok-abc" }, true);
    expect(h["Authorization"]).toBe("Bearer key-xyz");
  });

  describe("on the real chat request path (execute)", () => {
    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    });

    const run = (body, credentials = creds) => exec.execute({ model: "glm-5.2", body, stream: true, credentials });

    it("keeps X-Conversation-ID across turns while Request/Message IDs are fresh per request", async () => {
      await run({ messages: [user("fix the parser")] });
      await run({ messages: [user("fix the parser"), assistant("done"), user("now add tests")] });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url1, opts1] = fetchMock.mock.calls[0];
      const [, opts2] = fetchMock.mock.calls[1];
      expect(url1).toBe("https://www.codebuddy.ai/v2/chat/completions");
      expect(opts1.headers["X-Conversation-ID"]).toMatch(UUID_V4);
      expect(opts1.headers["X-Conversation-Request-ID"]).toMatch(HEX32);
      expect(opts1.headers["X-Conversation-Message-ID"]).toMatch(HEX32);
      expect(opts2.headers["X-Conversation-ID"]).toBe(opts1.headers["X-Conversation-ID"]);
      expect(opts2.headers["X-Conversation-Request-ID"]).not.toBe(opts1.headers["X-Conversation-Request-ID"]);
      expect(opts2.headers["X-Conversation-Message-ID"]).not.toBe(opts1.headers["X-Conversation-Message-ID"]);
    });

    it("derives the ID from the original messages: system prompt changes between turns do not move it", async () => {
      await run({ messages: [{ role: "system", content: "volatile prompt, turn 1" }, user("fix the parser")] });
      await run({ messages: [{ role: "system", content: "volatile prompt, turn 2" }, user("fix the parser"), assistant("ok"), user("more")] });
      expect(fetchMock.mock.calls[1][1].headers["X-Conversation-ID"]).toBe(fetchMock.mock.calls[0][1].headers["X-Conversation-ID"]);
    });

    it("uses a different ID for a different conversation and for a different connection", async () => {
      await run({ messages: [user("fix the parser")] });
      await run({ messages: [user("write a poem")] });
      await run({ messages: [user("fix the parser")] }, { ...creds, connectionId: "conn-2" });
      const ids = fetchMock.mock.calls.map(([, opts]) => opts.headers["X-Conversation-ID"]);
      expect(new Set(ids).size).toBe(3);
    });

    it("keeps the same ID on the legacy fallback re-send", async () => {
      fetchMock.mockReset();
      fetchMock
        .mockImplementationOnce(async () => new Response('{"error":{"message":"内容违规","type":"content_policy_violation"}}', { status: 400 }))
        .mockImplementationOnce(async () => new Response("data: [DONE]\n\n", { status: 200 }));
      await run({ messages: [{ role: "system", content: "You are Claude Code, Anthropic's CLI." }, user("fix the parser")] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [first, retry] = fetchMock.mock.calls.map(([, opts]) => opts.headers);
      expect(retry["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
      expect(retry["X-Conversation-Request-ID"]).not.toBe(first["X-Conversation-Request-ID"]);
    });
  });
});
