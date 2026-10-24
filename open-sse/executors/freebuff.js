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
 *   4. POST /api/v1/agent-runs {action:"FINISH"} for a run that is done (best effort)
 *
 * Session and run lifecycle (in-memory, per token):
 *   - One free session per token. A request for another model first releases the old session
 *     (DELETE /api/v1/freebuff/session/attempt), otherwise a `limited` tier with slotLimit 1 keeps the
 *     old slot for an hour and the next admission fails with purchase_capacity.
 *   - One agent run per (token, agent), reused across requests and rotated after
 *     FREEBUFF_RUN_ROTATION_MS (default 6h). A rotated run drains: FINISH goes out once its last
 *     in-flight request is done. FREEBUFF_RUN_ROTATION_MS=0 restores START/FINISH on every request.
 *
 * Egress must be direct: Codebuff detects the CF-Worker header Cloudflare stamps on Worker
 * subrequests, so relay pools (Cloudflare/Vercel/Deno) are ignored for this provider.
 */

const BASE_URL = "https://www.codebuff.com";
const CHAT_URL = `${BASE_URL}/api/v1/chat/completions`;
const AGENT_RUNS_URL = `${BASE_URL}/api/v1/agent-runs`;
const SESSION_URL = `${BASE_URL}/api/v1/freebuff/session`;
const SESSION_ADMISSION_URL = `${BASE_URL}/api/v1/freebuff/session/admission`;
const SESSION_ATTEMPT_URL = `${BASE_URL}/api/v1/freebuff/session/attempt`;

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
const DEFAULT_RUN_ROTATION_MS = 6 * 3_600_000;
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

// In-memory free sessions: sha1(token) -> session entry, one per token. Never keyed by the raw token.
const sessions = new Map();
// Single in-flight admission per token ({ model, promise }) so concurrent chat calls share one session request.
const inflightSessions = new Map();

// Agent runs reused across requests: `${sha1(token)}:${agentId}` -> run entry.
const activeRuns = new Map();
// Rotated or retired runs waiting for their last in-flight request before FINISH.
const drainingRuns = new Set();
// Single in-flight START per run key so concurrent requests share one agent run.
const inflightRunStarts = new Map();

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

function sessionKey(token) {
  return createHash("sha1").update(token).digest("hex");
}

function runKey(token, agentId) {
  return `${sessionKey(token)}:${agentId}`;
}

// Read at request time (not import time) so a restart is enough to flip it. 0 = a run per request.
function runRotationMs() {
  const raw = String(process.env.FREEBUFF_RUN_ROTATION_MS ?? "").trim();
  if (!raw) return DEFAULT_RUN_ROTATION_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_RUN_ROTATION_MS;
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

// Forget a session the upstream reports as gone (nothing to release). With an instance id only that
// session is dropped, so a stale failure cannot wipe the fresh session a model switch just opened.
function clearSessionCache(token = null, instanceId = null) {
  if (!token) {
    sessions.clear();
    return;
  }
  const key = sessionKey(token);
  if (instanceId && sessions.get(key)?.instanceId !== instanceId) return;
  sessions.delete(key);
}

function clearRunCache() {
  activeRuns.clear();
  drainingRuns.clear();
  inflightRunStarts.clear();
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
  const state = interpretSession(result, model, claimId, multi);
  // Releasing the claim later must send the very pair of ids this admission used.
  if (multi && (state.type === "active" || state.type === "queued")) Object.assign(state, { attemptId, claimId });
  return state;
}

// Poll a queued session by instance id (only used for servers that still queue).
async function pollQueued(token, entry, model, ctx) {
  const headers = jsonHeaders(token, { [HEADER_INSTANCE]: entry.instanceId });
  const result = await callJson(SESSION_URL, { method: "GET", headers, signal: ctx.signal }, ctx.proxyOptions);
  if (result.status === 404) return { type: "restart", status: "none" };
  return interpretSession(result, model, entry.instanceId, entry.instanceId.startsWith(CLI_CLAIM_PREFIX));
}

async function resolveSession(token, model, ctx, cached, allowModelLockRetry = true) {
  const key = sessionKey(token);
  let state = cached?.type === "queued" ? await pollQueued(token, cached, model, ctx) : { type: "restart" };
  // "restart": the poll/admission says there is no usable row; POST a fresh admission (max 2 tries).
  for (let attempt = 0; state.type === "restart" && attempt < 2; attempt++) {
    state = await admitOnce(token, model, ctx);
  }

  if (state.type === "model_locked") {
    const locked = state.currentModel;
    if (allowModelLockRetry && locked && locked !== model && FREEBUFF_AGENT_ID_BY_MODEL[locked]) {
      ctx.log?.info?.("FREEBUFF", `Session locked to ${locked}; using it instead of ${model}`);
      try {
        const resolved = await resolveSession(token, locked, ctx, null, false);
        return { ...resolved, lockedFrom: model };
      } finally {
        // Remember the lock under the requested model too, or every request would repeat the admission.
        const lockedEntry = sessions.get(key);
        if (lockedEntry?.model === locked) lockedEntry.serves.add(model);
      }
    }
    throw new FreebuffHttpError(409, "model_locked", `Freebuff: an active session is locked to ${locked || "another model"}`, {
      upstream: { status: "model_locked", currentModel: locked, requestedModel: model },
    });
  }

  // Models this entry answers for: the requested one (also across a queue poll) and the one it really runs.
  const serves = new Set([model, ...(cached?.type === "queued" ? cached.serves : [])]);
  // The claim ids come from the admission, or from the queued claim a poll just promoted.
  const claimSource = state.attemptId ? state : cached?.type === "queued" ? cached : null;
  const claim = claimSource ? { attemptId: claimSource.attemptId, claimId: claimSource.claimId } : {};

  if (state.type === "queued") {
    sessions.set(key, {
      type: "queued",
      model,
      serves,
      instanceId: state.instanceId,
      retryAtMs: Date.now() + state.retryAfterSec * 1000,
      position: state.position,
      queueDepth: state.queueDepth,
      retryAfterSec: state.retryAfterSec,
      ...claim,
    });
    throw queuedError(state.instanceId, state.position, state.queueDepth, state.retryAfterSec);
  }
  if (state.type === "disabled") {
    const entry = { type: "disabled", instanceId: "", model, serves, multi: false, expiresAt: Date.now() + DISABLED_SESSION_TTL_MS };
    sessions.set(key, entry);
    return { instanceId: "", resolvedModel: model, multi: false };
  }
  if (state.type !== "active") {
    throw new FreebuffHttpError(502, "freebuff_session_failed", `Freebuff: could not open a free session (${state.status || state.type})`);
  }

  const expiresAt = Date.now() + Math.max(1000, state.ttlMs - SESSION_EXPIRY_MARGIN_MS);
  serves.add(state.model);
  const entry = { type: "active", instanceId: state.instanceId, model: state.model, serves, multi: state.multi, expiresAt, ...claim };
  pruneSessions();
  sessions.set(key, entry);
  return { instanceId: entry.instanceId, resolvedModel: entry.model, multi: entry.multi };
}

// Give the slot of a free session back before another model is admitted: DELETE /session/attempt with
// the claim's own attempt/instance headers (the refund is automatic). Best effort: a failure is logged
// and never fails the request that triggered the switch.
async function releaseSession(token, entry, nextModel, ctx) {
  const key = sessionKey(token);
  if (sessions.get(key) === entry) sessions.delete(key);
  ctx.log?.info?.("FREEBUFF", `Releasing the ${entry.model} session before admitting ${nextModel}`);
  // The old session's runs are not going to be used again; end them once their requests are done.
  if (entry.type === "active") retireRuns(token, FREEBUFF_AGENT_ID_BY_MODEL[entry.model]);
  // Claims from the legacy session route carry no attempt id and cannot be released this way.
  if (!entry.attemptId) return;
  const headers = jsonHeaders(token, { [HEADER_ATTEMPT]: entry.attemptId, [HEADER_INSTANCE]: entry.claimId });
  try {
    const result = await callJson(SESSION_ATTEMPT_URL, { method: "DELETE", headers }, ctx.proxyOptions);
    if (!result.ok && result.status !== 404) {
      ctx.log?.warn?.("FREEBUFF", `Releasing the ${entry.model} session answered ${result.status}`);
    }
  } catch (err) {
    ctx.log?.warn?.("FREEBUFF", `Releasing the ${entry.model} session failed: ${err?.message || err}`);
  }
}

// Session for a token: cached until near expiry; one shared in-flight admission per token. The token
// owns a single session, so asking for a model it does not serve releases the old one first.
async function getFreebuffSession(token, model = DEFAULT_MODEL, ctx = {}) {
  const key = sessionKey(token);
  for (;;) {
    const pending = inflightSessions.get(key);
    if (pending && pending.model !== model) {
      // A switch to another model is under way: let it settle, then judge against what it left behind.
      await pending.promise.catch(() => {});
      continue;
    }

    const now = Date.now();
    const cached = sessions.get(key);
    const serves = cached?.serves.has(model) === true;
    if (serves && cached.type === "active" && now < cached.expiresAt) {
      return { instanceId: cached.instanceId, resolvedModel: cached.model, multi: cached.multi };
    }
    if (serves && cached.type === "disabled" && now < cached.expiresAt) {
      return { instanceId: "", resolvedModel: cached.model, multi: false };
    }
    if (serves && cached.type === "queued" && now < cached.retryAtMs) {
      throw queuedError(cached.instanceId, cached.position, cached.queueDepth, Math.max(1, Math.ceil((cached.retryAtMs - now) / 1000)));
    }
    if (pending) return pending.promise;

    // The admission is shared by every waiting request, so it must not die with the first caller's abort signal.
    const sharedCtx = { ...ctx, signal: undefined };
    const promise = (async () => {
      if (cached && !serves) await releaseSession(token, cached, model, sharedCtx);
      return resolveSession(token, model, sharedCtx, serves ? cached : null);
    })().finally(() => inflightSessions.delete(key));
    inflightSessions.set(key, { model, promise });
    return promise;
  }
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
function finishAgentRun(token, runId, status = "completed", ctx = {}, errorMessage = "", { totalSteps = 1 } = {}) {
  if (!runId) return Promise.resolve();
  const payload = { action: "FINISH", runId, status, totalSteps, directCredits: 0, totalCredits: 0, steps: [] };
  if (errorMessage) payload.errorMessage = String(errorMessage).slice(0, 5000);
  return callJson(
    AGENT_RUNS_URL,
    { method: "POST", headers: jsonHeaders(token, { "Content-Type": "application/json" }), body: JSON.stringify(payload) },
    ctx.proxyOptions,
  ).catch(() => {});
}

// FINISH a run that is no longer current once its last in-flight request is done.
function finishIfReady(run) {
  if (run.dead || run.finishing || run.inflight > 0 || activeRuns.get(run.key) === run) return;
  run.finishing = true;
  drainingRuns.delete(run);
  void finishAgentRun(run.token, run.id, "completed", { proxyOptions: run.proxyOptions }, "", { totalSteps: run.requestCount });
}

// Stop handing out the run of this agent; it drains and FINISHes after its in-flight requests.
function retireRuns(token, agentId) {
  const key = runKey(token, agentId);
  const run = activeRuns.get(key);
  if (!run) return;
  activeRuns.delete(key);
  drainingRuns.add(run);
  finishIfReady(run);
}

// START a run and make it the current one for its (token, agent); the run it replaces starts draining.
async function startManagedRun(token, agentId, key, ctx) {
  const id = await startAgentRun(token, agentId, ctx);
  const run = { id, key, token, agentId, proxyOptions: ctx.proxyOptions, startedAt: Date.now(), inflight: 0, requestCount: 0 };
  const previous = activeRuns.get(key);
  activeRuns.set(key, run);
  if (previous) {
    ctx.log?.debug?.("FREEBUFF", `Agent run ${previous.id} rotated out after ${previous.requestCount} request(s), now ${id}`);
    drainingRuns.add(previous);
    finishIfReady(previous);
  }
  return run;
}

// A run for one request: { runId, release(status, message), invalidate() }. release() is idempotent.
// By default the run is shared with the other requests of this token and agent (see the header);
// with FREEBUFF_RUN_ROTATION_MS=0 every request gets its own START and FINISH.
async function acquireAgentRun(token, agentId, ctx = {}) {
  const rotationMs = runRotationMs();
  if (rotationMs === 0) {
    const runId = await startAgentRun(token, agentId, ctx);
    let released = false;
    return {
      runId,
      release(status, message) {
        if (released) return;
        released = true;
        void finishAgentRun(token, runId, status, ctx, message);
      },
      invalidate() {},
    };
  }

  const key = runKey(token, agentId);
  let run = activeRuns.get(key);
  if (!run || Date.now() - run.startedAt >= rotationMs) {
    let pending = inflightRunStarts.get(key);
    if (!pending) {
      // The START is shared by every waiting request, so it must not die with the first caller's abort signal.
      const sharedCtx = { ...ctx, signal: undefined };
      // A failed START is not cached: the entry only becomes the current run once START answered.
      pending = startManagedRun(token, agentId, key, sharedCtx).finally(() => inflightRunStarts.delete(key));
      inflightRunStarts.set(key, pending);
    }
    run = await pending;
  }

  run.inflight++;
  run.requestCount++;
  run.proxyOptions = ctx.proxyOptions;
  let released = false;
  return {
    runId: run.id,
    release() {
      if (released) return;
      released = true;
      run.inflight = Math.max(0, run.inflight - 1);
      finishIfReady(run);
    },
    // The upstream no longer knows this run: nobody reuses it and there is nothing left to FINISH.
    invalidate() {
      run.dead = true;
      if (activeRuns.get(run.key) === run) activeRuns.delete(run.key);
      drainingRuns.delete(run);
    },
  };
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

// What a rejected chat call asks us to renew before one retry: "session" (re-admit), "run" (fresh
// START, the session is fine) or null (pass the error through).
function gateRetryKind(status, errText) {
  const data = parseJson(errText);
  const code = typeof data?.error === "string" ? data.error : "";
  if (code === "freebuff_update_required" || (code && SESSION_INVALID_CODES.has(code))) return "session";
  // The run vanished server side (a long-lived run can expire); a fresh START fixes it.
  if (status === 400 && /runid not (found|running)/i.test(errText)) return "run";
  return null;
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
      let lease = null;
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
        lease = await acquireAgentRun(token, agentId, ctx);
        startFailed = false;
      } catch (err) {
        if (err instanceof FreebuffHttpError) {
          // A START that reports a dead session (not our own queued answer) gets one fresh admission.
          if (startFailed && attempt === 0 && SESSION_INVALID_CODES.has(err.code)) {
            log?.debug?.("FREEBUFF", `Agent run START reported ${err.code}, re-admitting`);
            clearSessionCache(token, session.instanceId);
            continue;
          }
          log?.debug?.("FREEBUFF", `Session/run initialization refused (${err.status} ${err.code})`);
          return fail(err);
        }
        throw err;
      }

      const runId = lease.runId;
      let transformedBody;
      let bodyStr;
      try {
        transformedBody = buildChatBody(body, {
          model: session.resolvedModel,
          runId,
          instanceId: session.instanceId,
          multi: session.multi,
          stream,
        });
        bodyStr = JSON.stringify(transformedBody);
      } catch (error) {
        lease.release("failed", error.message);
        throw error;
      }
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
        lease.release("failed", error.message);
        if (connectCtrl.signal.aborted && error.name === "AbortError" && !signal?.aborted) {
          throw new Error("Freebuff fetch connect timeout");
        }
        throw error;
      }
      clearTimeout(connectTimer);

      if (!response.ok) {
        const errText = await readErrorBody(response);
        const retry = attempt === 0 ? gateRetryKind(response.status, errText) : null;
        if (retry === "run") lease.invalidate();
        lease.release("failed", `${response.status} ${errText.slice(0, 200)}`);
        if (retry) {
          log?.debug?.("FREEBUFF", `Chat gate rejected the request (${response.status}), renewing the ${retry}`);
          if (retry === "session") clearSessionCache(token, session.instanceId);
          continue;
        }
        return { response, url, headers, transformedBody };
      }

      const wrapped = wrapStreamWithCleanup(response, (status, message) => lease.release(status, message));
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
  clearRunCache,
  runRotationMs,
  resolveModel,
  tokenOf,
  sessions,
  activeRuns,
  drainingRuns,
  warnedRelays,
  ROOT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_USER_AGENT,
  DEFAULT_RUN_ROTATION_MS,
  BASE_URL,
  CHAT_URL,
  AGENT_RUNS_URL,
  SESSION_URL,
  SESSION_ADMISSION_URL,
  SESSION_ATTEMPT_URL,
};

export default FreebuffExecutor;
