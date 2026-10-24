// WorkBuddy International (workbuddy.ai) chat path: same CodeBuddy gateway as
// codebuddy-intl, but the desktop client fingerprint of the global realm. A wrong
// User-Agent platform segment is answered 403 code 11140, so the exact string is
// pinned here. Chat is stream-only; X-Refresh-Token must never ride on a chat call.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

import { WorkBuddyExecutor } from "../../open-sse/executors/workbuddy.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { deriveWorkBuddyStableId, jwtSubject, resolveWorkBuddyUid } from "../../open-sse/utils/workbuddyIdentity.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX36 = /^[0-9a-f]{36}$/;

const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const user = (text) => ({ role: "user", content: text });

describe("WorkBuddyExecutor chat request", () => {
  const exec = new WorkBuddyExecutor();
  const creds = { accessToken: "tok-wb", connectionId: "conn-1", providerSpecificData: { uid: "uid-111" } };
  const headersFor = (c = creds, body = { messages: [user("hi")] }) => exec.buildHeaders(c, true, "url", "glm-5.3", body);

  it("is registered for the workbuddy provider", () => {
    expect(getExecutor("workbuddy")).toBeInstanceOf(WorkBuddyExecutor);
    expect(exec.provider).toBe("workbuddy");
  });

  describe("headers", () => {
    it("sends the exact WorkBuddy AI desktop User-Agent", () => {
      expect(headersFor()["User-Agent"]).toBe("WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1");
    });

    it("declares the global realm: Origin/Referer, X-Domain, no enterprise id, en-US", () => {
      const h = headersFor();
      expect(h["Origin"]).toBe("https://www.workbuddy.ai");
      expect(h["Referer"]).toBe("https://www.workbuddy.ai/");
      expect(h["X-Domain"]).toBe("www.workbuddy.ai");
      expect(h["X-No-Enterprise-Id"]).toBe("1");
      expect(h["Accept-Language"]).toBe("en-US");
    });

    it("sends the client gate headers and the streaming Accept", () => {
      const h = headersFor();
      expect(h["X-CodeBuddy-Request"]).toBe("1");
      expect(h["X-Requested-With"]).toBe("XMLHttpRequest");
      expect(h["Accept"]).toBe("application/json, text/event-stream");
      expect(h["Content-Type"]).toBe("application/json");
    });

    it("sends the usage attribution headers as WorkBuddy", () => {
      const h = headersFor();
      expect(h["X-Agent-Purpose"]).toBe("conversation");
      expect(h["X-IDE-Name"]).toBe("WorkBuddy");
      expect(h["X-IDE-Type"]).toBe("WorkBuddy");
      expect(h["X-Product"]).toBe("WorkBuddy");
      expect(h["X-IDE-Version"]).toBe("5.5.4");
    });

    it("keeps the Accept streaming even when the caller passes stream=false", () => {
      expect(exec.buildHeaders(creds, false, "url", "glm-5.3", { messages: [user("hi")] })["Accept"]).toBe("application/json, text/event-stream");
    });

    it("authenticates with the bearer access token and never sends X-Refresh-Token", () => {
      const h = headersFor({ ...creds, refreshToken: "rt-secret" });
      expect(h["Authorization"]).toBe("Bearer tok-wb");
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-refresh-token");
      expect(JSON.stringify(h)).not.toContain("rt-secret");
    });
  });

  describe("account identity", () => {
    it("sends X-User-Id from providerSpecificData.uid", () => {
      const h = headersFor();
      expect(h["X-User-Id"]).toBe("uid-111");
      expect(h["X-No-User-Id"]).toBeUndefined();
    });

    it("falls back to the access token's sub claim, then to X-No-User-Id", () => {
      expect(headersFor({ accessToken: jwt({ sub: "uid-from-jwt" }), connectionId: "c" })["X-User-Id"]).toBe("uid-from-jwt");
      const anon = headersFor({ accessToken: "opaque-token", connectionId: "c" });
      expect(anon["X-User-Id"]).toBeUndefined();
      expect(anon["X-No-User-Id"]).toBe("1");
    });

    it("derives a stable 36-hex X-Machine-ID / X-Session-ID per account", () => {
      const a1 = headersFor();
      const a2 = headersFor();
      expect(a1["X-Machine-ID"]).toMatch(HEX36);
      expect(a1["X-Session-ID"]).toMatch(HEX36);
      expect(a1["X-Machine-ID"]).not.toBe(a1["X-Session-ID"]);
      expect(a2["X-Machine-ID"]).toBe(a1["X-Machine-ID"]);
      expect(a2["X-Session-ID"]).toBe(a1["X-Session-ID"]);
    });

    it("gives different accounts different device and session ids", () => {
      const a = headersFor({ ...creds, providerSpecificData: { uid: "uid-111" } });
      const b = headersFor({ ...creds, providerSpecificData: { uid: "uid-222" } });
      expect(b["X-Machine-ID"]).not.toBe(a["X-Machine-ID"]);
      expect(b["X-Session-ID"]).not.toBe(a["X-Session-ID"]);
    });

    it("seeds the ids from the connection id when the uid is unknown, and omits them with no seed", () => {
      const byConn = (connectionId) => headersFor({ accessToken: "opaque", connectionId });
      expect(byConn("conn-1")["X-Machine-ID"]).toMatch(HEX36);
      expect(byConn("conn-1")["X-Machine-ID"]).toBe(byConn("conn-1")["X-Machine-ID"]);
      expect(byConn("conn-1")["X-Machine-ID"]).not.toBe(byConn("conn-2")["X-Machine-ID"]);
      const none = headersFor({ accessToken: "opaque" });
      expect(none["X-Machine-ID"]).toBeUndefined();
      expect(none["X-Session-ID"]).toBeUndefined();
    });

    it("matches the reference derivation (sha256 of wb2a:<purpose>:<uid>, first 36 hex)", () => {
      expect(deriveWorkBuddyStableId("uid-111", "machine")).toBe(headersFor()["X-Machine-ID"]);
      expect(deriveWorkBuddyStableId("uid-111", "session")).toBe(headersFor()["X-Session-ID"]);
    });
  });

  describe("conversation header family", () => {
    it("adds a stable X-Conversation-ID (UUID v4) shared with codebuddy-intl's derivation", () => {
      const turn1 = headersFor(creds, { messages: [user("fix the parser")] });
      const turn2 = headersFor(creds, { messages: [user("fix the parser"), { role: "assistant", content: "done" }, user("more")] });
      expect(turn1["X-Conversation-ID"]).toMatch(UUID_V4);
      expect(turn2["X-Conversation-ID"]).toBe(turn1["X-Conversation-ID"]);
      expect(headersFor(creds, { messages: [user("write a poem")] })["X-Conversation-ID"]).not.toBe(turn1["X-Conversation-ID"]);
      expect(headersFor({ ...creds, connectionId: "conn-2" }, { messages: [user("fix the parser")] })["X-Conversation-ID"]).not.toBe(turn1["X-Conversation-ID"]);
    });

    it("mints fresh 32-hex request and message ids on every request", () => {
      const a = headersFor();
      const b = headersFor();
      for (const key of ["X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
        expect(a[key]).toMatch(HEX32);
        expect(a[key]).not.toBe(b[key]);
      }
      expect(a["X-Conversation-Request-ID"]).not.toBe(a["X-Conversation-Message-ID"]);
    });

    it("mirrors the ids like the official client: request = message, root/trace = conversation request", () => {
      const h = headersFor();
      expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
      expect(h["X-Root-Request-ID"]).toBe(h["X-Conversation-Request-ID"]);
      expect(h["X-Trace-ID"]).toBe(h["X-Conversation-Request-ID"]);
    });

    it("sends B3 trace headers (32-hex trace id, 16-hex span id, sampled)", () => {
      const h = headersFor();
      expect(h["X-B3-TraceId"]).toMatch(HEX32);
      expect(h["X-B3-TraceId"]).toBe(h["X-Conversation-Request-ID"]);
      expect(h["X-B3-SpanId"]).toMatch(/^[0-9a-f]{16}$/);
      expect(h["X-Conversation-Message-ID"].startsWith(h["X-B3-SpanId"])).toBe(true);
      expect(h["X-B3-Sampled"]).toBe("1");
    });
  });

  describe("request body", () => {
    it("forces stream:true whatever the client asked for", () => {
      for (const stream of [false, true, undefined]) {
        const out = exec.transformRequest("glm-5.3", { messages: [user("hi")], stream }, stream, creds);
        expect(out.stream).toBe(true);
      }
    });

    it("shares the intl transform: leading system prompt, typed user blocks, reasoning mirror", () => {
      const out = exec.transformRequest("glm-5.3", { messages: [user("hi")], reasoning_effort: "high" }, false, creds);
      expect(out.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." });
      expect(out.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
      expect(out.reasoning_effort).toBe("high");
      expect(out.reasoning_summary).toBe("auto");
    });
  });

  describe("on the real chat request path (execute)", () => {
    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    });

    it("POSTs a streaming request to the global /v2/chat/completions with the fingerprint", async () => {
      await exec.execute({ model: "glm-5.3", body: { messages: [user("hi")], stream: false }, stream: false, credentials: creds });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://www.workbuddy.ai/v2/chat/completions");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body).stream).toBe(true);
      expect(opts.headers["User-Agent"]).toBe("WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1");
      expect(opts.headers["Accept"]).toBe("application/json, text/event-stream");
      expect(opts.headers["X-User-Id"]).toBe("uid-111");
      expect(opts.headers["X-Machine-ID"]).toMatch(HEX36);
    });

    it("keeps the same account identity on the content-filter legacy re-send", async () => {
      fetchMock.mockReset();
      fetchMock
        .mockImplementationOnce(async () => new Response('{"error":{"message":"内容违规","type":"content_policy_violation"}}', { status: 400 }))
        .mockImplementationOnce(async () => new Response("data: [DONE]\n\n", { status: 200 }));
      await exec.execute({
        model: "glm-5.3",
        body: { messages: [{ role: "system", content: "You are Claude Code, Anthropic's CLI." }, user("fix the parser")] },
        stream: true,
        credentials: creds,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [first, retry] = fetchMock.mock.calls.map(([, opts]) => opts.headers);
      expect(retry["X-Machine-ID"]).toBe(first["X-Machine-ID"]);
      expect(retry["X-Conversation-ID"]).toBe(first["X-Conversation-ID"]);
      expect(retry["X-Conversation-Request-ID"]).not.toBe(first["X-Conversation-Request-ID"]);
    });
  });
});

describe("workbuddyIdentity", () => {
  it("jwtSubject reads the sub claim and tolerates garbage", () => {
    expect(jwtSubject(jwt({ sub: "u-1" }))).toBe("u-1");
    expect(jwtSubject(jwt({ iss: "x" }))).toBe("");
    expect(jwtSubject("not-a-jwt")).toBe("");
    expect(jwtSubject("a.%%%.c")).toBe("");
    expect(jwtSubject(undefined)).toBe("");
  });

  it("resolveWorkBuddyUid prefers the stored uid over the token", () => {
    expect(resolveWorkBuddyUid({ providerSpecificData: { uid: "stored" }, accessToken: jwt({ sub: "token" }) })).toBe("stored");
    expect(resolveWorkBuddyUid({ accessToken: jwt({ sub: "token" }) })).toBe("token");
    expect(resolveWorkBuddyUid({})).toBe("");
  });
});
