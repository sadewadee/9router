import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

// Mock proxyAwareFetch so no test ever reaches the network.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  FreebuffExecutor,
  probeFreebuffToken,
  __test__,
} from "../../open-sse/executors/freebuff.js";
import { generateDeviceKeyRecord, buildStringToSign, b64urlDecode, isDeviceKeyError } from "../../open-sse/utils/freebuffDeviceKey.js";
import {
  parseCatalog,
  visibleRows,
  catalogTtlMs,
  resolveAdmissionModel,
  resolveCatalogKey,
  freebuffHandleFor,
  invalidateFreebuffCatalog,
} from "../../open-sse/utils/freebuffCatalog.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getDefaultModel } from "../../open-sse/config/providerModels.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import freebuffRegistry from "../../open-sse/providers/registry/freebuff.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FREE_PROVIDERS, AI_PROVIDERS } from "../../src/shared/constants/providers.js";

const {
  ensureRootOpening,
  buildChatBody,
  buildToolNotice,
  normalizeToolSchemas,
  wrapStreamWithCleanup,
  directEgressOptions,
  generateClientId,
  clientEnv,
  clearSessionCache,
  clearRunCache,
  clearDeviceKeyCache,
  clearIdleTimers,
  runRotationMs,
  sessionIdleMs,
  sessions,
  activeRuns,
  drainingRuns,
  warnedRelays,
  ROOT_SYSTEM_PROMPT,
  FREEBUFF_ROOT_OPENING,
  DEFAULT_MODEL,
  FREEBUFF_AGENT_ID_BY_MODEL,
  chatUserAgent,
  sessionUserAgent,
  cliVersion,
  aiSdkVersion,
  sessionUrlFor,
  gateRetryKind,
  setFreebuffDeviceKeyPersister,
  sessionKey,
  tokenOf,
  buildDesktopSessionHeaders,
  buildCloudSubmission,
  promptFromMessages,
  cloudChunkText,
  resolveExecMode,
  installIdFor,
  desktopVersion,
  desktopUserAgent,
  DEFAULT_CLI_VERSION,
  DEFAULT_AISDK_VERSION,
  DEFAULT_DESKTOP_VERSION,
  DEFAULT_SESSION_IDLE_MS,
  DEFAULT_RUN_ROTATION_MS,
  CHAT_URL,
  AGENT_RUNS_URL,
  SESSION_URL,
  SESSION_ADMISSION_URL,
  SESSION_ATTEMPT_URL,
  CLOUD_RUNS_URL,
  DEVICE_KEYS_URL,
  CATALOG_URL,
  HEADER_GZIP_RECOVERY,
} = __test__;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(chunks) {
  const parts = chunks || ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

let tokenCounter = 0;
function newToken() {
  tokenCounter += 1;
  return `fb-test-token-${tokenCounter}`;
}

function parseCall([url, init, opts]) {
  let body = null;
  if (init?.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  return { url, method: init?.method || "GET", headers: init?.headers || {}, body, opts };
}

const allCalls = () => fetchMock.mock.calls.map(parseCall);
const callsTo = (url, method) => allCalls().filter((c) => c.url === url && (!method || c.method === method));
const agentRunCalls = (action) => callsTo(AGENT_RUNS_URL, "POST").filter((c) => c.body?.action === action);
const releaseCalls = () => callsTo(SESSION_URL, "DELETE");
const sha256Hex = (text) => createHash("sha256").update(text ?? "").digest("hex");
const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;

// The device-key record every executor test signs with: generated once and seeded into the
// credentials, so the raw public key is available for signature verification.
const testRecord = await generateDeviceKeyRecord(subtle);

// Default upstream: device-keys hands out one keyId, the catalog serves two rows (mimo free +
// a locked one), admission assigns server-side instance ids, START hands out sequential run ids,
// FINISH is acknowledged, chat streams a tiny SSE body. Per-test overrides replace endpoints.
function installUpstream(overrides = {}) {
  let runSeq = 0;
  let instanceSeq = 0;
  const catalogBody = {
    protocol: 1,
    version: "2026-10-27.1",
    issuedAt: Date.now(),
    refreshAt: Date.now() + 5 * 60_000,
    // Live shape: opaque "m-<10hex>" keys with "fbm1..." handles, plus the legacy ids the router
    // still accepts as aliases.
    rows: [
      { key: "m-00032eaeec", handle: "fbm1.AAEmimoKey", displayName: "MiMo Free (live key)", tagline: "", badges: [], multimodal: false, premium: false, dataUse: "service", access: "open", sortOrder: 1 },
      { key: "mimo/mimo-v2.5", handle: "fbm1.AAEmimoAlias", displayName: "MiMo Free", tagline: "", badges: [], multimodal: false, premium: false, dataUse: "service", access: "open", sortOrder: 2 },
      { key: "z-ai/glm-5.3-flash", handle: "fbm1.AAEglmAlias", displayName: "GLM 5.3 Flash", tagline: "", badges: [], multimodal: false, premium: false, dataUse: "service", access: "open", sortOrder: 3 },
      { key: "upstage/solar-pro4", handle: "fbm1.AAEsolar", displayName: "Solar Pro", tagline: "", badges: [], multimodal: true, premium: true, dataUse: "training", access: "locked", sortOrder: 4 },
    ],
    plansUrl: "https://www.codebuff.com/plans",
    fetchId: "fetch-test-1",
  };
  const handlers = {
    deviceKeys: () => json({ keyId: "key-test-1" }),
    catalog: () => json(catalogBody),
    admission: (headers) => {
      const sent = headers["x-freebuff-model"];
      // The live server normalises the admitted opaque handle back to the catalog row key.
      const row = catalogBody.rows.find((candidate) => candidate.handle === sent);
      return json({
        status: "active",
        instanceId: `srv-${++instanceSeq}`,
        model: row ? row.key : sent,
        remainingMs: 600_000,
      });
    },
    session: () => json({ status: "none" }),
    start: () => json({ runId: `run-${++runSeq}` }),
    finish: () => json({}),
    release: () => json({ status: "ended" }),
    chat: () => sse(),
    cloudRunPost: () => json({ runId: "cloud-run-1", status: "queued" }),
    cloudRunGet: () =>
      json({
        status: "completed",
        events: [
          { id: "e1", kind: "chunk", payload: { text: "he" } },
          { id: "e2", kind: "chunk", payload: { text: "y" } },
          { id: "e3", kind: "event", payload: { type: "finish" } },
        ],
      }),
    cloudCancel: () => json({}),
    ...overrides,
  };
  fetchMock.mockImplementation(async (url, init) => {
    const headers = init?.headers || {};
    const body = init?.body ? JSON.parse(init.body) : null;
    // Registrations happen per origin (freebuff.com and www.codebuff.com scopes).
    if (String(url).endsWith("/api/v1/freebuff/device-keys")) return handlers.deviceKeys(headers, body);
    if (url === CATALOG_URL) return handlers.catalog(headers);
    if (url === SESSION_ADMISSION_URL) return handlers.admission(headers, body);
    if (url === SESSION_URL) return init?.method === "DELETE" ? handlers.release(headers, init?.method) : handlers.session(headers, init?.method);
    if (url === SESSION_ATTEMPT_URL) return handlers.release(headers, init?.method);
    if (url === AGENT_RUNS_URL) return body?.action === "FINISH" ? handlers.finish(body) : handlers.start(body);
    if (url === CHAT_URL) return handlers.chat(body, headers);
    if (url === CLOUD_RUNS_URL) return handlers.cloudRunPost(headers, body);
    if (String(url).startsWith(`${CLOUD_RUNS_URL}/`)) {
      if (init?.method === "POST") return handlers.cloudCancel();
      return handlers.cloudRunGet(String(url));
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  return { catalogBody };
}

// Catalog whose rows are keyed like production ("m-<10hex>"); deepseek/deepseek-v4-flash is
// m-096e75164d (freebuffHandleFor). Admission normalises the sent handle back to the row key.
const DEEPSEEK_ID = "deepseek/deepseek-v4-flash";
const DEEPSEEK_KEY = "m-096e75164d";
const DEEPSEEK_HANDLE = "fbm1.AAEdeepseek";
function keyedCatalogOverrides() {
  const rows = [
    { key: "m-00032eaeec", handle: "fbm1.AAEmimoKey", displayName: "MiMo Free", access: "open", sortOrder: 1 },
    { key: DEEPSEEK_KEY, handle: DEEPSEEK_HANDLE, displayName: "DeepSeek V4 Flash", access: "open", sortOrder: 2 },
  ];
  let instanceSeq = 0;
  return {
    catalog: () => json({ protocol: 1, version: "t", issuedAt: Date.now(), refreshAt: Date.now() + 5 * 60_000, rows, fetchId: "fetch-test-1" }),
    admission: (headers) => {
      const row = rows.find((candidate) => candidate.handle === headers["x-freebuff-model"]);
      return json({ status: "active", instanceId: `srv-k${++instanceSeq}`, model: row ? row.key : headers["x-freebuff-model"], remainingMs: 600_000 });
    },
  };
}

async function drain(response) {
  return await response.text();
}

// Verify a captured device-key signature against the test record's raw public key.
async function verifyDeviceSig({ url, method = "GET", headers, body, fetchId = "" }, record = testRecord) {
  const keyId = headers["x-freebuff-device-key"];
  const ts = headers["x-freebuff-device-ts"];
  const sig = headers["x-freebuff-device-sig"];
  if (!keyId || !ts || !sig) return false;
  const stringToSign = buildStringToSign({
    method,
    path: new URL(url).pathname,
    timestampMs: Number(ts),
    bodySha256: sha256Hex(typeof body === "string" ? body : ""),
    fetchId,
  });
  const pubKey = await subtle.importKey("raw", b64urlDecode(record.publicKey), { name: "Ed25519" }, false, ["verify"]);
  return await subtle.verify({ name: "Ed25519" }, pubKey, b64urlDecode(sig), new TextEncoder().encode(stringToSign));
}

function makeExecuteArgs(overrides = {}) {
  return {
    model: "mimo/mimo-v2.5",
    body: { model: "cb/mimo/mimo-v2.5", messages: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } },
    signal: undefined,
    log: undefined,
    proxyOptions: null,
    ...overrides,
  };
}

const executor = new FreebuffExecutor();

// The handshake/lifecycle tests assert one START and one FINISH per request, which is the legacy mode
// (FREEBUFF_RUN_ROTATION_MS=0). The default run reuse has its own section further down.
let originalFetch = null;

beforeEach(() => {
  // Belt and braces: nothing in these tests may reach the network, not even code that uses the
  // global fetch (the oauth provider does) instead of proxyAwareFetch.
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  clearSessionCache();
  clearRunCache();
  clearDeviceKeyCache();
  clearIdleTimers();
  invalidateFreebuffCatalog();
  warnedRelays.clear();
  setFreebuffDeviceKeyPersister(null);
  delete process.env.FREEBUFF_FOLD_TOOLS;
  delete process.env.FREEBUFF_USER_AGENT;
  delete process.env.FREEBUFF_COST_MODE;
  delete process.env.FREEBUFF_CLIENT_ENV;
  delete process.env.FREEBUFF_SESSION_IDLE_MS;
  delete process.env.FREEBUFF_CATALOG_TTL_MS;
  delete process.env.FREEBUFF_CLI_VERSION;
  delete process.env.FREEBUFF_AISDK_VERSION;
  delete process.env.FREEBUFF_EXEC_MODE;
  delete process.env.FREEBUFF_DESKTOP_VERSION;
  delete process.env.FREEBUFF_CLOUD_POLL_MS;
  delete process.env.FREEBUFF_CLOUD_RUN_TIMEOUT_MS;
  process.env.FREEBUFF_RUN_ROTATION_MS = "0";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.FREEBUFF_FOLD_TOOLS;
  delete process.env.FREEBUFF_USER_AGENT;
  delete process.env.FREEBUFF_COST_MODE;
  delete process.env.FREEBUFF_CLIENT_ENV;
  delete process.env.FREEBUFF_SESSION_IDLE_MS;
  delete process.env.FREEBUFF_CATALOG_TTL_MS;
  delete process.env.FREEBUFF_CLI_VERSION;
  delete process.env.FREEBUFF_AISDK_VERSION;
  delete process.env.FREEBUFF_EXEC_MODE;
  delete process.env.FREEBUFF_DESKTOP_VERSION;
  delete process.env.FREEBUFF_CLOUD_POLL_MS;
  delete process.env.FREEBUFF_CLOUD_RUN_TIMEOUT_MS;
  delete process.env.FREEBUFF_RUN_ROTATION_MS;
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("declares the free provider with oauth + apikey modes and both aliases", () => {
    expect(freebuffRegistry.id).toBe("freebuff");
    expect(freebuffRegistry.alias).toBe("cb");
    expect(freebuffRegistry.aliases).toContain("codebuff");
    expect(freebuffRegistry.category).toBe("free");
    expect(freebuffRegistry.hasFree).toBe(true);
    expect(freebuffRegistry.hasOAuth).toBe(true);
    expect(freebuffRegistry.authModes).toEqual(["oauth", "apikey"]);
  });

  it("was added to the registry without clobbering another entry", () => {
    const ids = REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("freebuff");
    expect(new Set(ids).size).toBe(ids.length);

    // A duplicate `import pNN` is a SyntaxError in real ESM even though the test transform tolerates it.
    const source = readFileSync(fileURLToPath(new URL("../../open-sse/providers/registry/index.js", import.meta.url)), "utf8");
    const names = [...source.matchAll(/^import (p\d+) from /gm)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is listed among the free providers with its auth modes", () => {
    expect(FREE_PROVIDERS.freebuff).toBeTruthy();
    expect(FREE_PROVIDERS.freebuff.hasFree).toBe(true);
    expect(AI_PROVIDERS.freebuff.alias).toBe("cb");
  });

  it("resolves every alias to the freebuff provider, keeping slashes inside model ids", () => {
    expect(resolveProviderAlias("cb")).toBe("freebuff");
    expect(resolveProviderAlias("codebuff")).toBe("freebuff");
    expect(parseModel("cb/z-ai/glm-5.3-flash")).toMatchObject({ provider: "freebuff", model: "z-ai/glm-5.3-flash" });
    expect(parseModel("codebuff/mimo/mimo-v2.5")).toMatchObject({ provider: "freebuff", model: "mimo/mimo-v2.5" });
  });

  it("registers the executor under freebuff, cb and codebuff", async () => {
    // Imported lazily: the executor index pulls in every provider executor (and their root
    // dependencies), which would otherwise take the whole file down in a bare environment.
    const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");
    for (const key of ["freebuff", "cb", "codebuff"]) expect(hasSpecializedExecutor(key)).toBe(true);
    expect(getExecutor("freebuff")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("cb")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("codebuff")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("freebuff").getProvider()).toBe("freebuff");
  });

  it("uses the chat completions endpoint as base URL and puts every API call on www.codebuff.com", () => {
    expect(PROVIDERS.freebuff.baseUrl).toBe("https://www.codebuff.com/api/v1/chat/completions");
    expect(executor.buildUrl()).toBe(CHAT_URL);
    expect(PROVIDER_ID_TO_ALIAS.freebuff).toBe("cb");
    // Live-verified: freebuff.com is the landing page only; its API answers 404 HTML.
    expect(DEVICE_KEYS_URL).toBe("https://www.codebuff.com/api/v1/freebuff/device-keys");
    expect(CATALOG_URL).toBe("https://www.codebuff.com/api/v1/freebuff/models");
    expect(SESSION_ADMISSION_URL).toBe("https://www.codebuff.com/api/v1/freebuff/session/admission");
  });

  it("leads the model list with the upstream fallback model", () => {
    expect(getDefaultModel("cb")).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("mimo/mimo-v2.5");
    expect(PROVIDER_MODELS.cb[0].id).toBe("mimo/mimo-v2.5");
  });

  it("only lists models that have a free-mode root agent id", () => {
    const listed = PROVIDER_MODELS.cb.map((m) => m.id);
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) expect(FREEBUFF_AGENT_ID_BY_MODEL[id]).toMatch(/^base2-free-/);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("maps every model to a base2 agent id (0.2.35 set)", () => {
    const ids = Object.values(FREEBUFF_AGENT_ID_BY_MODEL);
    expect(new Set(ids).size).toBe(29);
    expect(FREEBUFF_AGENT_ID_BY_MODEL["mimo/mimo-v2.5"]).toBe("base2-free-mimo");
    expect(FREEBUFF_AGENT_ID_BY_MODEL["z-ai/glm-5.3-flash"]).toBe("base2-free-glm-5-3-flash");
    expect(FREEBUFF_AGENT_ID_BY_MODEL["deepseek/deepseek-v4-flash-fast"]).toBe("base2-free-deepseek-flash-fast");
    expect(FREEBUFF_AGENT_ID_BY_MODEL["deepseek/deepseek-v4.1-flash"]).toBe("base2-free-deepseek-v4-1-flash");
    expect(FREEBUFF_AGENT_ID_BY_MODEL["openai/gpt-6.1-sol"]).toBe("base2-free-gpt-6-1-sol");
  });
});

// ---------------------------------------------------------------------------
// user agents, versions and the client-env fingerprint
// ---------------------------------------------------------------------------

describe("user agents and versions", () => {
  it("chat UA is ai-sdk style, session UA is the CLI style", () => {
    expect(chatUserAgent()).toBe(`ai-sdk/openai-compatible/${DEFAULT_AISDK_VERSION}/codebuff`);
    expect(sessionUserAgent()).toBe(`Freebuff-CLI/${DEFAULT_CLI_VERSION}`);
    expect(DEFAULT_AISDK_VERSION).toBe("0.0.0-test"); // verbatim from the 0.2.34 linux-x64 binary
    expect(DEFAULT_CLI_VERSION).toBe("0.2.34");
  });

  it("env overrides both versions (read at request time)", () => {
    process.env.FREEBUFF_AISDK_VERSION = "9.9.9";
    process.env.FREEBUFF_CLI_VERSION = "1.2.3";
    expect(chatUserAgent()).toBe("ai-sdk/openai-compatible/9.9.9/codebuff");
    expect(sessionUserAgent()).toBe("Freebuff-CLI/1.2.3");
  });

  it("FREEBUFF_USER_AGENT still overrides the whole chat UA", () => {
    process.env.FREEBUFF_USER_AGENT = "Freebuff-CLI/0.0.200";
    expect(chatUserAgent()).toBe("Freebuff-CLI/0.0.200");
    expect(sessionUserAgent()).toBe("Freebuff-CLI/0.2.34");
  });
});

describe("client env fingerprint", () => {
  it("is a v1;... string in the CLI field shape", () => {
    expect(clientEnv()).toMatch(
      /^v1;in=[01];out=[01];tp=\w+;term=[01];ct=[01];sz=\d+x\d+;ci=[01];ssh=[01];l=\w+;p=\w+;g=\w+;osc=\w+;tzo=[01];px=[01];tls=[01];ca=[01];cde=[01]/,
    );
  });

  it("FREEBUFF_CLIENT_ENV overrides it entirely", () => {
    process.env.FREEBUFF_CLIENT_ENV = "v1;in=0;out=0;err=1";
    expect(clientEnv()).toBe("v1;in=0;out=0;err=1");
  });
});

// ---------------------------------------------------------------------------
// root system prompt opening
// ---------------------------------------------------------------------------

describe("root system prompt opening", () => {
  it("uses the byte-exact base2 opening", () => {
    expect(FREEBUFF_ROOT_OPENING).toBe("You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free.");
  });

  it("injects its own leading system message and leaves the caller's system text untouched", () => {
    const body = buildChatBody(
      { messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hi" }] },
      { model: "mimo/mimo-v2.5", runId: "r1" },
    );
    expect(body.messages[0]).toEqual({ role: "system", content: ROOT_SYSTEM_PROMPT });
    expect(body.messages[1]).toEqual({ role: "system", content: "be terse" });
    expect(body.messages[2]).toEqual({ role: "user", content: "hi" });
  });

  it("adds the opening when the conversation has no system message at all", () => {
    const body = buildChatBody({ messages: [{ role: "user", content: "hi" }] }, { model: "mimo/mimo-v2.5", runId: "r1" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content.startsWith(FREEBUFF_ROOT_OPENING)).toBe(true);
  });

  it("keeps a first system message that already opens correctly (leading whitespace tolerated)", () => {
    const messages = [{ role: "system", content: `  ${FREEBUFF_ROOT_OPENING} custom tail` }, { role: "user", content: "hi" }];
    expect(ensureRootOpening(messages)).toBe(messages);
  });

  it("recognises the opening inside content-part arrays", () => {
    const messages = [{ role: "system", content: [{ type: "text", text: `${FREEBUFF_ROOT_OPENING} tail` }] }];
    expect(ensureRootOpening(messages)).toBe(messages);
  });

  it("does not accept the marker anywhere but at the start", () => {
    const messages = [{ role: "system", content: `prefix ${FREEBUFF_ROOT_OPENING}` }];
    expect(ensureRootOpening(messages)[0].content).toBe(ROOT_SYSTEM_PROMPT);
  });

  it("tolerates a missing messages array", () => {
    expect(ensureRootOpening(undefined)[0].role).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// buildChatBody (CLI 0.2.34 shape)
// ---------------------------------------------------------------------------

describe("buildChatBody", () => {
  it("adds codebuff_metadata with run id, 13-char client id, client env, and no cost_mode by default", () => {
    const body = buildChatBody({ messages: [] }, { model: "mimo/mimo-v2.5", runId: "run-1", instanceId: "srv-1" });
    const meta = body.codebuff_metadata;
    expect(meta.run_id).toBe("run-1");
    expect(meta.client_id).toMatch(/^[a-z0-9]{13}$/);
    expect(meta.freebuff_instance_id).toBe("srv-1");
    expect(meta.freebuff_client_env).toBe(clientEnv());
    expect(meta.cost_mode).toBeUndefined(); // CLI normal mode omits the field
    expect(Object.keys(meta)).toEqual(["freebuff_instance_id", "freebuff_client_env", "run_id", "client_id"]);
  });

  it("marks multi-session only for client-minted cli: claims (RZA)", () => {
    const claim = buildChatBody({ messages: [] }, { model: "m", runId: "r", instanceId: "cli:abcd-1" });
    expect(claim.codebuff_metadata.freebuff_multi_session).toBe("1");
    expect(claim.codebuff_metadata.surface).toBe("cli");

    const assigned = buildChatBody({ messages: [] }, { model: "m", runId: "r", instanceId: "srv-77" });
    expect(assigned.codebuff_metadata.freebuff_multi_session).toBeUndefined();
    expect(assigned.codebuff_metadata.surface).toBeUndefined();
  });

  it("omits the instance id fields when the waiting room is off", () => {
    const body = buildChatBody({ messages: [] }, { model: "m", runId: "r", instanceId: "" });
    expect(body.codebuff_metadata.freebuff_instance_id).toBeUndefined();
  });

  it("copies a reasoning effort into freebuff_reasoning_effort", () => {
    const body = buildChatBody({ messages: [], reasoning_effort: "high" }, { model: "m", runId: "r", reasoningEffort: "high" });
    expect(body.codebuff_metadata.freebuff_reasoning_effort).toBe("high");
    const plain = buildChatBody({ messages: [], reasoning_effort: "high" }, { model: "m", runId: "r" });
    expect(plain.codebuff_metadata.freebuff_reasoning_effort).toBeUndefined();
  });

  it("sends cost_mode only when asked, never hardcoded", () => {
    expect(buildChatBody({ messages: [] }, { model: "m", runId: "r" }).codebuff_metadata.cost_mode).toBeUndefined();
    const body = buildChatBody({ messages: [] }, { model: "m", runId: "r", costMode: "normal" });
    expect(body.codebuff_metadata.cost_mode).toBe("normal");
    process.env.FREEBUFF_COST_MODE = "free";
    expect(buildChatBody({ messages: [] }, { model: "m", runId: "r" }).codebuff_metadata.cost_mode).toBe("free");
  });

  it("spreads provider routing as {order:null, allow_fallbacks:true}", () => {
    expect(buildChatBody({ messages: [] }, { model: "m", runId: "r" }).provider).toEqual({ order: null, allow_fallbacks: true });
  });

  it("sets stream_options include_usage when streaming and plain stream:false otherwise", () => {
    const stream = buildChatBody({ messages: [] }, { model: "m", runId: "r", stream: true });
    expect(stream.stream).toBe(true);
    expect(stream.stream_options).toEqual({ include_usage: true });
    const noStream = buildChatBody({ messages: [] }, { model: "m", runId: "r", stream: false });
    expect(noStream.stream).toBe(false);
    expect(noStream.stream_options).toBeUndefined();
  });

  it("never lets the caller override the handshake fields", () => {
    const body = buildChatBody(
      {
        messages: [{ role: "user", content: "hi" }],
        model: "caller-model",
        codebuff_metadata: { run_id: "hacked" },
        provider: { order: ["x"] },
      },
      { model: "mimo/mimo-v2.5", runId: "r1" },
    );
    expect(body.model).toBe("mimo/mimo-v2.5");
    expect(body.codebuff_metadata.run_id).toBe("r1");
    expect(body.codebuff_metadata.client_id).not.toBe("hacked");
    expect(body.provider).toEqual({ order: null, allow_fallbacks: true });
  });

  it("honours a caller-provided stream_options", () => {
    const body = buildChatBody({ messages: [], stream_options: { include_usage: true, extra: 1 } }, { model: "m", runId: "r" });
    expect(body.stream_options).toEqual({ include_usage: true, extra: 1 });
  });

  it("maps max_completion_tokens to max_tokens", () => {
    const body = buildChatBody({ messages: [], max_completion_tokens: 77 }, { model: "m", runId: "r" });
    expect(body.max_tokens).toBe(77);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("generates fresh base36 client ids", () => {
    const seen = new Set(Array.from({ length: 40 }, () => generateClientId()));
    expect(seen.size).toBe(40);
    for (const id of seen) expect(id).toMatch(/^[0-9a-z]{13}$/);
  });
});

// ---------------------------------------------------------------------------
// tools handling
// ---------------------------------------------------------------------------

describe("tools handling", () => {
  const tool = { type: "function", function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } } };

  it("passes tools and tool_choice through by default", () => {
    const body = buildChatBody({ messages: [], tools: [tool], tool_choice: "auto" }, { model: "m", runId: "r" });
    expect(body.tools).toEqual([tool]);
    expect(body.tool_choice).toBe("auto");
  });

  it("folds tools into a system message when FREEBUFF_FOLD_TOOLS=1 (read at request time)", () => {
    process.env.FREEBUFF_FOLD_TOOLS = "1";
    const body = buildChatBody({ messages: [{ role: "user", content: "hi" }], tools: [tool] }, { model: "m", runId: "r" });
    expect(body.tools).toBeUndefined();
    expect(body.messages[1].role).toBe("system");
    expect(body.messages[1].content).toContain("get_weather");
  });

  it("does not treat FREEBUFF_FOLD_TOOLS=0 as enabled", () => {
    process.env.FREEBUFF_FOLD_TOOLS = "0";
    const body = buildChatBody({ messages: [], tools: [tool] }, { model: "m", runId: "r" });
    expect(body.tools).toEqual([tool]);
  });

  it("builds an empty notice for tools without names", () => {
    expect(buildToolNotice([{ function: {} }])).toBe("");
  });

  it("returns schemas without $ref/null constructs unchanged (same object)", () => {
    const tools = [{ function: { name: "t", parameters: { type: "object", properties: { a: { type: "string" } } } } }];
    const out = normalizeToolSchemas(tools);
    expect(out).toEqual(tools);
    expect(out[0]).toBe(tools[0]); // untouched tools keep their identity
  });

  it("collapses nullable anyOf/type arrays and inlines local $ref", () => {
    const params = {
      type: "object",
      definitions: { name: { type: "string" } },
      properties: {
        who: { $ref: "#/definitions/name" },
        age: { anyOf: [{ type: "integer" }, { type: "null" }] },
        maybe: { type: ["string", "null"] },
      },
    };
    const [out] = normalizeToolSchemas([{ function: { name: "t", parameters: params } }]);
    expect(out.function.parameters.properties.who).toEqual({ type: "string" });
    expect(out.function.parameters.properties.age).toEqual({ type: "integer" });
    expect(out.function.parameters.properties.maybe).toEqual({ type: "string" });
  });
});

// ---------------------------------------------------------------------------
// execute: signed handshake (device keys, catalog, admission, chat)
// ---------------------------------------------------------------------------

describe("execute: signed handshake", () => {
  it("registers the device key on the api origin, then catalogs, admits, starts and chats (in order)", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(200);

    const order = allCalls().map((c) => c.url);
    expect(order).toEqual([
      DEVICE_KEYS_URL, // every endpoint lives on www.codebuff.com (live-verified)
      CATALOG_URL,
      SESSION_ADMISSION_URL,
      AGENT_RUNS_URL,
      CHAT_URL,
    ]);

    for (const register of callsTo(DEVICE_KEYS_URL, "POST")) {
      expect(register.url).toBe("https://www.codebuff.com/api/v1/freebuff/device-keys");
      expect(register.headers.Authorization).toMatch(/^Bearer fb-test-token-/);
      expect(register.body.publicKey).toBe(testRecord.publicKey);
      expect(register.body.client).toBe("cli");
    }
  });

  it("signs the catalog GET with protocol and client headers", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs());
    const catalog = callsTo(CATALOG_URL, "GET")[0];
    expect(catalog.headers["x-freebuff-catalog-protocol"]).toBe("1");
    expect(catalog.headers["x-freebuff-client"]).toBe("cli");
    expect(await verifyDeviceSig({ url: CATALOG_URL, headers: catalog.headers })).toBe(true);
  });

  it("signs the admission and sends the CLI 0.2.34 admission headers", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs());
    const admission = callsTo(SESSION_ADMISSION_URL, "POST")[0];
    expect(admission.headers["User-Agent"]).toBe(sessionUserAgent());
    expect(admission.headers["x-freebuff-client-version"]).toBe(cliVersion());
    expect(admission.headers["x-fb-timezone"]).toBeTruthy();
    expect(admission.headers["x-freebuff-env"]).toBe(clientEnv());
    expect(admission.headers["x-freebuff-model"]).toBe("fbm1.AAEmimoAlias"); // live catalog row handle (bisect 2026-10-27: handle 200, key 409)
    expect(admission.headers["x-freebuff-wallet-spend-limit"]).toBe("session");
    expect(admission.headers["x-freebuff-catalog-fetch"]).toBe("fetch-test-1");
    expect(admission.headers["x-freebuff-catalog-protocol"]).toBe("1");
    // Absent legacy markers:
    expect(admission.headers["x-freebuff-instance-id"]).toBeUndefined(); // the server assigns the id
    expect(admission.headers["x-freebuff-first-tab-discount"]).toBeUndefined();
    expect(admission.headers["x-freebuff-desktop-attempt-id"]).toBeUndefined();
    expect(admission.headers["x-freebuff-multi-session"]).toBeUndefined();
    expect(admission.headers["x-freebuff-client"]).toBeUndefined(); // the CLI sends no client header here
    expect(await verifyDeviceSig({ url: SESSION_ADMISSION_URL, method: "POST", headers: admission.headers, fetchId: "fetch-test-1" })).toBe(true);
  });

  it("sends the CLI 0.2.34 chat headers and signs the exact body", async () => {
    installUpstream();
    const args = makeExecuteArgs({
      credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord, userId: "user-42" } },
    });
    const result = await executor.execute(args);
    expect(await drain(result.response)).toContain("hi");

    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.headers["User-Agent"]).toBe(chatUserAgent());
    expect(chat.headers[HEADER_GZIP_RECOVERY]).toBe("1");
    expect(chat.headers["x-freebuff-acting-user-id"]).toBe("user-42");
    expect(chat.headers["x-freebuff-catalog-fetch"]).toBe("fetch-test-1");
    expect(chat.headers.Accept).toBe("text/event-stream");
    expect(await verifyDeviceSig({ url: CHAT_URL, method: "POST", headers: chat.headers, body: JSON.stringify(chat.body), fetchId: "fetch-test-1" })).toBe(true);

    // Body shape of a CLI 0.2.34 chat.
    expect(chat.body.model).toBe("mimo/mimo-v2.5");
    expect(chat.body.stream).toBe(true);
    expect(chat.body.stream_options).toEqual({ include_usage: true });
    expect(chat.body.provider).toEqual({ order: null, allow_fallbacks: true });
    expect(chat.body.messages[0].content.startsWith(FREEBUFF_ROOT_OPENING)).toBe(true);
    expect(chat.body.codebuff_metadata.run_id).toMatch(/^run-\d+$/);
    expect(chat.body.codebuff_metadata.freebuff_instance_id).toMatch(/^srv-\d+$/);
    expect(chat.body.codebuff_metadata.surface).toBeUndefined(); // server-assigned id, no cli: claim
  });

  it("admits with the catalog row handle while the chat body keeps the row key", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs());
    await drain(result.response);
    const admission = callsTo(SESSION_ADMISSION_URL, "POST")[0];
    const chat = callsTo(CHAT_URL, "POST")[0];
    // Live bisect 2026-10-27: the admission header must be the opaque "fbm1..." handle or the
    // server answers 409 freebuff_catalog_stale; the chat body model stays the row key.
    expect(admission.headers["x-freebuff-model"]).toBe("fbm1.AAEmimoAlias");
    expect(admission.headers["x-freebuff-model"]).not.toBe("mimo/mimo-v2.5");
    expect(chat.body.model).toBe("mimo/mimo-v2.5");
  });

  it("starts and finishes an agent run around the chat (rotation disabled)", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs());
    await drain(result.response);
    expect(agentRunCalls("START")).toHaveLength(1);
    expect(agentRunCalls("FINISH")).toHaveLength(1);
    const start = agentRunCalls("START")[0];
    expect(start.body).toEqual({ action: "START", agentId: "base2-free-mimo", ancestorRunIds: [] });
    expect(start.headers["User-Agent"]).toBe(sessionUserAgent());
  });

  it("answers a clean 502 invalid_model for a model the catalog does not list (no admission attempt)", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ model: "cb/who/dis" }));
    expect(result.response.status).toBe(502);
    const body = await result.response.json();
    expect(body.error.code).toBe("invalid_model");
    // Only the registration and the catalog ran; the admission was never attempted.
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(0);
    expect(callsTo(CATALOG_URL, "GET")).toHaveLength(1);
  });

  it("routes a live catalog key with the base2-free root agent", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ model: "m-00032eaeec" }));
    expect(result.response.status).toBe(200);
    await drain(result.response);
    const start = agentRunCalls("START")[0];
    expect(start.body.agentId).toBe("base2-free-mimo");
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.body.model).toBe("m-00032eaeec");
    expect(chat.body.codebuff_metadata.freebuff_instance_id).toMatch(/^srv-\d+$/);
  });

  it("translates a human model id to its catalog key before admission and chat", async () => {
    installUpstream(keyedCatalogOverrides());
    const result = await executor.execute(makeExecuteArgs({ model: `cb/${DEEPSEEK_ID}` }));
    expect(result.response.status).toBe(200);
    await drain(result.response);
    const admission = callsTo(SESSION_ADMISSION_URL, "POST")[0];
    expect(admission.headers["x-freebuff-model"]).toBe(DEEPSEEK_HANDLE); // row handle, not the key or the human id
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.body.model).toBe(DEEPSEEK_KEY); // catalog key, not the human id
  });

  it("still accepts the catalog key itself", async () => {
    installUpstream(keyedCatalogOverrides());
    const result = await executor.execute(makeExecuteArgs({ model: `cb/${DEEPSEEK_KEY}` }));
    expect(result.response.status).toBe(200);
    await drain(result.response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")[0].headers["x-freebuff-model"]).toBe(DEEPSEEK_HANDLE);
    expect(callsTo(CHAT_URL, "POST")[0].body.model).toBe(DEEPSEEK_KEY);
  });

  it("shares one session between the human id and the key of the same model", async () => {
    installUpstream(keyedCatalogOverrides());
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    await drain((await executor.execute(makeExecuteArgs({ model: `cb/${DEEPSEEK_ID}`, credentials }))).response);
    await drain((await executor.execute(makeExecuteArgs({ model: `cb/${DEEPSEEK_KEY}`, credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);
    expect(releaseCalls()).toHaveLength(0);
  });

  it("answers 502 invalid_model for an id that is neither a catalog key nor derives to one", async () => {
    installUpstream(keyedCatalogOverrides());
    const result = await executor.execute(makeExecuteArgs({ model: "cb/deepseek/not-a-real-model" }));
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.code).toBe("invalid_model");
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(0);
  });

  it("keeps the static agent map for legacy ids that match", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash", body: { messages: [] } }));
    expect(await drain(result.response)).toContain("hi");
    expect(agentRunCalls("START")[0].body.agentId).toBe("base2-free-glm-5-3-flash");
  });

  it("maps HTTP 402 out-of-credits to a billing error with a machine-readable code", async () => {
    installUpstream({ chat: () => json({ message: "Out of credits. Please add credits at https://www.codebuff.com/usage." }, { status: 402 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(402);
    const body = await result.response.json();
    expect(body.error.code).toBe("out_of_credits");
    expect(body.error.type).toBe("billing_error");
    expect(callsTo(CHAT_URL, "POST")).toHaveLength(1); // billing is not retried
  });

  it("maps a 402 from agent-run START to out_of_credits too", async () => {
    installUpstream({ start: () => json({ message: "Out of credits" }, { status: 402 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(402);
    expect((await result.response.json()).error.code).toBe("out_of_credits");
  });

  it("strips a thinking suffix such as (high) from the model", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash(high)", body: { messages: [] } }));
    expect(drain(result.response)).toBeTruthy();
    expect(agentRunCalls("START")[0].body.agentId).toBe("base2-free-glm-5-3-flash");
  });

  it("strips a provider prefix from the model before resolving the agent", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs({ model: "freebuff/mimo/mimo-v2.5" }));
    expect(agentRunCalls("START")[0].body.agentId).toBe("base2-free-mimo");
  });

  it("answers 401 without any upstream call when there is no token", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ credentials: { accessToken: "" } }));
    expect(result.response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes out on non-streaming requests with a JSON accept and no stream_options", async () => {
    installUpstream({ chat: () => json({ choices: [{ message: { content: "ok" } }] }) });
    const result = await executor.execute(makeExecuteArgs({ stream: false }));
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.headers.Accept).toBe("application/json");
    expect(chat.body.stream).toBe(false);
    expect(chat.body.stream_options).toBeUndefined();
    expect((await result.response.json()).choices[0].message.content).toBe("ok");
  });

  it("accepts an API-key credential as well as an OAuth access token", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs({ credentials: { apiKey: "fb-key-token", providerSpecificData: { freebuffDeviceKey: testRecord } } }));
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.headers.Authorization).toBe("Bearer fb-key-token");
  });
});

// ---------------------------------------------------------------------------
// device-key persistence and re-registration
// ---------------------------------------------------------------------------

describe("device key persistence", () => {
  it("persists the key record through the injected persister", async () => {
    installUpstream();
    const persisted = [];
    setFreebuffDeviceKeyPersister(async (connectionId, record) => persisted.push({ connectionId, record }));
    const credentials = { connectionId: "conn-1", accessToken: newToken() }; // no stored record: fresh key
    await executor.execute(makeExecuteArgs({ credentials }));

    expect(persisted.length).toBeGreaterThanOrEqual(1);
    expect(persisted[0].connectionId).toBe("conn-1");
    const saved = persisted.at(-1);
    expect(saved.record.version).toBe(1);
    expect(saved.record.privateKey).toBeTruthy();
    expect(Object.keys(saved.record.registrations).length).toBeGreaterThanOrEqual(1);
  });

  it("reuses the stored record after a simulated restart (no new registration)", async () => {
    installUpstream();
    const stored = await generateDeviceKeyRecord(subtle);
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: stored } };

    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(DEVICE_KEYS_URL, "POST").length).toBeGreaterThanOrEqual(1);

    // "Restart": in-memory caches are cleared, the record comes back from providerSpecificData.
    clearDeviceKeyCache();
    fetchMock.mockClear();
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ credentials }));
    expect(await drain(result.response)).toContain("hi");
    // The stored key was reused (no fresh keypair); a registration may still be needed when the
    // stored record carries no registration for this origin.
    const restartRegisters = callsTo(DEVICE_KEYS_URL, "POST");
    for (const register of restartRegisters) {
      expect(register.body.publicKey).toBe(stored.publicKey);
    }
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(
      await verifyDeviceSig({ url: CHAT_URL, method: "POST", headers: chat.headers, body: JSON.stringify(chat.body), fetchId: "fetch-test-1" }, stored),
    ).toBe(true);
  });

  it("forgets the registration and re-registers when upstream reports an unknown device key", async () => {
    let chatCalls = 0;
    installUpstream({
      chat: () => {
        chatCalls += 1;
        if (chatCalls === 1) return json({ error: "device_key unknown" }, { status: 403 });
        return sse();
      },
    });
    const result = await executor.execute(makeExecuteArgs());
    expect(await drain(result.response)).toContain("hi");
    expect(chatCalls).toBe(2);
    // The catalog was refetched and the forgotten scope re-registered after the forget (single
    // api origin: 1 initial + 1 re-register).
    expect(callsTo(CATALOG_URL, "GET").length).toBeGreaterThanOrEqual(2);
    const registerPosts = allCalls().filter((c) => c.method === "POST" && String(c.url).endsWith("/api/v1/freebuff/device-keys"));
    expect(registerPosts.length).toBeGreaterThanOrEqual(2);
    for (const register of registerPosts) {
      expect(register.body.publicKey).toBe(testRecord.publicKey); // same key, fresh registration
    }
  });

  it("refetches the catalog when the gate says it went stale", async () => {
    let chatCalls = 0;
    installUpstream({
      chat: () => {
        chatCalls += 1;
        if (chatCalls === 1) return json({ error: "freebuff_catalog_stale" }, { status: 410 });
        return sse();
      },
    });
    const result = await executor.execute(makeExecuteArgs());
    expect(await drain(result.response)).toContain("hi");
    expect(callsTo(CATALOG_URL, "GET").length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// catalog cache
// ---------------------------------------------------------------------------

describe("freebuff catalog cache", () => {
  it("caches the catalog per token and reuses the fetchId", async () => {
    installUpstream();
    const args = makeExecuteArgs();
    await drain((await executor.execute(args)).response);
    await drain((await executor.execute({ ...args, body: { messages: [{ role: "user", content: "again" }] } })).response);
    expect(callsTo(CATALOG_URL, "GET")).toHaveLength(1);

    const other = makeExecuteArgs({ credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } } });
    await drain((await executor.execute(other)).response);
    expect(callsTo(CATALOG_URL, "GET")).toHaveLength(2); // per token
  });

  it("proceeds without a fetchId when the catalog is unavailable", async () => {
    installUpstream({ catalog: () => new Response("gone", { status: 500 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(await drain(result.response)).toContain("hi");
    const admission = callsTo(SESSION_ADMISSION_URL, "POST")[0];
    expect(admission.headers["x-freebuff-catalog-fetch"]).toBeUndefined();
    expect(admission.headers["x-freebuff-catalog-protocol"]).toBeUndefined();
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.headers["x-freebuff-catalog-fetch"]).toBeUndefined();
    // The admission model falls back to the plain key without a catalog.
    expect(admission.headers["x-freebuff-model"]).toBe("m-00032eaeec");
  });

  it("keeps working when the catalog answer is not a protocol 1 document", async () => {
    installUpstream({ catalog: () => json({ rows: "nope" }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(await drain(result.response)).toContain("hi");
  });

  it("parse/visibleRows/TTL follow the CLI rules", () => {
    expect(parseCatalog({ protocol: 2, rows: [] })).toBeNull();
    expect(parseCatalog({ protocol: 1, rows: [] })).toBeNull();
    const catalog = parseCatalog({ protocol: 1, rows: [{ key: "a", opensAt: 10 }, { key: "b" }] });
    expect(visibleRows(catalog, 5).map((r) => r.key)).toEqual(["b"]);
    expect(visibleRows(catalog, 11).map((r) => r.key)).toEqual(["a", "b"]);

    const future = { refreshAt: Date.now() + 20 * 60_000 };
    expect(catalogTtlMs(future)).toBeLessThanOrEqual(30 * 60_000);
    expect(catalogTtlMs(future)).toBeGreaterThanOrEqual(60_000);
    expect(catalogTtlMs({})).toBe(5 * 60_000);
    process.env.FREEBUFF_CATALOG_TTL_MS = "1234";
    expect(catalogTtlMs(future)).toBe(1234);
    delete process.env.FREEBUFF_CATALOG_TTL_MS;
  });

  it("resolves the admission model to the live catalog row handle (bisect 2026-10-27: handle 200, key 409)", () => {
    const catalog = { rows: [{ key: "m-00032eaeec", handle: "fbm1.AAE..." }] };
    expect(resolveAdmissionModel(catalog, "m-00032eaeec")).toBe("fbm1.AAE...");
    expect(resolveAdmissionModel(catalog, "unknown/key")).toBeNull();
    expect(resolveAdmissionModel(null, "m-00032eaeec")).toBeNull(); // passthrough is the caller's job
  });

  it("falls back to the row key only when the row carries no handle", () => {
    const catalog = { rows: [{ key: "m-00032eaeec" }] };
    expect(resolveAdmissionModel(catalog, "m-00032eaeec")).toBe("m-00032eaeec");
  });

  it("derives the catalog key of a human model id (official client formula)", () => {
    expect(freebuffHandleFor(DEEPSEEK_ID)).toBe(DEEPSEEK_KEY);
    expect(freebuffHandleFor("z-ai/glm-5.3-flash")).toBe("m-7e20df6765");
  });

  it("resolves a human id through the derived catalog key", () => {
    const catalog = { rows: [{ key: "m-00032eaeec", handle: "fbm1.AAEmimo" }, { key: DEEPSEEK_KEY, handle: "fbm1.AAEdeepseek" }] };
    expect(resolveCatalogKey(catalog, DEEPSEEK_ID)).toBe(DEEPSEEK_KEY);
    expect(resolveAdmissionModel(catalog, DEEPSEEK_ID)).toBe("fbm1.AAEdeepseek");
  });

  it("still resolves an exact catalog key", () => {
    const catalog = { rows: [{ key: DEEPSEEK_KEY, handle: "fbm1.AAEdeepseek" }] };
    expect(resolveCatalogKey(catalog, DEEPSEEK_KEY)).toBe(DEEPSEEK_KEY);
    expect(resolveAdmissionModel(catalog, DEEPSEEK_KEY)).toBe("fbm1.AAEdeepseek");
  });

  it("returns null for an unknown id, a missing catalog and an empty model", () => {
    const catalog = { rows: [{ key: DEEPSEEK_KEY, handle: "fbm1.AAEdeepseek" }] };
    expect(resolveCatalogKey(catalog, "who/dis")).toBeNull();
    expect(resolveAdmissionModel(catalog, "who/dis")).toBeNull();
    expect(resolveCatalogKey(null, DEEPSEEK_ID)).toBeNull();
    expect(resolveCatalogKey(catalog, "")).toBeNull();
    expect(resolveCatalogKey(catalog, undefined)).toBeNull();
  });

  it("prefers an exact key over the derived one and ignores rows that are not open yet", () => {
    const glmKey = freebuffHandleFor("z-ai/glm-5.3-flash");
    const both = { rows: [{ key: glmKey, handle: "h-derived" }, { key: "z-ai/glm-5.3-flash", handle: "h-exact" }] };
    expect(resolveCatalogKey(both, "z-ai/glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
    const future = { rows: [{ key: DEEPSEEK_KEY, handle: "h", opensAt: Date.now() + 60_000 }] };
    expect(resolveCatalogKey(future, DEEPSEEK_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wrapStreamWithCleanup
// ---------------------------------------------------------------------------

describe("wrapStreamWithCleanup", () => {
  it("reports completion exactly once", async () => {
    const onDone = vi.fn();
    const wrapped = wrapStreamWithCleanup(sse(['data: {"x":1}\n\n', "data: [DONE]\n\n"]), onDone);
    await drain(wrapped);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("completed", undefined);
  });

  it("reports a failure when the body errors", async () => {
    const onDone = vi.fn();
    const failing = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("kaboom"));
        },
      }),
    );
    const wrapped = wrapStreamWithCleanup(failing, onDone);
    await expect(drain(wrapped)).rejects.toThrow("kaboom");
    expect(onDone).toHaveBeenCalledWith("failed", "kaboom");
  });

  it("drops encoding/length headers that no longer describe the decoded body", () => {
    const response = new Response("x", { headers: { "content-encoding": "gzip", "content-length": "99" } });
    const wrapped = wrapStreamWithCleanup(response, () => {});
    expect(wrapped.headers.get("content-encoding")).toBeNull();
    expect(wrapped.headers.get("content-length")).toBeNull();
  });

  it("finishes immediately for a bodiless response", () => {
    const onDone = vi.fn();
    const response = new Response(null);
    Object.defineProperty(response, "body", { value: null });
    wrapStreamWithCleanup(response, onDone);
    expect(onDone).toHaveBeenCalledWith("completed");
  });
});

// ---------------------------------------------------------------------------
// free session handling
// ---------------------------------------------------------------------------

describe("free session handling", () => {
  it("reuses the session for the same token and model, but not across tokens or models", async () => {
    installUpstream();
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };

    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);
    // ...but every request still gets its own agent run in this mode
    expect(agentRunCalls("START")).toHaveLength(2);
    const [first, second] = callsTo(CHAT_URL, "POST");
    expect(second.body.codebuff_metadata.freebuff_instance_id).toBe(first.body.codebuff_metadata.freebuff_instance_id);
    expect(second.body.codebuff_metadata.run_id).not.toBe(first.body.codebuff_metadata.run_id);

    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash", body: { messages: [] } }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(2);

    await drain((await executor.execute(makeExecuteArgs({ credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } } }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(3);
  });

  it("never keeps the raw token as a cache key", async () => {
    installUpstream();
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(sessions.size).toBe(1);
    for (const key of [...sessions.keys(), ...activeRuns.keys()]) {
      expect(key).not.toContain(credentials.accessToken);
    }
  });

  it("admits a fresh session once the cached one is about to expire", async () => {
    installUpstream();
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);

    // remainingMs is 600s and the cache keeps a 60s safety margin.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(realNow + 530_000);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);

    nowSpy.mockReturnValue(realNow + 550_000);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("shares one in-flight admission between concurrent requests", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let admissions = 0;
    installUpstream({
      admission: async (headers) => {
        admissions += 1;
        await gate;
        return json({ status: "active", instanceId: "srv-shared", model: "mimo/mimo-v2.5", remainingMs: 600_000 });
      },
    });
    const args = makeExecuteArgs();
    const first = executor.execute(args);
    const second = executor.execute({ ...args, body: { messages: [{ role: "user", content: "2" }] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(admissions).toBe(1);
    await drain(a.response);
    await drain(b.response);
    const instances = callsTo(CHAT_URL, "POST").map((c) => c.body.codebuff_metadata.freebuff_instance_id);
    expect(instances).toEqual(["srv-shared", "srv-shared"]);
  });

  it("does not cache a failed admission", async () => {
    let n = 0;
    installUpstream({
      admission: () => {
        n += 1;
        return n === 1
          ? json({ error: "rate_limited" }, { status: 429 })
          : json({ status: "active", instanceId: "srv-ok", model: "mimo/mimo-v2.5", remainingMs: 600_000 });
      },
    });
    const first = await executor.execute(makeExecuteArgs());
    expect(first.response.status).toBe(429);
    const second = await executor.execute(makeExecuteArgs());
    expect(second.response.status).toBe(200);
    await drain(second.response);
  });

  describe("queued", () => {
    it("answers 503 with Retry-After and an OpenAI-style error body, without starting a run", async () => {
      installUpstream({ admission: () => json({ status: "queued", instanceId: "srv-q", position: 3, queueDepth: 9, estimatedWaitMs: 8000 }) });
      const result = await executor.execute(makeExecuteArgs());
      expect(result.response.status).toBe(503);
      expect(result.response.headers.get("Retry-After")).toBe("8");
      const body = await result.response.json();
      expect(body.error.code).toBe("waiting_room_queued");
      expect(agentRunCalls("START")).toHaveLength(0);
    });

    it("clamps Retry-After between 1 and 30 seconds", async () => {
      installUpstream({ admission: () => json({ status: "queued", instanceId: "srv-q", position: 1, estimatedWaitMs: 90_000 }) });
      const result = await executor.execute(makeExecuteArgs());
      expect(result.response.headers.get("Retry-After")).toBe("30");
    });

    it("does not re-admit while the queue answer is fresh, then polls the queued instance", async () => {
      let polls = 0;
      installUpstream({
        admission: () => json({ status: "queued", instanceId: "srv-queue", position: 1, estimatedWaitMs: 1000 }),
        session: () => {
          polls += 1;
          return json({ status: "active", instanceId: "srv-queue", model: "mimo/mimo-v2.5", remainingMs: 600_000 });
        },
      });
      const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
      const first = await executor.execute(makeExecuteArgs({ credentials }));
      expect(first.response.status).toBe(503);

      // Push the clock past the queued retry window; the next request polls instead of re-admitting.
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(Date.now() + 5000);
      const second = await executor.execute(makeExecuteArgs({ credentials }));
      nowSpy.mockRestore();
      expect(polls).toBe(1);
      expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);
      const chat = callsTo(CHAT_URL, "POST")[0];
      expect(chat.body.codebuff_metadata.freebuff_instance_id).toBe("srv-queue");
      await drain(second.response);
    });
  });

  describe("model_locked", () => {
    it("falls back to the locked model and remembers it serves the requested one too", async () => {
      let asks = 0;
      installUpstream({
        admission: () => {
          asks += 1;
          if (asks === 1) return json({ status: "model_locked", currentModel: "z-ai/glm-5.3-flash", requestedModel: "mimo/mimo-v2.5" });
          return json({ status: "active", instanceId: `srv-${asks}`, model: "z-ai/glm-5.3-flash", remainingMs: 600_000 });
        },
      });
      const args = makeExecuteArgs();
      await drain((await executor.execute(args)).response);
      await drain((await executor.execute({ ...args, body: { messages: [{ role: "user", content: "2" }] } })).response);
      // The second request must not re-admit: the lock is remembered under both model names.
      expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(2);
      expect(agentRunCalls("START").map((c) => c.body.agentId)).toEqual(["base2-free-glm-5-3-flash", "base2-free-glm-5-3-flash"]);
    });

    it("answers 409 when the locked model is not runnable here", async () => {
      installUpstream({ admission: () => json({ status: "model_locked", currentModel: "unknown/lock-model" }) });
      const result = await executor.execute(makeExecuteArgs());
      expect(result.response.status).toBe(409);
      expect((await result.response.json()).error.code).toBe("model_locked");
    });
  });
});

// ---------------------------------------------------------------------------
// free session release on model switch and idle
// ---------------------------------------------------------------------------

describe("free session release", () => {
  it("releases the old session with its assigned instance id (DELETE /session) before admitting the new model", async () => {
    installUpstream();
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "mimo/mimo-v2.5" }))).response);
    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash", body: { messages: [] } }))).response);

    const releases = releaseCalls();
    expect(releases).toHaveLength(1);
    const release = releases[0];
    expect(release.method).toBe("DELETE");
    expect(release.url).toBe(SESSION_URL); // server-assigned ids end on the plain session route
    expect(release.headers["x-freebuff-instance-id"]).toMatch(/^srv-\d+$/);
    expect(release.headers["x-freebuff-desktop-attempt-id"]).toBeUndefined(); // no client-minted claims
    expect(release.headers["x-freebuff-multi-session"]).toBeUndefined();
    expect(await verifyDeviceSig({ url: SESSION_URL, method: "DELETE", headers: release.headers, fetchId: "fetch-test-1" })).toBe(true);
  });

  it("routes session URLs like the CLI: /attempt only for cli: claims", () => {
    expect(sessionUrlFor("DELETE", "cli:abcd")).toBe(SESSION_ATTEMPT_URL);
    expect(sessionUrlFor("DELETE", "srv-1")).toBe(SESSION_URL);
    expect(sessionUrlFor("POST", "")).toBe(SESSION_ADMISSION_URL);
    expect(sessionUrlFor("GET", "srv-1")).toBe(SESSION_URL);
  });

  it("does not release while the same model keeps being served", async () => {
    installUpstream();
    await drain((await executor.execute(makeExecuteArgs())).response);
    await drain((await executor.execute(makeExecuteArgs())).response);
    expect(releaseCalls()).toHaveLength(0);
  });

  it("does not release another token's session", async () => {
    installUpstream();
    await drain((await executor.execute(makeExecuteArgs())).response);
    await drain((await executor.execute(makeExecuteArgs({ credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } } }))).response);
    expect(releaseCalls()).toHaveLength(0);
  });

  it("ends the runs of the released session's agent, after their in-flight requests", async () => {
    installUpstream();
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    const first = await executor.execute(makeExecuteArgs({ credentials, model: "mimo/mimo-v2.5" }));
    await drain(first.response);
    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash", body: { messages: [] } }))).response);
    // The mimo run is retired: a FINISH goes out for it.
    expect(agentRunCalls("FINISH").length).toBeGreaterThanOrEqual(1);
  });

  it("does not fail the request when the release answers an error", async () => {
    installUpstream({ release: () => new Response("no", { status: 500 }) });
    await drain((await executor.execute(makeExecuteArgs({ model: "mimo/mimo-v2.5" }))).response);
    const second = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash", body: { messages: [] } }));
    expect(second.response.status).toBe(200);
    await drain(second.response);
  });

  it("does not fail the request when the release call itself throws", async () => {
    installUpstream();
    const upstream = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (url === SESSION_URL && init?.method === "DELETE") throw new Error("socket blew up");
      return upstream(url, init);
    });
    await drain((await executor.execute(makeExecuteArgs({ model: "mimo/mimo-v2.5" }))).response);
    const second = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash", body: { messages: [] } }));
    expect(second.response.status).toBe(200);
    await drain(second.response);
  });

  it("treats a 404 on release as already gone", async () => {
    installUpstream({ release: () => new Response("gone", { status: 404 }) });
    await drain((await executor.execute(makeExecuteArgs({ model: "mimo/mimo-v2.5" }))).response);
    const second = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash", body: { messages: [] } }));
    expect(second.response.status).toBe(200);
    await drain(second.response);
  });

  it("drops the old session even when the new admission is refused, instead of reusing a released one", async () => {
    let admissions = 0;
    const token = newToken();
    const credentials = { accessToken: token, providerSpecificData: { freebuffDeviceKey: testRecord } };
    installUpstream({
      admission: () => {
        admissions += 1;
        if (admissions === 2) return json({ error: "purchase_capacity" }, { status: 429 });
        return json({ status: "active", instanceId: `srv-${admissions}`, model: admissions === 1 ? "mimo/mimo-v2.5" : "z-ai/glm-5.3-flash", remainingMs: 600_000 });
      },
    });
    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "mimo/mimo-v2.5" }))).response);
    const second = await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash", body: { messages: [] } }));
    expect(second.response.status).toBe(429);
    // The refused switch must not have restored the released mimo session.
    expect(sessions.get(sessionKey(tokenOf(credentials)))).toBeUndefined();
  });

  it("releases an idle session after FREEBUFF_SESSION_IDLE_MS so the slot does not stay occupied", async () => {
    vi.useFakeTimers();
    installUpstream();
    process.env.FREEBUFF_SESSION_IDLE_MS = "1000";
    const args = makeExecuteArgs();
    const first = await executor.execute(args);
    await drain(first.response);
    expect(releaseCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1500);
    // Signing the release runs real WebCrypto on the thread pool: give the event loop a few real
    // turns so the DELETE lands before asserting.
    vi.useRealTimers();
    for (let i = 0; i < 50 && releaseCalls().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(releaseCalls()).toHaveLength(1);
    expect(releaseCalls()[0].headers["x-freebuff-instance-id"]).toMatch(/^srv-/);

    // The session is gone: the next request re-admits.
    const second = await executor.execute(args);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(2);
    await drain(second.response);
  });

  it("defaults the idle window to ten minutes and ignores bad values", () => {
    expect(sessionIdleMs()).toBe(DEFAULT_SESSION_IDLE_MS);
    expect(DEFAULT_SESSION_IDLE_MS).toBe(600_000);
    process.env.FREEBUFF_SESSION_IDLE_MS = "banana";
    expect(sessionIdleMs()).toBe(600_000);
    process.env.FREEBUFF_SESSION_IDLE_MS = "0";
    expect(sessionIdleMs()).toBe(0);
  });

  it("releases a queued claim of the old model too", async () => {
    let admissions = 0;
    const credentials = { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } };
    installUpstream({
      admission: () => {
        admissions += 1;
        if (admissions === 1) return json({ status: "queued", instanceId: "srv-queued-1", position: 1, estimatedWaitMs: 30_000 });
        return json({ status: "active", instanceId: "srv-2", model: "z-ai/glm-5.3-flash", remainingMs: 600_000 });
      },
      session: () => json({ status: "queued", instanceId: "srv-queued-1", position: 1, estimatedWaitMs: 30_000 }),
    });
    const first = await executor.execute(makeExecuteArgs({ credentials, model: "mimo/mimo-v2.5" }));
    expect(first.response.status).toBe(503);
    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash", body: { messages: [] } }))).response);
    expect(releaseCalls()[0].headers["x-freebuff-instance-id"]).toBe("srv-queued-1");
  });
});

// ---------------------------------------------------------------------------
// run reuse and rotation
// ---------------------------------------------------------------------------

describe("run reuse and rotation", () => {
  it("reuses one run across sequential requests: one admission, one START, no FINISH in between", async () => {
    delete process.env.FREEBUFF_RUN_ROTATION_MS; // default: six-hour reuse
    installUpstream();
    const args = makeExecuteArgs();
    await drain((await executor.execute(args)).response);
    await drain((await executor.execute({ ...args, body: { messages: [{ role: "user", content: "2" }] } })).response);
    expect(callsTo(SESSION_ADMISSION_URL, "POST")).toHaveLength(1);
    expect(agentRunCalls("START")).toHaveLength(1);
    expect(agentRunCalls("FINISH")).toHaveLength(0);
  });

  it("keeps a run per agent: another model on the same token gets its own run", async () => {
    delete process.env.FREEBUFF_RUN_ROTATION_MS;
    installUpstream();
    await drain((await executor.execute(makeExecuteArgs({ model: "mimo/mimo-v2.5" }))).response);
    await drain((await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash", body: { messages: [] } }))).response);
    expect(agentRunCalls("START")).toHaveLength(2);
  });

  it("does not share runs across tokens", async () => {
    delete process.env.FREEBUFF_RUN_ROTATION_MS;
    installUpstream();
    await drain((await executor.execute(makeExecuteArgs())).response);
    await drain((await executor.execute(makeExecuteArgs({ credentials: { accessToken: newToken(), providerSpecificData: { freebuffDeviceKey: testRecord } } }))).response);
    expect(agentRunCalls("START")).toHaveLength(2);
  });

  it("FREEBUFF_RUN_ROTATION_MS=0 restores a START and a FINISH for every request", async () => {
    process.env.FREEBUFF_RUN_ROTATION_MS = "0";
    installUpstream();
    const args = makeExecuteArgs();
    await drain((await executor.execute(args)).response);
    await drain((await executor.execute({ ...args, body: { messages: [{ role: "user", content: "2" }] } })).response);
    expect(agentRunCalls("START")).toHaveLength(2);
    expect(agentRunCalls("FINISH")).toHaveLength(2);
  });

  it("finishes the run as cancelled when the client goes away mid-stream", async () => {
    installUpstream({
      chat: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const result = await executor.execute(makeExecuteArgs());
    const reader = result.response.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(agentRunCalls("FINISH")[0].body.status).toBe("cancelled");
  });

  it("finishes the run as failed when the chat call itself throws", async () => {
    installUpstream();
    const upstream = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => {
      if (url === CHAT_URL) throw new Error("boom");
      return upstream(url, init);
    });
    await expect(executor.execute(makeExecuteArgs())).rejects.toThrow("boom");
    expect(agentRunCalls("FINISH")[0].body.status).toBe("failed");
  });

  it("ignores a FINISH failure", async () => {
    installUpstream({ finish: () => new Response("no", { status: 500 }) });
    const result = await executor.execute(makeExecuteArgs());
    await drain(result.response);
    expect(agentRunCalls("FINISH")).toHaveLength(1);
  });

  it("defaults to six hours and falls back to it for a bad value", () => {
    delete process.env.FREEBUFF_RUN_ROTATION_MS;
    expect(runRotationMs()).toBe(DEFAULT_RUN_ROTATION_MS);
    expect(DEFAULT_RUN_ROTATION_MS).toBe(6 * 3_600_000);
    process.env.FREEBUFF_RUN_ROTATION_MS = "banana";
    expect(runRotationMs()).toBe(DEFAULT_RUN_ROTATION_MS);
    process.env.FREEBUFF_RUN_ROTATION_MS = "0";
    expect(runRotationMs()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// direct egress
// ---------------------------------------------------------------------------

describe("direct egress", () => {
  it("drops a relay pool URL but keeps plain proxy settings", () => {
    const opts = { vercelRelayUrl: "https://relay.example/pipe", connectionProxyUrl: "http://proxy:8080" };
    const out = directEgressOptions(opts);
    expect(out.vercelRelayUrl).toBeUndefined();
    expect(out.connectionProxyUrl).toBe("http://proxy:8080");
  });

  it("passes options without a relay through untouched", () => {
    const opts = { connectionProxyEnabled: true, connectionProxyUrl: "socks5://x" };
    expect(directEgressOptions(opts)).toBe(opts);
    expect(directEgressOptions(null)).toBeNull();
  });

  it("warns once per relay with a single line", () => {
    const log = { warn: vi.fn() };
    directEgressOptions({ vercelRelayUrl: "https://r/1" }, log);
    directEgressOptions({ vercelRelayUrl: "https://r/1" }, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("never hands the relay URL to any of the outgoing calls", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs({ proxyOptions: { vercelRelayUrl: "https://relay.example/pipe" } }));
    for (const call of allCalls()) {
      expect(call.opts?.vercelRelayUrl).toBeUndefined();
    }
  });

  it("still routes through a plain HTTP/SOCKS proxy", async () => {
    installUpstream();
    await executor.execute(makeExecuteArgs({ proxyOptions: { connectionProxyUrl: "socks5://proxy:1080" } }));
    const chat = callsTo(CHAT_URL, "POST")[0];
    expect(chat.opts.connectionProxyUrl).toBe("socks5://proxy:1080");
  });
});

// ---------------------------------------------------------------------------
// upstream errors
// ---------------------------------------------------------------------------

describe("upstream errors", () => {
  it("surfaces Codebuff's machine-readable code through parseError", () => {
    const parsed = executor.parseError({ status: 403 }, JSON.stringify({ error: "free_mode_cli_required", message: "nope" }));
    expect(parsed.status).toBe(403);
    expect(parsed.message).toBe("free_mode_cli_required: nope");
  });

  it("keeps an admission refusal's status and code without calling chat", async () => {
    installUpstream({ admission: () => json({ error: "country_blocked" }, { status: 403 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.code).toBe("country_blocked");
    expect(callsTo(CHAT_URL)).toHaveLength(0);
  });

  it("turns a refusal delivered in a 2xx body into a real HTTP status", async () => {
    installUpstream({ admission: () => json({ status: "banned" }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(403);
    expect((await result.response.json()).error.code).toBe("banned");
  });

  it("passes a 401 from admission straight through", async () => {
    installUpstream({ admission: () => json({ error: "unauthorized" }, { status: 401 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(401);
  });

  it("gives a 429 from admission a Retry-After even when upstream sent none", async () => {
    installUpstream({ admission: () => json({ error: "rate_limited" }, { status: 429 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("Retry-After")).toBe("30");
  });

  it("passes a START refusal through and never chats", async () => {
    installUpstream({ start: () => json({ error: "no_capacity" }, { status: 429 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(429);
    expect(callsTo(CHAT_URL)).toHaveLength(0);
  });

  it("rejects a START answer without a run id", async () => {
    installUpstream({ start: () => json({ nope: true }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(502);
  });

  it("passes a chat gate error through after no retry when nothing is renewable", async () => {
    installUpstream({ chat: () => json({ error: "free_mode_cli_required" }, { status: 403 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(403);
    expect(callsTo(CHAT_URL, "POST")).toHaveLength(1);
  });

  it("re-admits once when the chat gate reports the session is gone", async () => {
    let chatCalls = 0;
    let admissions = 0;
    installUpstream({
      admission: () => {
        admissions += 1;
        return json({ status: "active", instanceId: `srv-${admissions}`, model: "mimo/mimo-v2.5", remainingMs: 600_000 });
      },
      chat: () => {
        chatCalls += 1;
        if (chatCalls === 1) return json({ error: "session_expired" }, { status: 410 });
        return sse();
      },
    });
    const result = await executor.execute(makeExecuteArgs());
    expect(await drain(result.response)).toContain("hi");
    expect(admissions).toBe(2);
    expect(chatCalls).toBe(2);
  });

  it("classifies gate errors in gateRetryKind", () => {
    expect(gateRetryKind(410, JSON.stringify({ error: "session_expired" }))).toBe("session");
    expect(gateRetryKind(410, JSON.stringify({ error: "freebuff_update_required" }))).toBe("session");
    expect(gateRetryKind(410, JSON.stringify({ error: "freebuff_catalog_stale" }))).toBe("catalog");
    expect(gateRetryKind(403, JSON.stringify({ error: "device_key unknown" }))).toBe("devicekey");
    expect(gateRetryKind(400, "runId not found")).toBe("run");
    expect(gateRetryKind(403, JSON.stringify({ error: "free_mode_cli_required" }))).toBeNull();
    expect(isDeviceKeyError("device_key unknown")).toBe(true);
  });

  it("reports a session admission route that no longer exists (CLI hard error)", async () => {
    installUpstream({ admission: () => new Response("no", { status: 404 }) });
    const result = await executor.execute(makeExecuteArgs());
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.code).toBe("session_admission_unsupported");
  });
});

// ---------------------------------------------------------------------------
// probeFreebuffToken
// ---------------------------------------------------------------------------

describe("probeFreebuffToken", () => {
  it("accepts a token the session endpoint answers to", async () => {
    installUpstream({ session: () => json({ status: "none" }) });
    expect(await probeFreebuffToken("tok")).toEqual({ valid: true, status: 200, error: null });
  });

  it("rejects an invalid token on 401", async () => {
    installUpstream({ session: () => json({ error: "no" }, { status: 401 }) });
    const result = await probeFreebuffToken("tok");
    expect(result.valid).toBe(false);
    expect(result.status).toBe(401);
  });

  it("keeps the token valid but warns on country_blocked", async () => {
    installUpstream({ session: () => json({ status: "country_blocked" }) });
    const result = await probeFreebuffToken("tok");
    expect(result.valid).toBe(true);
    expect(result.warning).toContain("country_blocked");
  });

  it("reports transport failures and missing tokens", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("no route");
    });
    expect((await probeFreebuffToken("tok")).valid).toBe(false);
    expect((await probeFreebuffToken("")).valid).toBe(false);
  });

  it("goes out directly even when the connection uses a relay pool", async () => {
    installUpstream({ session: () => json({ status: "none" }) });
    await probeFreebuffToken("tok", { vercelRelayUrl: "https://relay/pipe" });
    expect(allCalls()[0].opts?.vercelRelayUrl).toBeUndefined();
  });

  it("signs the session GET when a device key is handed over", async () => {
    installUpstream({ session: () => json({ status: "none" }) });
    const { FreebuffDeviceKeyManager } = await import("../../open-sse/utils/freebuffDeviceKey.js");
    const manager = new FreebuffDeviceKeyManager({ record: testRecord, fetchImpl: async () => json({ keyId: "key-p" }) });
    await probeFreebuffToken("tok", null, { deviceKey: manager });
    const call = callsTo(SESSION_URL, "GET")[0];
    expect(call.headers["User-Agent"]).toBe(sessionUserAgent());
    expect(await verifyDeviceSig({ url: SESSION_URL, headers: call.headers })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// freebuff oauth provider
// ---------------------------------------------------------------------------

describe("freebuff oauth provider (Freebuff Desktop login)", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CODE_URL = "https://freebuff.com/api/auth/cli/code";
  const STATUS_URL = "https://freebuff.com/api/auth/cli/status";
  const LOGIN_URL = "https://freebuff.com/login?auth_code=abc.def";

  const loadProvider = async () => (await import("../../src/lib/oauth/providers/freebuff.js")).default;
  const lowerKeys = (headers) => Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const codeBody = (extra = {}) => ({ loginUrl: LOGIN_URL, fingerprintHash: "h", expiresAt: 1790000000000, expiresInMs: 60_000, ...extra });
  const mockCode = (extra) => fetchMock.mockImplementation(async () => json(codeBody(extra)));

  afterEach(() => {
    delete process.env.FREEBUFF_AUTH_HOST;
  });

  it("is a device_code flow wired to the freebuff.com auth endpoints, not codebuff.com", async () => {
    const provider = await loadProvider();
    expect(provider.flowType).toBe("device_code");
    expect(provider.config.deviceCodeUrl).toBe(CODE_URL);
    expect(provider.config.tokenUrl).toBe(STATUS_URL);
  });

  it("mints the login code on freebuff.com with a uuid fingerprint and only the Desktop request headers", async () => {
    const provider = await loadProvider();
    mockCode();
    await provider.requestDeviceCode(provider.config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = allCalls()[0];
    expect(call.url).toBe(CODE_URL);
    expect(call.method).toBe("POST");
    // Desktop: content-type plus the Freebuff-CLI/<version> User-Agent (0.0.200).
    expect(lowerKeys(call.headers)).toEqual({ "content-type": "application/json", "user-agent": "Freebuff-CLI/0.0.200" });
    expect(Object.keys(call.body)).toEqual(["fingerprintId"]);
    expect(call.body.fingerprintId).toMatch(UUID_RE);
  });

  it("does not present itself as a browser or as the codebuff cli", async () => {
    const provider = await loadProvider();
    mockCode();
    await provider.requestDeviceCode(provider.config);
    fetchMock.mockImplementation(async () => json({ error: "pending" }, { status: 401 }));
    await provider.pollToken(provider.config, JSON.stringify({ fingerprintId: "fp", fingerprintHash: "h", expiresAt: 1 }));

    for (const call of allCalls()) {
      const headers = lowerKeys(call.headers);
      expect(headers["user-agent"]).toMatch(/^Freebuff-CLI\/\d+/);
      expect(headers["user-agent"]).not.toMatch(/Mozilla|Chrome|Safari/);
      expect(headers.accept).toBeUndefined();
      expect(String(call.url)).not.toMatch(/codebuff/i);
    }
  });

  it("packs fingerprint, hash, expiry and cli flow id into device_code and opens the cli_flow login url", async () => {
    const provider = await loadProvider();
    mockCode();
    const device = await provider.requestDeviceCode(provider.config);

    const packed = JSON.parse(device.device_code);
    expect(packed.fingerprintId).toMatch(UUID_RE);
    expect(packed.fingerprintHash).toBe("h");
    expect(packed.expiresAt).toBe(1790000000000);
    expect(packed.cliFlowId).toMatch(UUID_RE);
    expect(packed.cliFlowId).not.toBe(packed.fingerprintId);

    const login = new URL(device.verification_uri);
    expect(login.origin).toBe("https://freebuff.com");
    expect(login.searchParams.get("cli_flow")).toBe(packed.cliFlowId);
    expect(login.searchParams.get("auth_code")).toBe("abc.def"); // server-issued params survive
    expect(device.verification_uri_complete).toBe(device.verification_uri);

    // The modal code is the first 8 chars of the uuid fingerprint, with no codebuff prefix.
    expect(device.user_code).toBe(packed.fingerprintId.slice(0, 8));
    expect(JSON.stringify(device)).not.toMatch(/codebuff/i);
    expect(device.expires_in).toBe(60);
    expect(device.interval).toBe(5);
  });

  it("uses a fresh fingerprint and cli flow id for every sign-in", async () => {
    const provider = await loadProvider();
    mockCode();
    const a = JSON.parse((await provider.requestDeviceCode(provider.config)).device_code);
    const b = JSON.parse((await provider.requestDeviceCode(provider.config)).device_code);
    expect(a.fingerprintId).not.toBe(b.fingerprintId);
    expect(a.cliFlowId).not.toBe(b.cliFlowId);
  });

  it("falls back to a one hour lifetime and caps an oversized one at two hours", async () => {
    const provider = await loadProvider();
    mockCode({ expiresInMs: undefined });
    expect((await provider.requestDeviceCode(provider.config)).expires_in).toBe(3600);
    mockCode({ expiresInMs: 99 * 60 * 60 * 1000 });
    expect((await provider.requestDeviceCode(provider.config)).expires_in).toBe(7200);
  });

  it("honours FREEBUFF_AUTH_HOST for both endpoints and the login url origin check", async () => {
    const provider = await loadProvider();
    process.env.FREEBUFF_AUTH_HOST = "http://localhost:4010/";
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/code")) return json(codeBody({ loginUrl: "http://localhost:4010/login?auth_code=x" }));
      return json({ error: "pending" }, { status: 401 });
    });
    const device = await provider.requestDeviceCode(provider.config);
    await provider.pollToken(provider.config, device.device_code);
    expect(allCalls().map((c) => String(c.url).split("?")[0])).toEqual([
      "http://localhost:4010/api/auth/cli/code",
      "http://localhost:4010/api/auth/cli/status",
    ]);
  });

  it("reports a failed code request with the status", async () => {
    const provider = await loadProvider();
    fetchMock.mockResolvedValue(new Response("no", { status: 500 }));
    await expect(provider.requestDeviceCode(provider.config)).rejects.toThrow(/500/);
  });

  describe("code response validation", () => {
    const rejects = async (extra, pattern, raw) => {
      const provider = await loadProvider();
      fetchMock.mockImplementation(async () => (raw !== undefined ? new Response(raw, { status: 200 }) : json(codeBody(extra))));
      await expect(provider.requestDeviceCode(provider.config)).rejects.toThrow(pattern);
    };

    it("rejects a body that is not a json object", () => rejects({}, /invalid/, "<html>nope</html>"));
    it("rejects a missing loginUrl", () => rejects({ loginUrl: undefined }, /loginUrl/));
    it("rejects an unparseable loginUrl", () => rejects({ loginUrl: "not a url" }, /invalid loginUrl/));
    it("rejects a loginUrl outside the auth host", () => rejects({ loginUrl: "https://www.codebuff.com/login?auth_code=x" }, /origin/));
    it("rejects a loginUrl with embedded credentials", () => rejects({ loginUrl: "https://user:pw@freebuff.com/login" }, /credentials/));
    it("rejects a missing fingerprintHash", () => rejects({ fingerprintHash: undefined }, /fingerprintHash/));
    it("rejects a blank fingerprintHash", () => rejects({ fingerprintHash: "   " }, /fingerprintHash/));
    it("rejects a non-string fingerprintHash", () => rejects({ fingerprintHash: 42 }, /fingerprintHash/));
    it("rejects a missing expiresAt", () => rejects({ expiresAt: undefined }, /expiresAt/));
    it("rejects a non-numeric expiresAt", () => rejects({ expiresAt: "2026-01-01" }, /expiresAt/));
    it("rejects a non-positive expiresAt", () => rejects({ expiresAt: 0 }, /expiresAt/));
    it("rejects a fractional expiresAt", () => rejects({ expiresAt: 1.5 }, /expiresAt/));
  });

  it("echoes fingerprintId, fingerprintHash and expiresAt back on a bare GET and reports 401 as pending", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => json({ error: "pending" }, { status: 401 }));
    const result = await provider.pollToken(
      provider.config,
      JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 1790000000000, cliFlowId: "att" }),
    );
    expect(result).toEqual({ ok: false, data: { error: "authorization_pending" } });

    const call = allCalls()[0];
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(STATUS_URL);
    expect(call.method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: "1790000000000" });
    expect(lowerKeys(call.headers)).toEqual({ "user-agent": "Freebuff-CLI/0.0.200" });
    expect(call.body).toBeNull();
  });

  it("surfaces other poll failures instead of treating them as pending", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => new Response("boom", { status: 503 }));
    const result = await provider.pollToken(provider.config, JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 1 }));
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("poll_failed");
    expect(result.data.error_description).toContain("503");
  });

  it("keeps polling when an ok answer carries no auth token yet", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => json({ user: { id: "u1" } }));
    const result = await provider.pollToken(provider.config, JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 1 }));
    expect(result).toEqual({ ok: false, data: { error: "authorization_pending" } });
  });

  it("returns the auth token once approved and records the desktop origin on the connection", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => json({ user: { authToken: "t", id: "u1", email: "e@x", name: "N" } }));
    const result = await provider.pollToken(
      provider.config,
      JSON.stringify({ fingerprintId: "fp-1", fingerprintHash: "h", expiresAt: 1, cliFlowId: "att-1" }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("t");

    const mapped = provider.mapTokens(result.data);
    expect(mapped.accessToken).toBe("t");
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.email).toBe("e@x");
    expect(mapped.displayName).toBe("N");
    expect(mapped.providerSpecificData).toEqual({
      userId: "u1",
      fingerprintId: "fp-1",
      fingerprintHash: "h",
      freebuffAuthOrigin: "desktop",
      cliFlowId: "att-1",
    });
  });

  it("round-trips one sign-in: the polled fingerprint and the stored cli flow id match the minted ones", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async (url) => {
      if (String(url).startsWith(CODE_URL)) return json(codeBody());
      return json({ user: { authToken: "tok", id: "u9", email: "a@b.c", name: "Nine" } });
    });
    const device = await provider.requestDeviceCode(provider.config);
    const polled = await provider.pollToken(provider.config, device.device_code);
    const stored = provider.mapTokens(polled.data).providerSpecificData;

    const mintedFingerprint = allCalls()[0].body.fingerprintId;
    expect(new URL(allCalls()[1].url).searchParams.get("fingerprintId")).toBe(mintedFingerprint);
    expect(stored.fingerprintId).toBe(mintedFingerprint);
    expect(stored.fingerprintId).toMatch(UUID_RE);
    expect(stored.cliFlowId).toBe(new URL(device.verification_uri).searchParams.get("cli_flow"));
    expect(stored.freebuffAuthOrigin).toBe("desktop");
  });

  it("still understands the older answer shapes", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => json({ default: { authToken: "old" } }));
    const result = await provider.pollToken(provider.config, "fp");
    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("old");
  });

  it("accepts a bare fingerprint id as device code", async () => {
    const provider = await loadProvider();
    fetchMock.mockImplementation(async () => json({ error: "pending" }, { status: 401 }));
    expect(await provider.pollToken(provider.config, "fp-9")).toEqual({ ok: false, data: { error: "authorization_pending" } });
    expect(String(allCalls()[0].url)).toContain("fingerprintId=fp-9");
  });

  it("falls back to a placeholder display name without profile data", async () => {
    const provider = await loadProvider();
    const mapped = provider.mapTokens({ access_token: "t" });
    expect(mapped.displayName).toBe("Freebuff User");
    expect(mapped.providerSpecificData.freebuffAuthOrigin).toBe("desktop");
  });
});

// ---------------------------------------------------------------------------
// cloud-run lane (Desktop 0.0.188 protocol)
// ---------------------------------------------------------------------------

describe("cloud-run lane (desktop protocol)", () => {
  const desktopCredentials = () => ({
    accessToken: newToken(),
    providerSpecificData: { freebuffExecMode: "cloud-run", freebuffDeviceKeyDesktop: testRecord },
  });

  it("resolveExecMode prefers the connection setting over the env default", () => {
    expect(resolveExecMode({})).toBe("cli-chat");
    expect(resolveExecMode({ providerSpecificData: { freebuffExecMode: "cloud-run" } })).toBe("cloud-run");
    process.env.FREEBUFF_EXEC_MODE = "cloud-run";
    expect(resolveExecMode({})).toBe("cloud-run");
    expect(resolveExecMode({ providerSpecificData: { freebuffExecMode: "cli-chat" } })).toBe("cli-chat");
    process.env.FREEBUFF_EXEC_MODE = "banana";
    expect(resolveExecMode({})).toBe("cli-chat");
    delete process.env.FREEBUFF_EXEC_MODE;
  });

  it("desktop identity: UA, version default and token-derived install id", () => {
    expect(desktopVersion()).toBe(DEFAULT_DESKTOP_VERSION);
    expect(DEFAULT_DESKTOP_VERSION).toBe("0.0.188");
    expect(desktopUserAgent()).toBe("Freebuff-Desktop/0.0.188");
    expect(installIdFor("tok")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(installIdFor("tok")).toBe(installIdFor("tok")); // deterministic across restarts
    expect(installIdFor("other")).not.toBe(installIdFor("tok"));
  });

  it("signs the desktop admission with client, install-id, instance and multi-session headers", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ credentials: desktopCredentials() }));
    // env-free mode selection: the connection field drives it
    expect(result.response.status).toBe(200);

    const admission = callsTo(SESSION_ADMISSION_URL, "POST")[0];
    expect(admission.headers["User-Agent"]).toBe(desktopUserAgent());
    expect(admission.headers["x-freebuff-client"]).toBe("desktop");
    expect(admission.headers["x-freebuff-install-id"]).toBe(installIdFor(admission.headers.Authorization.replace("Bearer ", "")));
    expect(admission.headers["x-freebuff-client-version"]).toBe("0.0.188");
    expect(admission.headers["x-freebuff-instance-id"]).toMatch(/^byok-[0-9a-f-]{36}$/);
    expect(admission.headers["x-freebuff-multi-session"]).toBe("1");
    expect(admission.headers["x-freebuff-purchase-continuity"]).toBe("1");
    expect(admission.headers["x-freebuff-model"]).toBe("fbm1.AAEmimoAlias"); // catalog row handle
    expect(admission.headers["x-freebuff-wallet-spend-limit"]).toBe("session");
    expect(admission.headers["x-freebuff-env"]).toBeUndefined(); // no CLI fingerprint on the desktop lane
    expect(await verifyDeviceSig({ url: SESSION_ADMISSION_URL, method: "POST", headers: admission.headers, fetchId: "fetch-test-1" })).toBe(true);
  });

  it("posts a cloud run (unsigned) and adapts chunk events into an SSE chat response", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ credentials: desktopCredentials() }));
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("text/event-stream");
    const text = await result.response.text();
    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"y"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);

    // The run POST is Bearer-only: no device-key signature, no CLI fingerprint.
    const runPost = callsTo(CLOUD_RUNS_URL, "POST")[0];
    expect(runPost.headers.Authorization).toMatch(/^Bearer fb-test-token-/);
    expect(runPost.headers["x-freebuff-cloud-questions"]).toBe("1");
    expect(JSON.parse(runPost.headers["X-Freebuff-Product-Context"])).toEqual({ originApp: "desktop" });
    expect(runPost.headers["x-freebuff-device-key"]).toBeUndefined();

    // Submission shape (REPORT-DESKTOP.md §5).
    expect(runPost.body.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runPost.body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runPost.body.instanceId).toMatch(/^srv-\d+$/); // server-assigned instance id from admission
    expect(runPost.body.model).toBe("mimo/mimo-v2.5"); // live catalog key
    expect(runPost.body.prompt).toContain("user: hello");
    expect(runPost.body.agentMode).toBe("chat");
    expect(runPost.body.injectAgentsMd).toBe(false);
    expect(runPost.body.images).toEqual([]);
    expect(runPost.body.terminalSessionIds).toEqual([]);
    expect(runPost.body.github).toBeUndefined();

    // Polling walked the run's event page (client-minted run id).
    expect(allCalls().some((c) => c.method === "GET" && String(c.url).startsWith(`${CLOUD_RUNS_URL}/`))).toBe(true);
  });

  it("translates a human model id to its catalog key for the admission and the cloud run", async () => {
    installUpstream(keyedCatalogOverrides());
    const result = await executor.execute(makeExecuteArgs({ model: `cb/${DEEPSEEK_ID}`, credentials: desktopCredentials() }));
    expect(result.response.status).toBe(200);
    await result.response.text();
    expect(callsTo(SESSION_ADMISSION_URL, "POST")[0].headers["x-freebuff-model"]).toBe(DEEPSEEK_HANDLE);
    expect(callsTo(CLOUD_RUNS_URL, "POST")[0].body.model).toBe(DEEPSEEK_KEY);
  });

  it("renders a non-streaming cloud run as a chat.completion JSON body", async () => {
    installUpstream();
    const result = await executor.execute(makeExecuteArgs({ credentials: desktopCredentials(), stream: false }));
    expect(result.response.status).toBe(200);
    const body = await result.response.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hey");
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("refreshes the catalog and retries once when the cloud run answers freebuff_catalog_stale", async () => {
    let posts = 0;
    installUpstream({
      cloudRunPost: () => {
        posts += 1;
        return posts === 1 ? json({ error: "freebuff_catalog_stale" }, { status: 409 }) : json({ runId: "cloud-run-2", status: "queued" });
      },
    });
    const result = await executor.execute(makeExecuteArgs({ credentials: desktopCredentials() }));
    expect(result.response.status).toBe(200);
    expect(posts).toBe(2);
    expect(callsTo(CATALOG_URL, "GET").length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a failed cloud run as 502", async () => {
    installUpstream({
      cloudRunGet: () => json({ status: "failed", errorMessage: "model exploded" }),
    });
    const result = await executor.execute(makeExecuteArgs({ credentials: desktopCredentials() }));
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error.code).toBe("cloud_run_failed");
  });

  it("registers the desktop keypair separately from the cli keypair", async () => {
    installUpstream();
    const token = newToken();
    await executor.execute(makeExecuteArgs({ credentials: { accessToken: token, providerSpecificData: { freebuffDeviceKey: testRecord, freebuffDeviceKeyDesktop: testRecord } } }));
    await executor.execute(makeExecuteArgs({ credentials: { accessToken: token, providerSpecificData: { freebuffExecMode: "cloud-run", freebuffDeviceKey: testRecord, freebuffDeviceKeyDesktop: testRecord } } }));
    // Both lanes ran; each registration carries its client type.
    expect(callsTo(DEVICE_KEYS_URL, "POST").length).toBeGreaterThanOrEqual(2);
  });

  it("cloud helpers: prompt flattening, chunk text, admission model fallback to the digest handle", () => {
    const { prompt, displayPrompt } = promptFromMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ]);
    expect(prompt).toBe("system: be brief\n\nuser: hello world");
    expect(displayPrompt).toBe("hello world");
    expect(cloudChunkText({ text: "x" })).toBe("x");
    expect(cloudChunkText("raw")).toBe("raw");
    expect(cloudChunkText(undefined)).toBe("");
    const submission = buildCloudSubmission({ body: { messages: [{ role: "user", content: "hi" }] }, model: "m-abc", instanceId: "srv-9" });
    expect(submission.instanceId).toBe("srv-9");
    expect(submission.prompt).toBe("user: hi");
    expect(submission.effort).toBeUndefined();
    const withEffort = buildCloudSubmission({ body: { messages: [], reasoning_effort: "high" }, model: "m-abc", instanceId: "" });
    expect(withEffort.effort).toBe("high");
    expect(withEffort.instanceId).toMatch(/^byok-[0-9a-f-]{36}$/);
  });

  it("computes the desktop model handle exactly like the binary (verified vector)", async () => {
    const { freebuffHandleFor, freebuffLegacyModelDigest } = await import("../../open-sse/utils/freebuffCatalog.js");
    expect(freebuffLegacyModelDigest("z-ai/glm-5.3-flash")).toBe("197cbcdc4b67262b");
    expect(freebuffHandleFor("z-ai/glm-5.3-flash")).toBe("m-7e20df6765");
  });
});

// ---------------------------------------------------------------------------
// model surface compatibility (cb/ + registry list)
// ---------------------------------------------------------------------------

describe("model surface", () => {
  it("keeps the 10 registry models intact", () => {
    expect(freebuffRegistry.models.map((m) => m.id)).toEqual([
      "mimo/mimo-v2.5",
      "z-ai/glm-5.3-flash",
      "deepseek/deepseek-v4-flash",
      "openai/gpt-6-luna",
      "mimo/mimo-v2.6-pro",
      "google/gemini-3.8-flash",
      "upstage/solar-mini4",
      "upstage/solar-pro4",
      "stealth/space-bunny-alpha",
      "meta/muse-spark-1.2-contributor",
    ]);
  });

  it("registry remains passthrough so catalog keys reach the executor", () => {
    expect(freebuffRegistry.passthroughModels).toBe(true);
  });
});
