// WorkBuddy International (workbuddy.ai) chat path: same CodeBuddy gateway as
// codebuddy-intl, but the desktop client fingerprint of the global realm (desktop
// 5.8.4 capture). A wrong User-Agent platform segment is answered 403 code 11140, so
// the exact string and the exact header set are pinned here. Chat is stream-only;
// X-Refresh-Token, X-Machine-ID and X-Session-ID must never ride on a chat call.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

import { WorkBuddyExecutor } from "../../open-sse/executors/workbuddy.js";
import { markLegacyAttempt } from "../../open-sse/executors/codebuddy-base.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import {
  deriveWorkBuddyStableId,
  jwtSubject,
  resolveWorkBuddyUid,
  uuidv7Hex,
  workBuddyBillingUserAgent,
  workBuddyChatUserAgent,
  workBuddyClientVersion,
} from "../../open-sse/utils/workbuddyIdentity.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
// UUIDv7 without hyphens: version nibble 7 at index 12, variant 8-b at index 16.
const UUID7_HEX = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;

const CHAT_UA = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
const ENV_KEYS = ["WORKBUDDY_CLIENT_VERSION", "WORKBUDDY_CLI_VERSION", "WORKBUDDY_CHAT_UA"];

const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const user = (text) => ({ role: "user", content: text });

// Run with WORKBUDDY_* env set (undefined removes the key), restoring the real env afterwards.
const saved = {};
const setEnv = (values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv(Object.fromEntries(ENV_KEYS.map((key) => [key, undefined])));
});

afterEach(() => {
  setEnv(saved);
});

describe("WorkBuddyExecutor chat request", () => {
  const exec = new WorkBuddyExecutor();
  const creds = { accessToken: "tok-wb", connectionId: "conn-1", providerSpecificData: { uid: "uid-111" } };
  const headersFor = (c = creds, body = { messages: [user("hi")] }) => exec.buildHeaders(c, true, "url", "glm-5.3", body);

  it("is registered for the workbuddy provider", () => {
    expect(getExecutor("workbuddy")).toBeInstanceOf(WorkBuddyExecutor);
    expect(exec.provider).toBe("workbuddy");
  });

  describe("headers", () => {
    it("sends exactly the desktop 5.8.4 chat header set, nothing more", () => {
      expect(Object.keys(headersFor()).sort()).toEqual([
        "Accept",
        "Accept-Language",
        "Authorization",
        "Content-Type",
        "Origin",
        "Referer",
        "User-Agent",
        "X-Agent-Intent",
        "X-Agent-Purpose",
        "X-Agent-Type",
        "X-B3-Sampled",
        "X-B3-SpanId",
        "X-B3-TraceId",
        "X-CodeBuddy-Request",
        "X-Conversation-ID",
        "X-Conversation-Message-ID",
        "X-Conversation-Request-ID",
        "X-Domain",
        "X-IDE-Name",
        "X-IDE-Type",
        "X-IDE-Version",
        "X-Private-Data",
        "X-Product",
        "X-Request-ID",
        "X-Requested-With",
        "X-Root-Request-ID",
        "X-Trace-ID",
        "X-User-Id",
        "b3",
        "traceparent",
      ]);
    });

    it("sends the exact WorkBuddy desktop User-Agent", () => {
      expect(headersFor()["User-Agent"]).toBe(CHAT_UA);
    });

    it("declares the global realm: Origin/Referer, X-Domain, en-US, no enterprise headers for a personal account", () => {
      const h = headersFor();
      expect(h["Origin"]).toBe("https://www.workbuddy.ai");
      expect(h["Referer"]).toBe("https://www.workbuddy.ai/");
      expect(h["X-Domain"]).toBe("www.workbuddy.ai");
      expect(h["Accept-Language"]).toBe("en-US");
      for (const key of ["X-No-Enterprise-Id", "X-Enterprise-Id", "X-Tenant-Id"]) expect(h[key]).toBeUndefined();
    });

    it("sends the client gate headers and the browser-style Accept", () => {
      const h = headersFor();
      expect(h["X-CodeBuddy-Request"]).toBe("1");
      expect(h["X-Requested-With"]).toBe("XMLHttpRequest");
      expect(h["Accept"]).toBe("application/json, text/plain, */*");
      expect(h["Content-Type"]).toBe("application/json");
    });

    it("sends the desktop's agent and usage attribution headers", () => {
      const h = headersFor();
      expect(h["X-Agent-Intent"]).toBe("craft");
      expect(h["X-Agent-Purpose"]).toBe("conversation");
      expect(h["X-Agent-Type"]).toBe("main");
      expect(h["X-IDE-Name"]).toBe("WorkBuddy");
      expect(h["X-IDE-Type"]).toBe("WorkBuddy");
      expect(h["X-IDE-Version"]).toBe("5.8.4");
      expect(h["X-Private-Data"]).toBe("true");
      expect(h["X-Product"]).toBe("SaaS");
    });

    it("keeps the same Accept when the caller passes stream=false", () => {
      expect(exec.buildHeaders(creds, false, "url", "glm-5.3", { messages: [user("hi")] })["Accept"]).toBe("application/json, text/plain, */*");
    });

    it("authenticates with the bearer access token and never sends X-Refresh-Token", () => {
      const h = headersFor({ ...creds, refreshToken: "rt-secret" });
      expect(h["Authorization"]).toBe("Bearer tok-wb");
      expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-refresh-token");
      expect(JSON.stringify(h)).not.toContain("rt-secret");
    });

    it("carries no device fingerprint on chat: no X-Machine-ID, X-Session-ID or X-Device-Token", () => {
      const h = headersFor();
      for (const key of ["X-Machine-ID", "X-Session-ID", "X-Device-Token", "X-No-User-Id"]) expect(h[key]).toBeUndefined();
    });
  });

  describe("env overrides", () => {
    it("WORKBUDDY_CLIENT_VERSION bumps X-IDE-Version and the UA app segments, keeps the CLI segment", () => {
      setEnv({ WORKBUDDY_CLIENT_VERSION: "5.9.1" });
      const h = headersFor();
      expect(h["X-IDE-Version"]).toBe("5.9.1");
      expect(h["User-Agent"]).toBe("WorkBuddy/5.9.1 workbuddy-ai/5.9.1 CLI/2.161.0");
    });

    it("WORKBUDDY_CLI_VERSION bumps only the CLI segment", () => {
      setEnv({ WORKBUDDY_CLI_VERSION: "2.170.3" });
      expect(headersFor()["User-Agent"]).toBe("WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.170.3");
    });

    it("WORKBUDDY_CHAT_UA replaces the whole chat UA verbatim and wins over the version vars", () => {
      setEnv({ WORKBUDDY_CHAT_UA: "WorkBuddy/9.9.9 custom/1 CLI/3.0.0", WORKBUDDY_CLIENT_VERSION: "5.9.1" });
      const h = headersFor();
      expect(h["User-Agent"]).toBe("WorkBuddy/9.9.9 custom/1 CLI/3.0.0");
      expect(h["X-IDE-Version"]).toBe("5.9.1");
    });

    it("is read per request, so a changed env needs no rebuild or new executor", () => {
      expect(headersFor()["User-Agent"]).toBe(CHAT_UA);
      setEnv({ WORKBUDDY_CLIENT_VERSION: "6.0.0" });
      expect(headersFor()["User-Agent"]).toBe("WorkBuddy/6.0.0 workbuddy-ai/6.0.0 CLI/2.161.0");
    });

    it("ignores blank values", () => {
      setEnv({ WORKBUDDY_CLIENT_VERSION: "  ", WORKBUDDY_CHAT_UA: "" });
      expect(headersFor()["User-Agent"]).toBe(CHAT_UA);
    });

    it("exposes the same values through the identity helpers (billing UA follows the client version)", () => {
      expect(workBuddyClientVersion()).toBe("5.8.4");
      expect(workBuddyChatUserAgent()).toBe(CHAT_UA);
      expect(workBuddyBillingUserAgent()).toBe("WorkBuddy/5.8.4");
      setEnv({ WORKBUDDY_CLIENT_VERSION: "5.9.1" });
      expect(workBuddyBillingUserAgent()).toBe("WorkBuddy/5.9.1");
    });
  });

  describe("account identity", () => {
    it("sends X-User-Id from providerSpecificData.uid", () => {
      expect(headersFor()["X-User-Id"]).toBe("uid-111");
    });

    it("falls back to the access token's sub claim, then to the hub's \"anonymous\"", () => {
      expect(headersFor({ accessToken: jwt({ sub: "uid-from-jwt" }), connectionId: "c" })["X-User-Id"]).toBe("uid-from-jwt");
      const anon = headersFor({ accessToken: "opaque-token", connectionId: "c" });
      expect(anon["X-User-Id"]).toBe("anonymous");
      expect(anon["X-No-User-Id"]).toBeUndefined();
    });

    it("adds X-Enterprise-Id and X-Tenant-Id for an enterprise account", () => {
      const h = headersFor({ ...creds, providerSpecificData: { uid: "uid-111", enterpriseId: "ent-42" } });
      expect(h["X-Enterprise-Id"]).toBe("ent-42");
      expect(h["X-Tenant-Id"]).toBe("ent-42");
      expect(h["X-No-Enterprise-Id"]).toBeUndefined();
    });
  });

  describe("stable device id derivation (billing only)", () => {
    it("is UUID-shaped, stable per seed, and different per seed and purpose", () => {
      const machine = deriveWorkBuddyStableId("uid-111", "machine");
      expect(machine).toMatch(UUID_V4);
      expect(deriveWorkBuddyStableId("uid-111", "machine")).toBe(machine);
      expect(deriveWorkBuddyStableId("uid-111", "session")).toMatch(UUID_V4);
      expect(deriveWorkBuddyStableId("uid-111", "session")).not.toBe(machine);
      expect(deriveWorkBuddyStableId("uid-222", "machine")).not.toBe(machine);
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

    it("mints fresh UUIDv7 request and message ids on every request", () => {
      const a = headersFor();
      const b = headersFor();
      for (const key of ["X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
        expect(a[key]).toMatch(UUID7_HEX);
        expect(a[key]).not.toBe(b[key]);
      }
      expect(a["X-Conversation-Request-ID"]).not.toBe(a["X-Conversation-Message-ID"]);
    });

    it("mirrors the ids like the desktop: request id = message id, root id = conversation request id", () => {
      const h = headersFor();
      expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
      expect(h["X-Root-Request-ID"]).toBe(h["X-Conversation-Request-ID"]);
    });

    it("sends the trace family: X-Trace-ID, traceparent, b3 and X-B3-* from one trace/span pair", () => {
      const h = headersFor();
      const trace = h["X-Trace-ID"];
      const span = h["X-B3-SpanId"];
      expect(trace).toMatch(UUID7_HEX);
      expect(span).toMatch(HEX16);
      expect(h["X-B3-TraceId"]).toBe(trace);
      expect(h["X-B3-Sampled"]).toBe("1");
      expect(h["traceparent"]).toBe(`00-${trace}-${span}-01`);
      expect(h["b3"]).toBe(`${trace}-${span}-1`);
    });

    it("uses a fresh trace and span on every request, independent of the conversation ids", () => {
      const a = headersFor();
      const b = headersFor();
      expect(b["X-Trace-ID"]).not.toBe(a["X-Trace-ID"]);
      expect(b["X-B3-SpanId"]).not.toBe(a["X-B3-SpanId"]);
      expect(a["X-Trace-ID"]).not.toBe(a["X-Conversation-Request-ID"]);
    });

    it("uuidv7Hex encodes the timestamp in the leading 48 bits", () => {
      const id = uuidv7Hex(0x0123456789ab);
      expect(id).toMatch(UUID7_HEX);
      expect(id.startsWith("0123456789ab7")).toBe(true);
    });
  });

  describe("request body", () => {
    it("forces stream:true whatever the client asked for", () => {
      for (const stream of [false, true, undefined]) {
        const out = exec.transformRequest("glm-5.3", { messages: [user("hi")], stream }, stream, creds);
        expect(out.stream).toBe(true);
      }
    });

    it("shares the intl transform: typed user blocks, reasoning mirror", () => {
      const out = exec.transformRequest("glm-5.3", { messages: [user("hi")], reasoning_effort: "high" }, false, creds);
      expect(out.messages[1].content).toEqual([{ type: "text", text: "hi" }]);
      expect(out.reasoning_effort).toBe("high");
      expect(out.reasoning_summary).toBe("auto");
    });

    it("never sends the CodeBuddy identity line; a neutral lead stands in when the client sent no system prompt", () => {
      const out = exec.transformRequest("glm-5.3", { messages: [user("hi")] }, true, creds);
      expect(out.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
      expect(JSON.stringify(out.messages)).not.toContain("CodeBuddy");
    });

    it("passes the client's own system text through alone, without a prepended lead line", () => {
      const out = exec.transformRequest("glm-5.3", {
        messages: [{ role: "system", content: "Answer in French." }, user("hi")],
      }, true, creds);
      expect(out.messages[0]).toEqual({ role: "system", content: "Answer in French." });
      expect(out.messages).toHaveLength(2);
    });

    it("folds system and developer messages into one leading system message", () => {
      const out = exec.transformRequest("glm-5.3", {
        messages: [{ role: "system", content: "Rule one." }, { role: "developer", content: "Rule two." }, user("hi")],
      }, true, creds);
      expect(out.messages[0]).toEqual({ role: "system", content: "Rule one.\n\nRule two." });
      expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
    });

    it("sends the hub's minimal neutral prompt on the content-filter legacy re-send", () => {
      const out = exec.transformRequest("glm-5.3", markLegacyAttempt({
        messages: [{ role: "system", content: "Answer in French." }, user("hi")],
      }), true, creds);
      expect(out.messages[0].content).toBe(
        "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.",
      );
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
      expect(opts.headers["User-Agent"]).toBe(CHAT_UA);
      expect(opts.headers["Accept"]).toBe("application/json, text/plain, */*");
      expect(opts.headers["X-User-Id"]).toBe("uid-111");
      expect(opts.headers["X-Product"]).toBe("SaaS");
      expect(opts.headers["X-Machine-ID"]).toBeUndefined();
      expect(opts.headers["X-Session-ID"]).toBeUndefined();
    });

    it("keeps the same account identity and conversation on the content-filter legacy re-send", async () => {
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
      expect(retry["X-User-Id"]).toBe(first["X-User-Id"]);
      expect(retry["User-Agent"]).toBe(first["User-Agent"]);
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
