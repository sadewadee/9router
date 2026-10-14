import { createHash, randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

/**
 * Freebuff (codebuff.com) free-mode executor.
 *
 * The free chat endpoint only answers a "CLI-like" handshake (protocol taken from the
 * official Freebuff CLI, v0.0.200):
 *   1. POST /api/v1/freebuff/session/admission  -> free session { instanceId, model, remainingMs }
 *   2. POST /api/v1/agent-runs {action:"START"}  -> runId (agent id resolved from the model)
 *   3. POST /api/v1/chat/completions with codebuff_metadata {run_id, client_id, cost_mode:"free",
 *      freebuff_instance_id} and a leading system message that opens with the canonical Buffy prompt
 *   4. POST /api/v1/agent-runs {action:"FINISH"} once the response ends (best effort)
 *
 * Egress must be direct: Codebuff detects the CF-Worker header Cloudflare stamps on Worker
 * subrequests, so relay pools (Cloudflare/Vercel/Deno) are ignored for this provider.
 */

const BASE_URL = "https://www.codebuff.com";
const CHAT_URL = `${BASE_URL}/api/v1/chat/completions`;
const AGENT_RUNS_URL = `${BASE_URL}/api/v1/agent-runs`;
const SESSION_URL = `${BASE_URL}/api/v1/freebuff/session`;
const SESSION_ADMISSION_URL = `${BASE_URL}/api/v1/freebuff/session/admission`;

// User-Agent sent on every Codebuff call. Override with env FREEBUFF_USER_AGENT.
const DEFAULT_USER_AGENT = "Freebuff-CLI/0.0.200";
function getUserAgent() {
  return process.env.FREEBUFF_USER_AGENT || DEFAULT_USER_AGENT;
}

// Fallback model = FALLBACK_FREEBUFF_MODEL_ID upstream (unmetered, always open).
const DEFAULT_MODEL = "mimo/mimo-v2.5";

// The server does a byte-exact prefix check on the FIRST system message of a free-mode request
// (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS). base3 is the current CLI harness, so the base3-free-*
// agent ids below pair with the base3 opening (base2 agents pair with a different opening).
export const FREEBUFF_ROOT_OPENING = "You are Buffy, the coding agent behind Codebuff.";
const ROOT_SYSTEM_PROMPT =
  `${FREEBUFF_ROOT_OPENING} You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.`;

// Model -> free-mode root agent id (FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL upstream). The server pins
// each root agent to exactly one model, so an unknown model cannot be resolved (400, no passthrough).
export const FREEBUFF_AGENT_ID_BY_MODEL = {
  "mimo/mimo-v2.5": "base3-free-mimo",
  "mimo/mimo-v2.6-pro": "base3-free-mimo-2-6-pro",
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
  "z-ai/glm-5.2": "base3-free-glm",
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base3-free-deepseek",
  "openai/gpt-6-luna": "base3-free-luna-6",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "upstage/solar-mini4": "base3-free-solar-mini4",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "stealth/space-bunny-alpha": "base3-free-space-bunny-alpha",
  "stealth/ox-alpha": "base3-free-ox-alpha",
  "minimax/minimax-m3": "base3-free-minimax-m3",
  "google/gemini-3.8-flash": "base3-free-gemini-3-8-flash",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
  "meta/muse-spark-1.3-contributor": "base3-free-muse-spark-1-3",
};

// Wire headers of the free-session endpoints (common/src/constants/freebuff-models.ts).
const HEADER_MODEL = "x-freebuff-model";
const HEADER_INSTANCE = "x-freebuff-instance-id";
const HEADER_WALLET_SPEND_LIMIT = "x-freebuff-wallet-spend-limit";
const HEADER_FIRST_TAB_DISCOUNT = "x-freebuff-first-tab-discount";
const HEADER_MULTI_SESSION = "x-freebuff-multi-session";
const HEADER_PURCHASE_CONTINUITY = "x-freebuff-purchase-continuity";
const HEADER_ATTEMPT = "x-freebuff-desktop-attempt-id";
const HEADER_TIMEZONE = "x-fb-timezone";

// Session/agent-run calls get the same 20s budget the official CLI gives them.
const SESSION_FETCH_TIMEOUT_MS = 20_000;
const SESSION_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 3_600_000;
const DISABLED_SESSION_TTL_MS = 300_000;
const QUEUED_RETRY_MIN_SEC = 1;
const QUEUED_RETRY_MAX_SEC = 30;
const REFUSAL_RETRY_AFTER_SEC = 30;
const MAX_CACHED_SESSIONS = 200;
const CLI_CLAIM_PREFIX = "cli:";

// Gate codes on /chat/completions that mean "your free session is gone": forget it and re-admit.
const SESSION_INVALID_CODES = new Set([
  "freebuff_update_required",
  "waiting_room_required",
  "waiting_room_queued",
  "session_superseded",
  "session_expired",
  "session_model_mismatch",
]);

// Session admission refusals surfaced with a fixed HTTP status when the upstream sent none.
// Capacity-style refusals map to 429 so combo/fallback logic moves on to another account.
const REFUSAL_STATUS = {
  country_blocked: 403,
  banned: 403,
  rate_limited: 429,
  spend_limited: 429,
  ip_capped: 429,
  premium_slot_taken: 429,
  purchase_in_use: 429,
  purchase_capacity: 429,
  consent_required: 409,
  model_unavailable: 409,
  purchase_claim_released: 409,
  first_tab_discount_changed: 409,
};

// In-memory free sessions: `${sha1(token)}:${model}` -> session entry. Never keyed by the raw token.
const sessions = new Map();
// Single in-flight admission per key so concurrent chat calls share one session request.
const inflightSessions = new Map();

// Relay pool URLs already warned about (one warning per relay per process).
const warnedRelays = new Set();

export class FreebuffHttpError extends Error {
  constructor(status, code, message, { retryAfterSec, upstream, type } = {}) {
    super(message);
    this.name = "FreebuffHttpError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.upstream = upstream;
    this.type = type;
  }

  toBody() {
    const error = { message: this.message, type: this.type || "freebuff_error", code: this.code };
    if (this.upstream !== undefined) error.upstream = this.upstream;
    return { error };
  }

  toResponse() {
    const headers = { "Content-Type": "application/json" };
    if (this.retryAfterSec) headers["Retry-After"] = String(this.retryAfterSec);
    return new Response(JSON.stringify(this.toBody()), { status: this.status, headers });
  }
}

function tokenOf(credentials) {
  const token = credentials?.accessToken || credentials?.apiKey;
  return typeof token === "string" ? token.trim() : "";
}

function sessionKey(token, model) {
  return `${createHash("sha1").update(token).digest("hex")}:${model}`;
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

// Read at request time (not import time) so a restart is enough to flip it.
function shouldFoldTools() {
  return isTruthyEnv("FREEBUFF_FOLD_TOOLS");
}

// 13-char base36 id, like the official SDK's Math.random().toString(36).substring(2, 15).
function generateClientId() {
  return Math.random().toString(36).slice(2, 15).padEnd(13, "0").slice(0, 13);
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Bare wire id: drops a provider prefix and a trailing thinking suffix such as "(high)".
function resolveModel(model) {
  const bare = String(model || "")
    .trim()
    .replace(/^(freebuff|codebuff|cb)\//, "")
    .replace(/\([^()]+\)\s*$/, "")
    .trim();
  return bare || DEFAULT_MODEL;
}

// Cloudflare-Worker (and the other relay pools) rewrite requests through a relay URL. 9router maps
// every relay pool type to proxyOptions.vercelRelayUrl and does not propagate the pool type, so
// any relay is dropped for Freebuff. Plain HTTP/SOCKS pools and env proxies are still honoured.
function directEgressOptions(proxyOptions, log) {
  const relay = proxyOptions?.vercelRelayUrl;
  if (!relay) return proxyOptions;
  if (!warnedRelays.has(relay)) {
    warnedRelays.add(relay);
    log?.warn?.("FREEBUFF", "Relay proxy pool ignored (Codebuff detects CF-Worker traffic); using direct egress");
  }
  const { vercelRelayUrl, ...rest } = proxyOptions;
  return rest;
}

function jsonHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": getUserAgent(),
    Accept: "application/json",
    ...extra,
  };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// One JSON round trip with the session timeout; never throws on HTTP status, only on transport.
async function callJson(url, { method, headers, body, signal }, proxyOptions) {
  const timeout = AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const init = { method, headers, signal: merged };
  if (body !== undefined) init.body = body;
  const resp = await proxyAwareFetch(url, init, proxyOptions);
  const text = await resp.text().catch(() => "");
  return { resp, status: resp.status, ok: resp.ok, text, data: parseJson(text) };
}

function retryAfterSecOf(resp, data) {
  const header = Number(resp?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const ms = Number(data?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  return undefined;
}

// Upstream error -> FreebuffHttpError keeping the upstream status and its machine-readable code.
function upstreamError(result, fallbackCode) {
  const { resp, status, data, text } = result;
  const code = (typeof data?.error === "string" && data.error) || data?.status || fallbackCode;
  const message =
    data?.message ||
    (typeof data?.error === "object" && data.error?.message) ||
    (text ? text.slice(0, 300) : `HTTP ${status}`);
  return new FreebuffHttpError(status, code, `Freebuff: ${message}`, {
    retryAfterSec: retryAfterSecOf(resp, data),
    upstream: data ?? (text ? text.slice(0, 300) : undefined),
  });
}

function queuedError(instanceId, position, queueDepth, retryAfterSec) {
  const where = position ? ` (position ${position}${queueDepth ? `/${queueDepth}` : ""})` : "";
  return new FreebuffHttpError(
    503,
    "waiting_room_queued",
    `Freebuff waiting room queued${where}, retry in about ${retryAfterSec}s`,
    { retryAfterSec, type: "server_error", upstream: { status: "queued", instanceId, position, queueDepth } },
  );
}

function sessionTtlMs(data) {
  const remaining = Number(data?.remainingMs);
  if (Number.isFinite(remaining) && remaining > 0) return remaining;
  const expires = Date.parse(data?.expiresAt || "");
  if (Number.isFinite(expires)) return Math.max(0, expires - Date.now());
  return DEFAULT_SESSION_TTL_MS;
}

function pruneSessions() {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if ((entry.expiresAt || entry.retryAtMs || 0) <= now) sessions.delete(key);
  }
}

function clearSessionCache(token = null, model = null) {
  if (token && model) {
    sessions.delete(sessionKey(token, model));
  } else if (token) {
    const prefix = `${sessionKey(token, "")}`;
    for (const key of sessions.keys()) if (key.startsWith(prefix)) sessions.delete(key);
  } else {
    sessions.clear();
  }
}

// Normalise one admission (or queue poll) answer into a session state or throw a FreebuffHttpError.
function interpretSession(result, model, claimId, multi) {
  const { status, ok, data, text } = result;
  const upstreamStatus = data?.status;

  if (upstreamStatus === "model_locked") {
    return { type: "model_locked", currentModel: data.currentModel, requestedModel: data.requestedModel || model };
  }
  if (ok && upstreamStatus === "active" && typeof data.instanceId === "string" && data.instanceId) {
    return {
      type: "active",
      instanceId: data.instanceId,
      model: data.model || model,
      ttlMs: sessionTtlMs(data),
      multi: multi && data.instanceId.startsWith(CLI_CLAIM_PREFIX),
    };
  }
  if (ok && upstreamStatus === "queued") {
    const waitSec = Math.ceil((Number(data.estimatedWaitMs) || 0) / 1000);
    const retryAfterSec = Math.min(Math.max(waitSec, QUEUED_RETRY_MIN_SEC), QUEUED_RETRY_MAX_SEC);
    return {
      type: "queued",
      instanceId: data.instanceId || claimId,
      position: data.position,
      queueDepth: data.queueDepth,
      retryAfterSec,
    };
  }
  if (ok && upstreamStatus === "disabled") return { type: "disabled" };
  if (ok && ["none", "ended", "superseded"].includes(upstreamStatus)) return { type: "restart", status: upstreamStatus };

  // A non-2xx answer keeps its upstream status (401, 403 country_blocked, 429, ...).
  if (!ok) {
    const error = upstreamError(result, upstreamStatus || "freebuff_session_failed");
    if (!error.retryAfterSec && [429, 503].includes(error.status)) error.retryAfterSec = REFUSAL_RETRY_AFTER_SEC;
    throw error;
  }
  // A refusal delivered inside a 2xx body still needs a real HTTP status for 9router's fallback logic.
  const refusalStatus = REFUSAL_STATUS[upstreamStatus];
  if (refusalStatus) {
    const error = upstreamError(result, upstreamStatus);
    error.status = refusalStatus;
    if (refusalStatus === 429 && !error.retryAfterSec) error.retryAfterSec = REFUSAL_RETRY_AFTER_SEC;
    throw error;
  }
  throw new FreebuffHttpError(502, "freebuff_session_failed", `Freebuff: unexpected session answer (${upstreamStatus || status})`, {
    upstream: data ?? text?.slice(0, 300),
  });
}

// POST the admission (CLI multi-session claim). Falls back to the legacy single-session route on
// 404/405 (servers without the dedicated admission route).
async function admitOnce(token, model, ctx) {
  const attemptId = randomUUID();
  const claimId = `${CLI_CLAIM_PREFIX}${attemptId}`;
  const headers = jsonHeaders(token, {
    [HEADER_TIMEZONE]: localTimeZone(),
    [HEADER_FIRST_TAB_DISCOUNT]: "0",
    [HEADER_MODEL]: model,
    [HEADER_WALLET_SPEND_LIMIT]: "0",
    [HEADER_MULTI_SESSION]: "1",
    [HEADER_PURCHASE_CONTINUITY]: "1",
    [HEADER_ATTEMPT]: attemptId,
    [HEADER_INSTANCE]: claimId,
  });
  let result = await callJson(SESSION_ADMISSION_URL, { method: "POST", headers, signal: ctx.signal }, ctx.proxyOptions);
  let multi = true;

  if (result.status === 404 || result.status === 405) {
    ctx.log?.debug?.("FREEBUFF", `Admission route answered ${result.status}, using legacy session route`);
    const legacyHeaders = jsonHeaders(token, { "Content-Type": "application/json", [HEADER_MODEL]: model });
    result = await callJson(
      SESSION_URL,
      { method: "POST", headers: legacyHeaders, body: "{}", signal: ctx.signal },
      ctx.proxyOptions,
    );
    multi = false;
    // No session route at all: the waiting room is off, chat needs no instance id.
    if (result.status === 404) return { type: "disabled" };
  }
  return interpretSession(result, model, claimId, multi);
}

// Poll a queued session by instance id (only used for servers that still queue).
async function pollQueued(token, entry, model, ctx) {
  const headers = jsonHeaders(token, { [HEADER_INSTANCE]: entry.instanceId });
  const result = await callJson(SESSION_URL, { method: "GET", headers, signal: ctx.signal }, ctx.proxyOptions);
  if (result.status === 404) return { type: "restart", status: "none" };
  return interpretSession(result, model, entry.instanceId, entry.instanceId.startsWith(CLI_CLAIM_PREFIX));
}

async function resolveSession(token, model, ctx, cached, allowModelLockRetry = true) {
  let state = cached?.type === "queued" ? await pollQueued(token, cached, model, ctx) : { type: "restart" };
  // "restart": the poll/admission says there is no usable row; POST a fresh admission (max 2 tries).
  for (let attempt = 0; state.type === "restart" && attempt < 2; attempt++) {
    state = await admitOnce(token, model, ctx);
  }

  if (state.type === "model_locked") {
    const locked = state.currentModel;
    if (allowModelLockRetry && locked && locked !== model && FREEBUFF_AGENT_ID_BY_MODEL[locked]) {
      ctx.log?.info?.("FREEBUFF", `Session locked to ${locked}; using it instead of ${model}`);
      const resolved = await resolveSession(token, locked, ctx, null, false);
      // Remember the lock under the requested model too, or every request would repeat the admission.
      const lockedEntry = sessions.get(sessionKey(token, locked));
      if (lockedEntry) sessions.set(sessionKey(token, model), lockedEntry);
      return { ...resolved, lockedFrom: model };
    }
    throw new FreebuffHttpError(409, "model_locked", `Freebuff: an active session is locked to ${locked || "another model"}`, {
      upstream: { status: "model_locked", currentModel: locked, requestedModel: model },
    });
  }
  if (state.type === "queued") {
    sessions.set(sessionKey(token, model), {
      type: "queued",
      instanceId: state.instanceId,
      retryAtMs: Date.now() + state.retryAfterSec * 1000,
      position: state.position,
      queueDepth: state.queueDepth,
      retryAfterSec: state.retryAfterSec,
    });
    throw queuedError(state.instanceId, state.position, state.queueDepth, state.retryAfterSec);
  }
  if (state.type === "disabled") {
    const entry = { type: "disabled", instanceId: "", model, multi: false, expiresAt: Date.now() + DISABLED_SESSION_TTL_MS };
    sessions.set(sessionKey(token, model), entry);
    return { instanceId: "", resolvedModel: model, multi: false };
  }
  if (state.type !== "active") {
    throw new FreebuffHttpError(502, "freebuff_session_failed", `Freebuff: could not open a free session (${state.status || state.type})`);
  }

  const expiresAt = Date.now() + Math.max(1000, state.ttlMs - SESSION_EXPIRY_MARGIN_MS);
  const entry = { type: "active", instanceId: state.instanceId, model: state.model, multi: state.multi, expiresAt };
  pruneSessions();
  sessions.set(sessionKey(token, model), entry);
  return { instanceId: entry.instanceId, resolvedModel: entry.model, multi: entry.multi };
}

// Session for (token, model): cached until near expiry; one shared in-flight admission per key.
async function getFreebuffSession(token, model = DEFAULT_MODEL, ctx = {}) {
  const key = sessionKey(token, model);
  const now = Date.now();
  const cached = sessions.get(key);
  if (cached?.type === "active" && now < cached.expiresAt) {
    return { instanceId: cached.instanceId, resolvedModel: cached.model, multi: cached.multi };
  }
  if (cached?.type === "disabled" && now < cached.expiresAt) {
    return { instanceId: "", resolvedModel: cached.model, multi: false };
  }
  if (cached?.type === "queued" && now < cached.retryAtMs) {
    throw queuedError(cached.instanceId, cached.position, cached.queueDepth, Math.max(1, Math.ceil((cached.retryAtMs - now) / 1000)));
  }

  let pending = inflightSessions.get(key);
  if (!pending) {
    // The admission is shared by every waiting request, so it must not die with the first caller's abort signal.
    const sharedCtx = { ...ctx, signal: undefined };
    pending = resolveSession(token, model, sharedCtx, cached).finally(() => inflightSessions.delete(key));
    inflightSessions.set(key, pending);
  }
  return pending;
}

async function startAgentRun(token, agentId, ctx = {}) {
  const result = await callJson(
    AGENT_RUNS_URL,
    {
      method: "POST",
      headers: jsonHeaders(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ action: "START", agentId, ancestorRunIds: [] }),
      signal: ctx.signal,
    },
    ctx.proxyOptions,
  );
  if (!result.ok) throw upstreamError(result, "agent_run_start_failed");
  if (!result.data?.runId) {
    throw new FreebuffHttpError(502, "agent_run_start_failed", "Freebuff: agent run START returned no runId", {
      upstream: result.data ?? undefined,
    });
  }
  return result.data.runId;
}

// Best effort: the call is issued synchronously, failures are swallowed.
function finishAgentRun(token, runId, status = "completed", ctx = {}, errorMessage = "") {
  if (!runId) return Promise.resolve();
  const payload = { action: "FINISH", runId, status, totalSteps: 1, directCredits: 0, totalCredits: 0, steps: [] };
  if (errorMessage) payload.errorMessage = String(errorMessage).slice(0, 5000);
  return callJson(
    AGENT_RUNS_URL,
    { method: "POST", headers: jsonHeaders(token, { "Content-Type": "application/json" }), body: JSON.stringify(payload) },
    ctx.proxyOptions,
  ).catch(() => {});
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return "";
}

// The first system message must START with the canonical opening (leading whitespace is tolerated).
// Inject it as its own leading message; never prepend to or wrap the caller's text.
function ensureRootOpening(messages) {
  const msgs = Array.isArray(messages) ? [...messages] : [];
  const first = msgs[0];
  if (first?.role === "system" && messageText(first.content).trimStart().startsWith(FREEBUFF_ROOT_OPENING)) {
    return msgs;
  }
  msgs.unshift({ role: "system", content: ROOT_SYSTEM_PROMPT });
  return msgs;
}

function buildToolNotice(tools) {
  const defs = tools
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      return `- ${fn.name}: ${fn.description || ""}\n  Parameters: ${JSON.stringify(fn.parameters || {})}`;
    })
    .filter(Boolean)
    .join("\n");
  return defs ? `[Available Tools]\nYou have access to the following tools if needed:\n${defs}` : "";
}

// Conservative JSON-schema clean-up: inline local $ref, collapse nullable anyOf/oneOf and
// ["x","null"] types. Schemas without those constructs are returned untouched.
const SCHEMA_MAX_DEPTH = 12;

function isNullSchema(schema) {
  return schema?.type === "null" || (Object.hasOwn(schema || {}, "const") && schema.const === null);
}

function normalizeSchema(node, defs, depth) {
  if (Array.isArray(node)) return node.map((item) => normalizeSchema(item, defs, depth - 1));
  if (!node || typeof node !== "object" || depth <= 0) return node;

  const scope = { ...defs, ...(node.definitions || {}), ...(node.$defs || {}) };
  const ref = typeof node.$ref === "string" ? node.$ref.match(/^#\/(?:definitions|\$defs)\/(.+)$/) : null;
  if (ref && scope[ref[1]] && Object.keys(node).length === 1) {
    return normalizeSchema(scope[ref[1]], scope, depth - 1);
  }

  let out = {};
  for (const [key, value] of Object.entries(node)) out[key] = normalizeSchema(value, scope, depth - 1);

  for (const key of ["anyOf", "oneOf"]) {
    if (!Array.isArray(out[key])) continue;
    const options = out[key].filter((option) => !isNullSchema(option));
    if (options.length === out[key].length) continue;
    if (options.length === 0) {
      delete out[key];
    } else if (options.length === 1 && options[0] && typeof options[0] === "object") {
      const { [key]: _dropped, ...rest } = out;
      out = { ...rest, ...options[0] };
    } else {
      out[key] = options;
    }
  }
  if (Array.isArray(out.type)) {
    const named = out.type.filter((t) => typeof t === "string" && t !== "null");
    if (named.length) out.type = named[0];
    else delete out.type;
  }
  return out;
}

function normalizeToolSchemas(tools) {
  return tools.map((tool) => {
    const params = tool?.function?.parameters;
    if (!params || typeof params !== "object") return tool;
    const raw = JSON.stringify(params);
    if (!raw.includes('"$ref"') && !raw.includes('"null"') && !raw.includes('"const":null')) return tool;
    return { ...tool, function: { ...tool.function, parameters: normalizeSchema(params, {}, SCHEMA_MAX_DEPTH) } };
  });
}

// Build the /chat/completions body. Caller fields are passed through (tools included) except the
// ones this handshake owns: model, messages, stream, codebuff_metadata and provider.
function buildChatBody(body, { model, runId, instanceId, multi, stream }) {
  const out = { ...(body || {}) };
  delete out.codebuff_metadata;
  delete out.provider;

  const messages = ensureRootOpening(out.messages);
  if (Array.isArray(out.tools) && out.tools.length > 0) {
    if (shouldFoldTools()) {
      const notice = buildToolNotice(out.tools);
      if (notice) messages.splice(1, 0, { role: "system", content: notice });
      delete out.tools;
      delete out.tool_choice;
      delete out.parallel_tool_calls;
    } else {
      out.tools = normalizeToolSchemas(out.tools);
    }
  }

  if (out.max_tokens == null && out.max_completion_tokens != null) out.max_tokens = out.max_completion_tokens;
  delete out.max_completion_tokens;

  const metadata = { run_id: runId, client_id: generateClientId(), cost_mode: "free" };
  if (instanceId) {
    metadata.freebuff_instance_id = instanceId;
    // Claims minted by admitOnce() live in the CLI multi-session store; the gate needs to know.
    if (multi) Object.assign(metadata, { freebuff_multi_session: "1", surface: "cli" });
  }

  return {
    ...out,
    model,
    messages,
    stream: stream !== false,
    codebuff_metadata: metadata,
    provider: { data_collection: "deny" },
  };
}

async function readErrorBody(response) {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

function isRetriableGateError(status, errText) {
  const data = parseJson(errText);
  const code = typeof data?.error === "string" ? data.error : "";
  if (code === "freebuff_update_required" || (code && SESSION_INVALID_CODES.has(code))) return true;
  // The run vanished server side (per-request runs make this rare); a fresh START fixes it.
  return status === 400 && /runid not (found|running)/i.test(errText);
}

// Finish the agent run when the response body ends, errors or is cancelled.
function wrapStreamWithCleanup(response, onDone) {
  if (!response.body) {
    onDone("completed");
    return response;
  }

  let done = false;
  const finish = (status, message) => {
    if (done) return;
    done = true;
    onDone(status, message);
  };

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          finish("completed");
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        finish("failed", err?.message);
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish("cancelled");
      return reader.cancel(reason);
    },
  });

  // fetch already decoded the body, so the original encoding/length headers no longer describe it.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

// Token check used by the dashboard "test connection" button: GET /session is free (no admission).
export async function probeFreebuffToken(token, proxyOptions = null, { signal } = {}) {
  if (!token) return { valid: false, status: 0, error: "No token" };
  try {
    const result = await callJson(SESSION_URL, { method: "GET", headers: jsonHeaders(token), signal }, directEgressOptions(proxyOptions));
    if (result.status === 401) return { valid: false, status: 401, error: "Token invalid or revoked" };
    // The token is fine but free mode refuses this account or this server's region.
    const refusal = result.data?.status;
    if (refusal === "country_blocked" || refusal === "banned") {
      return { valid: true, status: result.status, error: null, warning: `Token accepted, but Freebuff reports ${refusal} for this server` };
    }
    if (result.ok || result.status === 404) return { valid: true, status: result.status, error: null };
    return { valid: false, status: result.status, error: `API returned ${result.status}` };
  } catch (err) {
    return { valid: false, status: 0, error: err.message };
  }
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { baseUrl: CHAT_URL });
  }

  buildUrl() {
    return CHAT_URL;
  }

  buildHeaders(credentials, stream = true) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenOf(credentials)}`,
      "User-Agent": getUserAgent(),
      Accept: stream ? "text/event-stream" : "application/json",
    };
  }

  transformRequest(model, body, stream) {
    return buildChatBody(body, { model: resolveModel(model), runId: undefined, instanceId: "", multi: false, stream });
  }

  // Surface Codebuff's machine-readable code ("free_mode_cli_required", "country_blocked", ...).
  parseError(response, bodyText) {
    const data = parseJson(bodyText);
    let message = bodyText || `HTTP ${response.status}`;
    if (data) {
      const code = (typeof data.error === "string" && data.error) || data.error?.code || data.status || "";
      const text = data.message || data.error?.message || "";
      message = [code, text].filter(Boolean).join(": ") || message;
    }
    return { status: response.status, message };
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();
    const headers = this.buildHeaders(credentials, stream);
    const fail = (error) => ({ response: error.toResponse(), url, headers, transformedBody: error.toBody() });

    const token = tokenOf(credentials);
    if (!token) {
      return fail(new FreebuffHttpError(401, "unauthorized", "Freebuff requires an auth token", { type: "authentication_error" }));
    }

    const targetModel = resolveModel(model);
    if (!FREEBUFF_AGENT_ID_BY_MODEL[targetModel]) {
      const supported = Object.keys(FREEBUFF_AGENT_ID_BY_MODEL).join(", ");
      return fail(
        new FreebuffHttpError(400, "model_not_supported", `Unsupported Freebuff model "${targetModel}". Supported: ${supported}`, {
          type: "invalid_request_error",
        }),
      );
    }

    const ctx = { proxyOptions: directEgressOptions(proxyOptions, log), signal, log };

    for (let attempt = 0; attempt < 2; attempt++) {
      let session;
      let runId = null;
      let startFailed = false;
      try {
        session = await getFreebuffSession(token, targetModel, ctx);
        const agentId = FREEBUFF_AGENT_ID_BY_MODEL[session.resolvedModel];
        if (!agentId) {
          throw new FreebuffHttpError(
            502,
            "model_not_supported",
            `Freebuff served the session on "${session.resolvedModel}", which this proxy cannot run`,
          );
        }
        startFailed = true;
        runId = await startAgentRun(token, agentId, ctx);
        startFailed = false;
      } catch (err) {
        if (err instanceof FreebuffHttpError) {
          // A START that reports a dead session (not our own queued answer) gets one fresh admission.
          if (startFailed && attempt === 0 && SESSION_INVALID_CODES.has(err.code)) {
            log?.debug?.("FREEBUFF", `Agent run START reported ${err.code}, re-admitting`);
            clearSessionCache(token, targetModel);
            continue;
          }
          log?.debug?.("FREEBUFF", `Session/run initialization refused (${err.status} ${err.code})`);
          return fail(err);
        }
        throw err;
      }

      const transformedBody = buildChatBody(body, {
        model: session.resolvedModel,
        runId,
        instanceId: session.instanceId,
        multi: session.multi,
        stream,
      });
      const bodyStr = JSON.stringify(transformedBody);
      log?.debug?.("FETCH", `FREEBUFF -> ${url} | model=${session.resolvedModel} runId=${runId} | body=${bodyStr.length}B`);

      // Abort if upstream doesn't return response headers within the connection timeout.
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      let response;
      try {
        response = await proxyAwareFetch(url, { method: "POST", headers, body: bodyStr, signal: mergedSignal }, ctx.proxyOptions);
      } catch (error) {
        clearTimeout(connectTimer);
        void finishAgentRun(token, runId, "failed", ctx, error.message);
        if (connectCtrl.signal.aborted && error.name === "AbortError" && !signal?.aborted) {
          throw new Error("Freebuff fetch connect timeout");
        }
        throw error;
      }
      clearTimeout(connectTimer);

      if (!response.ok) {
        const errText = await readErrorBody(response);
        void finishAgentRun(token, runId, "failed", ctx, `${response.status} ${errText.slice(0, 200)}`);
        if (attempt === 0 && isRetriableGateError(response.status, errText)) {
          log?.debug?.("FREEBUFF", `Session gate rejected the request (${response.status}), re-admitting`);
          clearSessionCache(token, targetModel);
          continue;
        }
        return { response, url, headers, transformedBody };
      }

      const wrapped = wrapStreamWithCleanup(response, (status, message) => {
        void finishAgentRun(token, runId, status, ctx, message);
      });
      return { response: wrapped, url, headers, transformedBody };
    }

    throw new Error("Freebuff execution failed");
  }
}

export const __test__ = {
  getFreebuffSession,
  startAgentRun,
  finishAgentRun,
  ensureRootOpening,
  buildChatBody,
  buildToolNotice,
  normalizeToolSchemas,
  wrapStreamWithCleanup,
  directEgressOptions,
  generateClientId,
  clearSessionCache,
  resolveModel,
  tokenOf,
  sessions,
  warnedRelays,
  ROOT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_USER_AGENT,
  BASE_URL,
  CHAT_URL,
  AGENT_RUNS_URL,
  SESSION_URL,
  SESSION_ADMISSION_URL,
};

export default FreebuffExecutor;
