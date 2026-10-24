import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  getProviderConnections: vi.fn(async () => []),
  updateProviderConnection: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    proxyPoolId: null,
    vercelRelayUrl: "",
  })),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.fetchMock,
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  getProviderConnectionById: mocks.getProviderConnectionById,
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(() => null),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

const { getExecutor } = await import("../../open-sse/executors/index.js");
const { OPENCODE_SESSION_RE } = await import("../../open-sse/executors/opencode.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { getProviderCredentials, markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

const V2_UA = "opencode/latest/2.1.4/cli ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";
const CHAT_MODEL = "deepseek-v4.1-flash-free";
const RESPONSES_MODEL = "muse-spark-1.3-contributor-free";
const MESSAGES_MODEL = "union-alpha";
const ENV_KEYS = [
  "OPENCODE_UA",
  "OPENCODE_CLIENT",
  "OPENCODE_FREE_BASE_URL",
  "OPENCODE_FREE_MAX_INPUT_TOKENS",
];

function chatBody(text = "hello") {
  return { model: CHAT_MODEL, messages: [{ role: "user", content: text }] };
}

async function run(model, body, { rawHeaders = {}, providerSessionId = "conv-1", log } = {}) {
  const executor = getExecutor("opencode");
  return executor.execute({
    model,
    body,
    stream: true,
    credentials: { connectionId: "conn-v2", rawHeaders },
    providerSessionId,
    clientTool: "claude",
    log,
  });
}

function sentHeaders(call = 0) {
  return mocks.fetchMock.mock.calls[call][1].headers;
}

function sentBody(call = 0) {
  return JSON.parse(mocks.fetchMock.mock.calls[call][1].body);
}

beforeEach(() => {
  mocks.fetchMock.mockReset();
  mocks.fetchMock.mockImplementation(async () => new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("OpenCode Free v2.1.4 wire fingerprint", () => {
  it("sends exactly the v2 header set on a free-lane chat request", async () => {
    await run(CHAT_MODEL, chatBody());
    const headers = sentHeaders();
    const session = headers["x-opencode-session"];

    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(Object.keys(headers).sort()).toEqual([
      "Accept",
      "Authorization",
      "Content-Type",
      "User-Agent",
      "X-Session-Id",
      "traceparent",
      "x-opencode-client",
      "x-opencode-project",
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
    ].sort());
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["X-Session-Id"]).toBe(session);
    expect(headers["User-Agent"]).toBe(V2_UA);
    expect(headers["x-opencode-client"]).toBe("cli");
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["Accept"]).toBe("text/event-stream");
  });

  it("never sends x-opencode-request, even when the downstream client forwards one", async () => {
    await run(CHAT_MODEL, chatBody());
    await run(CHAT_MODEL, chatBody(), {
      rawHeaders: { "X-OpenCode-Request": "msg_0ae8d9cd3001swxaFbM248jcIF" },
    });
    for (const call of [0, 1]) {
      const names = Object.keys(sentHeaders(call)).map((k) => k.toLowerCase());
      expect(names).not.toContain("x-opencode-request");
    }
  });

  it("adds a valid W3C traceparent that changes per request", async () => {
    await run(CHAT_MODEL, chatBody());
    await run(CHAT_MODEL, chatBody());
    const first = sentHeaders(0).traceparent;
    const second = sentHeaders(1).traceparent;
    for (const tp of [first, second]) {
      expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(tp.slice(3, 35)).not.toBe("0".repeat(32));
      expect(tp.slice(36, 52)).not.toBe("0".repeat(16));
    }
    expect(second).not.toBe(first);
  });

  it("posts free chat to /inference/openai/v1/chat/completions", async () => {
    const result = await run(CHAT_MODEL, chatBody());
    expect(result.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(mocks.fetchMock.mock.calls[0][0]).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
  });

  it("keeps Responses models on /responses under the same base and Messages models on the anthropic base", () => {
    const executor = getExecutor("opencode");
    expect(executor.buildUrl(RESPONSES_MODEL)).toBe("https://opencode.ai/inference/openai/v1/responses");
    expect(executor.buildUrl(MESSAGES_MODEL)).toBe("https://opencode.ai/inference/anthropic/v1/messages");
  });

  it("honors the OPENCODE_UA, OPENCODE_CLIENT and OPENCODE_FREE_BASE_URL overrides at call time", async () => {
    process.env.OPENCODE_UA = "opencode/latest/2.2.0/cli ai-sdk/provider-utils/4.0.30 runtime/bun/1.5.0";
    process.env.OPENCODE_CLIENT = "desktop";
    process.env.OPENCODE_FREE_BASE_URL = "https://opencode.ai/inference/v1/";
    const result = await run(CHAT_MODEL, chatBody());
    const headers = sentHeaders();

    expect(headers["User-Agent"]).toBe(process.env.OPENCODE_UA);
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(result.url).toBe("https://opencode.ai/inference/v1/chat/completions");

    // a legacy base serves /messages itself, so only the default openai base is remapped
    const executor = getExecutor("opencode");
    expect(executor.buildUrl(MESSAGES_MODEL)).toBe("https://opencode.ai/inference/v1/messages");
    expect(executor.buildUrl(RESPONSES_MODEL)).toBe("https://opencode.ai/inference/v1/responses");

    for (const key of ENV_KEYS) delete process.env[key];
    expect(executor.buildUrl(CHAT_MODEL)).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(executor.buildHeaders({})["User-Agent"]).toBe(V2_UA);
  });
});

describe("OpenCode Free prompt_cache_key", () => {
  it("sets prompt_cache_key to the session id for chat completions", async () => {
    await run(CHAT_MODEL, chatBody());
    const body = sentBody();
    expect(body.prompt_cache_key).toBe(sentHeaders()["x-opencode-session"]);
    expect(body.prompt_cache_key).toMatch(OPENCODE_SESSION_RE);
  });

  it("sets prompt_cache_key on Responses models too", async () => {
    await run(RESPONSES_MODEL, {
      model: RESPONSES_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(sentBody().prompt_cache_key).toBe(sentHeaders()["x-opencode-session"]);
  });

  it("omits prompt_cache_key on Anthropic-format /messages bodies", async () => {
    await run(MESSAGES_MODEL, { model: MESSAGES_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 8 });
    expect(sentBody()).not.toHaveProperty("prompt_cache_key");
  });

  it("strips the ses_ prefix only from the 64-hex session form", () => {
    const executor = getExecutor("opencode");
    const hex64 = "ab".repeat(32);
    const long = executor.transformRequest(CHAT_MODEL, chatBody(), true, { _opencodeSession: `ses_${hex64}` });
    expect(long.prompt_cache_key).toBe(hex64);

    const canonical = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const short = executor.transformRequest(CHAT_MODEL, chatBody(), true, { _opencodeSession: canonical });
    expect(short.prompt_cache_key).toBe(canonical);

    const none = executor.transformRequest(CHAT_MODEL, chatBody(), true, {});
    expect(none).not.toHaveProperty("prompt_cache_key");
  });
});

describe("OpenCode Free session stability and UA passthrough", () => {
  it("keeps one session (and cache key) across the turns of one conversation", async () => {
    const turn1 = chatBody("first question");
    await run(CHAT_MODEL, turn1);
    const turn2 = {
      model: CHAT_MODEL,
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "A long enough assistant answer that anchors the conversation identity, well past fifty chars." },
        { role: "user", content: "second question" },
      ],
    };
    await run(CHAT_MODEL, turn2);

    expect(sentHeaders(1)["x-opencode-session"]).toBe(sentHeaders(0)["x-opencode-session"]);
    expect(sentBody(1).prompt_cache_key).toBe(sentBody(0).prompt_cache_key);
    expect(sentHeaders(1).traceparent).not.toBe(sentHeaders(0).traceparent);
  });

  it("uses a different session for a different conversation", async () => {
    await run(CHAT_MODEL, chatBody(), { providerSessionId: "conv-a" });
    await run(CHAT_MODEL, chatBody(), { providerSessionId: "conv-b" });
    expect(sentHeaders(1)["x-opencode-session"]).not.toBe(sentHeaders(0)["x-opencode-session"]);
  });

  it("forwards a genuine downstream v2 UA, with or without the AI SDK suffix", async () => {
    for (const ua of [
      "opencode/latest/2.1.4/cli",
      "opencode/latest/2.1.4/cli ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4",
      "opencode/dev/2.3.0/desktop ai-sdk/provider-utils/4.1.0 runtime/bun/1.5.2",
    ]) {
      expect(getExecutor("opencode").buildHeaders({ rawHeaders: { "User-Agent": ua } })["User-Agent"]).toBe(ua);
    }
  });

  it("still forwards a full v1 >= 1.18 UA", () => {
    const ua = "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
    expect(getExecutor("opencode").buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe(ua);
  });

  it("replaces lookalike, pre-v2-major or foreign UAs with the default v2 UA", () => {
    for (const ua of [
      "opencode/latest/1.9.0/cli",
      "opencode/latest/2.1/cli",
      "opencode/2.1.4",
      "opencode/1.17.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
      "Claude-Code/1.0",
      "",
    ]) {
      expect(getExecutor("opencode").buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe(V2_UA);
    }
  });
});

describe("OpenCode Free request size guard", () => {
  // JSON length / 4 is the estimator: 300k chars ~ 75k tokens (> 60k default), 100k chars ~ 25k tokens.
  const BIG = "x".repeat(300_000);
  const SMALL = "x".repeat(100_000);

  it("refuses an oversized request locally: zero upstream fetch, 413 with a fallback-shaped message", async () => {
    const log = { warn: vi.fn() };
    const result = await run(CHAT_MODEL, chatBody(BIG), { log });

    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(result.response.status).toBe(413);
    expect(result.response.ok).toBe(false);
    const text = await result.response.text();
    expect(text).toMatch(/request not allowed/i);
    expect(text).toContain("OPENCODE_FREE_MAX_INPUT_TOKENS");
    expect(result.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");

    // the status + text pair must make combos fall back, with the shortest cooldown rule
    const verdict = checkFallbackError(result.response.status, text);
    expect(verdict.shouldFallback).toBe(true);
    expect(verdict.cooldownMs).toBeLessThanOrEqual(5000);
    expect(verdict.newBackoffLevel).toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [tag, line] = log.warn.mock.calls[0];
    expect(tag).toBe("OPENCODE");
    expect(line).toMatch(/~7\d{4} input tokens > 60000/);
  });

  it("falls back to console.warn when no logger is passed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run(CHAT_MODEL, chatBody(BIG));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[OPENCODE\] free lane size guard: ~\d+ input tokens > 60000/);
  });

  it("lets a small request through", async () => {
    const result = await run(CHAT_MODEL, chatBody(SMALL));
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(200);
  });

  it("guards Responses and Messages models the same way", async () => {
    await run(RESPONSES_MODEL, {
      model: RESPONSES_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: BIG }] }],
    });
    await run(MESSAGES_MODEL, { model: MESSAGES_MODEL, messages: [{ role: "user", content: BIG }], max_tokens: 8 });
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("OPENCODE_FREE_MAX_INPUT_TOKENS tunes the limit and 0 disables the guard", async () => {
    process.env.OPENCODE_FREE_MAX_INPUT_TOKENS = "10000";
    const tight = await run(CHAT_MODEL, chatBody(SMALL));
    expect(tight.response.status).toBe(413);
    expect(mocks.fetchMock).not.toHaveBeenCalled();

    process.env.OPENCODE_FREE_MAX_INPUT_TOKENS = "0";
    const off = await run(CHAT_MODEL, chatBody(BIG));
    expect(off.response.status).toBe(200);
    expect(mocks.fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to the 60000 default for an unparsable or negative env value", async () => {
    for (const bad of ["abc", "-5"]) {
      process.env.OPENCODE_FREE_MAX_INPUT_TOKENS = bad;
      const refused = await run(CHAT_MODEL, chatBody(BIG));
      expect(refused.response.status).toBe(413);
      const passed = await run(CHAT_MODEL, chatBody(SMALL));
      expect(passed.response.status).toBe(200);
      mocks.fetchMock.mockClear();
    }
  });
});

describe("OpenCode Free size refusal through chatCore, combo fallback and account locks", () => {
  const virtualCredentials = {
    id: "noauth",
    connectionName: "Public",
    isActive: true,
    accessToken: "public",
    providerSpecificData: {},
  };

  function coreArgs(body) {
    return {
      body: { ...body, model: `opencode/${CHAT_MODEL}` },
      modelInfo: { provider: "opencode", model: CHAT_MODEL },
      credentials: structuredClone(virtualCredentials),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), errorLine: vi.fn() },
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
    };
  }

  it("chatCore reports a 413 error result without touching the network", async () => {
    const result = await handleChatCore(coreArgs(chatBody("x".repeat(300_000))));
    expect(result.success).toBe(false);
    expect(result.status).toBe(413);
    expect(result.error).toMatch(/request not allowed/i);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("a combo moves on to the next entry after the oversized oc request", async () => {
    const body = chatBody("x".repeat(300_000));
    const calls = [];
    const response = await handleComboChat({
      body,
      models: [`opencode/${CHAT_MODEL}`, "other/model-b"],
      comboName: "test-combo",
      comboStrategy: "fallback",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      handleSingleModel: async (b, model) => {
        calls.push(model);
        if (model.startsWith("opencode/")) return (await handleChatCore(coreArgs(b))).response;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    expect(calls).toEqual([`opencode/${CHAT_MODEL}`, "other/model-b"]);
    expect(response.status).toBe(200);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it("the virtual noauth connection is never locked by the refusal", async () => {
    const creds = await getProviderCredentials("opencode", new Set(), CHAT_MODEL);
    expect(creds.id).toBe("noauth");
    expect(creds.connectionId).toBeUndefined();

    const refused = await handleChatCore(coreArgs(chatBody("x".repeat(300_000))));
    const verdict = await markAccountUnavailable(creds.connectionId, refused.status, refused.error, "opencode", CHAT_MODEL);

    expect(verdict).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
    // a later small request is served as usual
    const small = await run(CHAT_MODEL, chatBody("x".repeat(100_000)));
    expect(small.response.status).toBe(200);
  });
});

describe("OpenCode Free dashboard test button", () => {
  it("makes no network call for the free opencode provider", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "oc-free-1",
      provider: "opencode",
      authType: "apikey",
      providerSpecificData: {},
    });
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));

    const result = await testSingleConnection("oc-free-1");

    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });
});
