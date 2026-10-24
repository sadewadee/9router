import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  translateSessionId,
  stableSessionId,
} from "../../open-sse/executors/opencode.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });

  // Upstream validates that the 12-hex prefix is a real timestamp-encoded value
  // (decolua/9router#4780). The real CLI keeps only the low 48 bits of
  // (ms << 12 | counter), so the decoded ms is compared modulo 2^36.
  const MS_MASK = (1n << 36n) - 1n;

  it("encodes a real timestamp in translated session ids and keeps them stable per session", () => {
    const now = Date.now();
    const raw = `ts-session-${now}`;
    const id = translateSessionId(raw, "claude", now);
    expect(id).toMatch(OPENCODE_SESSION_RE);
    const value = BigInt(`0x${id.slice(4, 16)}`);
    expect((~value & 0xffffffffffffn) >> 12n).toBe(BigInt(now) & MS_MASK);
    expect(translateSessionId(raw, "claude", now + 5000)).toBe(id);
    expect(translateSessionId(`${raw}-other`, "claude", now)).not.toBe(id);
  });
});

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(result.headers["x-opencode-session-id"]).toBe(result.headers["x-opencode-session"]);
    expect(result.url).toBe("https://opencode.ai/inference/openai/v1/responses");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("https://opencode.ai/inference/openai/v1/responses");
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session-id"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
    expect(headers["Authorization"]).toBe("Bearer public");
  });

  it("keeps x-opencode-session-id equal to a valid downstream x-opencode-session", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({
        rawHeaders: { "x-opencode-session": valid, "x-opencode-session-id": "ses_0123456789abAAAAAAAAAAAAAA" },
      }),
    });
    const headers = executor.buildHeaders(prepared, true);

    expect(headers["x-opencode-session"]).toBe(valid);
    expect(headers["x-opencode-session-id"]).toBe(valid);
  });

  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  // The default UA is the v2.1.4 CLI shape. A downstream v1 UA is still forwarded only when it is
  // the full >= 1.18 form (/inference 403s a bare "opencode/<ver>" and 426s older than 1.18, live 2026-10-14).
  const FULL_UA = "opencode/latest/2.1.4/cli ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";

  it("defaults User-Agent to the full official opencode UA for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe(FULL_UA);

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe(FULL_UA);
  });

  it("replaces a bare opencode UA with the full official UA to prevent 403 FreeTierError", () => {
    const executor = getExecutor("opencode");
    for (const ua of ["opencode", "opencode/1.19.0", "opencode/1.18.31"]) {
      const headers = executor.buildHeaders({ rawHeaders: { "user-agent": ua } });
      expect(headers["User-Agent"]).toBe(FULL_UA);
    }
  });

  it("upgrades outdated opencode versions (< 1.18) to prevent 426 Upgrade Required", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.17.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14" },
    });
    expect(headers["User-Agent"]).toBe(FULL_UA);
    const old = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(old["User-Agent"]).toBe(FULL_UA);
  });

  it("preserves genuine full official UAs (>= 1.18)", () => {
    const executor = getExecutor("opencode");
    const full118 = "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
    const headers118 = executor.buildHeaders({ rawHeaders: { "user-agent": full118 } });
    expect(headers118["User-Agent"]).toBe(full118);

    const fullFuture = "opencode/1.20.2 ai-sdk/provider-utils/4.1.0 runtime/bun/1.3.20";
    const headersFuture = executor.buildHeaders({ rawHeaders: { "user-agent": fullFuture } });
    expect(headersFuture["User-Agent"]).toBe(fullFuture);
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("cloaks free-tier requests with the OpenCode quartet decoy tools", () => {
    const executor = getExecutor("opencode");
    const QUARTET = ["bash", "glob", "grep", "read"];

    // Case 1: no tools sent by client -> injects the quartet; tool_choice "auto"
    // because the /inference gate 403s tool_choice "none".
    const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(chatNoTools.stream).toBe(true);
    expect(chatNoTools.tool_choice).toBe("auto");
    expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual(QUARTET);

    // Case 2: external CLI tools (e.g. Claude Code Bash) -> preserves Bash, appends the quartet
    const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "Bash", description: "Claude Code tool" } }],
      tool_choice: "auto",
    });
    expect(chatWithTools.tool_choice).toBe("auto");
    const names = chatWithTools.tools.map((t) => t.function?.name);
    expect(names).toContain("Bash");
    for (const n of QUARTET) expect(names).toContain(n);

    // Case 3: a caller's own lowercase tool that is not OpenCode's would duplicate the
    // quartet name (403) -> moved aside under an alias, decoy takes the slot.
    const credentials = {};
    const chatFull = executor.transformRequest("nemotron-3-ultra-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "bash", description: "existing" } },
        { type: "function", function: { name: "read", description: "existing" } },
      ],
    }, true, credentials);
    const fullNames = chatFull.tools.map((t) => t.function?.name);
    expect(fullNames).toEqual(["bash_ext", "read_ext", "bash", "glob", "grep", "read"]);
    expect(chatFull.tools[0].function.description).toBe("existing");
    expect(credentials._opencodeToolNameMap.get("bash_ext")).toBe("bash");
    expect(credentials._opencodeToolNameMap.get("read_ext")).toBe("read");
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
