import { createHash, randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  FreebuffDeviceKeyManager,
  isDeviceKeyError,
  DEVICE_KEY_HEADER,
  DEVICE_SIG_HEADER,
  DEVICE_TS_HEADER,
} from "../utils/freebuffDeviceKey.js";
import {
  getFreebuffCatalog,
  cachedFetchId,
  invalidateFreebuffCatalog,
  resolveAdmissionModel,
  resolveCatalogKey,
  freebuffHandleFor,
  tokenHashOf,
  CATALOG_URL,
  DEVICE_KEYS_URL,
  FREEBUFF_API_BASE,
  CATALOG_FETCH_HEADER,
  CLIENT_CLI,
  CLIENT_DESKTOP,
} from "../utils/freebuffCatalog.js";
import {
  resolveFreebuffAgent,
  neutralizeSystemPromptMarkers,
  packToolsForFreebuff,
  alignHistoryToolNames,
  createCarrierSseTransform,
  unpackCarrierToolCalls,
  resolveCostMode,
  CARRIER_PLAN_SYMBOL,
} from "../utils/freebuffFreeMode.js";

/**
 * Freebuff (codebuff.com) free-mode executor.
 *
 * The chat endpoint only answers a "CLI-like" handshake. Protocol taken from the official
 * Freebuff CLI 0.2.34 (device-key Ed25519 signing, model catalog + fetchId binding, per-endpoint
 * user agents); see ~/fb-proto-20261027/REPORT-CLI.md for the reconstruction.
 *   0. Ensure an Ed25519 device key exists for the token and is registered (POST freebuff.com
 *      /api/v1/freebuff/device-keys, persisted on the provider connection), then fetch the signed
 *      model catalog (GET /api/v1/freebuff/models) and keep its fetchId.
 *   1. POST /api/v1/freebuff/session/admission (codebuff.com, signed; x-freebuff-model +
 *      x-freebuff-wallet-spend-limit: "session", no client-minted instance id) -> session
 *      { instanceId (server-assigned), model, remainingMs }
 *   2. POST /api/v1/agent-runs {action:"START"} -> runId (agent id resolved from the model)
 *   3. POST /api/v1/chat/completions (signed; ai-sdk UA, x-freebuff-sse-gzip-recovery,
 *      x-freebuff-catalog-fetch) with codebuff_metadata {run_id, client_id,
 *      freebuff_instance_id, freebuff_client_env} and a leading system message that opens with
 *      the canonical Buffy prompt
 *   4. POST /api/v1/agent-runs {action:"FINISH"} for a run that is done (best effort)
 *
 * Session and run lifecycle (in-memory, per token):
 *   - One free session per token. A request for another model first releases the old session
 *     (DELETE /api/v1/freebuff/session with the assigned instance id, signed), otherwise a
 *     `limited` tier with slotLimit 1 keeps the old slot for an hour and the next admission
 *     fails with purchase_capacity. An idle session is released after FREEBUFF_SESSION_IDLE_MS
 *     (default 10 minutes) so the single slot does not stay occupied.
 *   - One agent run per (token, agent), reused across requests and rotated after
 *     FREEBUFF_RUN_ROTATION_MS (default 6h). A rotated run drains: FINISH goes out once its last
 *     in-flight request is done. FREEBUFF_RUN_ROTATION_MS=0 restores START/FINISH on every request.
 *
 * Device-key signing covers chat, session calls and the catalog (string-to-sign
 * "freebuff-device-v1\n..." with the catalog fetchId); agent-runs stay Bearer-only, like the CLI.
 *
 * Second execution lane (Desktop 0.0.188 protocol, see ~/fb-desktop-20261027/REPORT-DESKTOP.md).
 * EXPERIMENTAL: the live probe (2026-10-27) saw the desktop admission answer 409
 * freebuff_catalog_stale twice despite a fresh catalog fetch — root cause unknown, so the lane
 * stays opt-in (default remains cli-chat) and admissions are logged at debug level.
 * connections with providerSpecificData.freebuffExecMode = "cloud-run" (or env
 * FREEBUFF_EXEC_MODE=cloud-run) skip /chat/completions entirely and ride the hosted path:
 *   a. Same device key machinery, but registered with client:"desktop" (separate keypair).
 *   b. Signed catalog with x-freebuff-client: desktop; the model id becomes an opaque
 *      "m-xxxxxxxxxx" handle (deterministic fnv32a-double digest, reproduced verbatim).
 *   c. Signed desktop admission (x-freebuff-client/-install-id, multi-session, instance id).
 *   d. POST /api/v1/cloud/runs (Bearer only — cloud runs are NOT device-signed in 0.0.188) and
 *      JSON polling of GET /api/v1/cloud/runs/{id}?after=<cursor>; chunk events are adapted into
 *      an OpenAI-shaped chat response (SSE frames when the caller asked for a stream).
 *
 * Egress must be direct: Codebuff detects the CF-Worker header Cloudflare stamps on Worker
 * subrequests, so relay pools (Cloudflare/Vercel/Deno) are ignored for this provider.
 */

const BASE_URL = "https://www.codebuff.com";
const CHAT_URL = `${BASE_URL}/api/v1/chat/completions`;
const AGENT_RUNS_URL = `${BASE_URL}/api/v1/agent-runs`;
const SESSION_URL = `${BASE_URL}/api/v1/freebuff/session`;
const SESSION_ADMISSION_URL = `${BASE_URL}/api/v1/freebuff/session/admission`;
const SESSION_ATTEMPT_URL = `${SESSION_URL}/attempt`;
const CLOUD_RUNS_URL = `${BASE_URL}/api/v1/cloud/runs`;

// Desktop lane identity (REPORT-DESKTOP.md §9). The install id is derived deterministically from
// the token so it survives restarts without extra persistence.
const DEFAULT_DESKTOP_VERSION = "0.0.188";
const CLOUD_QUESTIONS_HEADER = "x-freebuff-cloud-questions";
const PRODUCT_CONTEXT_HEADER = "X-Freebuff-Product-Context";
const HEADER_INSTALL_ID = "x-freebuff-install-id";
const HEADER_CLIENT = "x-freebuff-client";
const CLOUD_POLL_INTERVAL_MS_DEFAULT = 500;
const CLOUD_RUN_TIMEOUT_MS_DEFAULT = 120_000;

function desktopVersion() {
  return process.env.FREEBUFF_DESKTOP_VERSION || DEFAULT_DESKTOP_VERSION;
}

function desktopUserAgent() {
  return `Freebuff-Desktop/${desktopVersion()}`;
}

function installIdFor(token) {
  const hex = createHash("sha256").update(`freebuff-install:${token}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Execution lane per connection: providerSpecificData.freebuffExecMode wins, then the global env
// default. "cli-chat" rides /chat/completions, "cloud-run" rides the desktop hosted path.
function resolveExecMode(credentials = {}) {
  const raw = String(credentials?.providerSpecificData?.freebuffExecMode || process.env.FREEBUFF_EXEC_MODE || "cli-chat").trim();
  return raw === "cloud-run" ? "cloud-run" : "cli-chat";
}

function laneFor(mode) {
  return mode === "cloud-run" ? CLIENT_DESKTOP : CLIENT_CLI;
}

// Session/catalog headers shared by every Freebuff CLI call.
const HEADER_INSTANCE = "x-freebuff-instance-id";
const HEADER_MODEL = "x-freebuff-model";
const HEADER_WALLET_SPEND_LIMIT = "x-freebuff-wallet-spend-limit";
const HEADER_MULTI_SESSION = "x-freebuff-multi-session";
const HEADER_PURCHASE_CONTINUITY = "x-freebuff-purchase-continuity";
const HEADER_ATTEMPT = "x-freebuff-desktop-attempt-id";
const HEADER_TIMEZONE = "x-fb-timezone";
const HEADER_ENV = "x-freebuff-env";
const HEADER_CLIENT_VERSION = "x-freebuff-client-version";
const HEADER_CATALOG_PROTOCOL = "x-freebuff-catalog-protocol";
const HEADER_HEARTBEAT = "x-freebuff-heartbeat";
const HEADER_INCLUDE_UNUSED_RATE_LIMITS = "x-freebuff-include-unused-rate-limits";
const HEADER_COMPACT_SESSION = "x-freebuff-compact-session";
const HEADER_GZIP_RECOVERY = "x-freebuff-sse-gzip-recovery";
const HEADER_ACTING_USER = "x-freebuff-acting-user-id";
const CLI_CLAIM_PREFIX = "cli:";

// Chat UA mirrors the ai-sdk openai-compatible provider; session calls use the CLI UA. The
// 0.2.34 linux-x64 binary ships MV="0.0.0-test" verbatim (release builds may inject another
// value), so that is the default; both are env-tunable.
const DEFAULT_CLI_VERSION = "0.2.34";
const DEFAULT_AISDK_VERSION = "0.0.0-test";

function cliVersion() {
  return process.env.FREEBUFF_CLI_VERSION || DEFAULT_CLI_VERSION;
}

function aiSdkVersion() {
  return process.env.FREEBUFF_AISDK_VERSION || DEFAULT_AISDK_VERSION;
}

function chatUserAgent() {
  return process.env.FREEBUFF_USER_AGENT || `ai-sdk/openai-compatible/${aiSdkVersion()}/codebuff`;
}

function sessionUserAgent() {
  return `Freebuff-CLI/${cliVersion()}`;
}

// Synthetic stand-in for the CLI terminal fingerprint (x-freebuff-env / freebuff_client_env,
// "v1;k=v;..." shape). A server has no TTY, so the values describe a plain node run; override
// with FREEBUFF_CLIENT_ENV when a capture of a real CLI is available.
function clientEnv() {
  const override = process.env.FREEBUFF_CLIENT_ENV;
  if (override) return override;
  const tz = process.env.TZ;
  const parts = [
    "v1",
    "in=1",
    "out=1",
    "tp=none",
    "term=1",
    "ct=1",
    "sz=80x24",
    "ci=0",
    "ssh=0",
    "l=node",
    "p=node",
    "g=node",
    "osc=na",
    `tzo=${tz ? 1 : 0}`,
    "px=0",
    "tls=0",
    "ca=0",
    "cde=0",
  ];
  if (tz) parts.push(`stz=${tz}`);
  return parts.join(";");
}

// Fallback model = FALLBACK_FREEBUFF_MODEL_ID upstream (unmetered, always open).
const DEFAULT_MODEL = "mimo/mimo-v2.5";

// The server does a byte-exact prefix check on the FIRST system message of a free-mode request
// (FREEBUFF_ROOT_SYSTEM_PROMPT_OPENINGS). base2 agents pair with the base2/Freebuff opening.
export const FREEBUFF_ROOT_OPENING = "You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free.";
const ROOT_SYSTEM_PROMPT =
  `${FREEBUFF_ROOT_OPENING} See freebuff.com for more information about the product.`;

// Model -> free-mode agent id (all base2 generation). Server accepts base2 IDs only as of 2026-10-31.
export const FREEBUFF_AGENT_ID_BY_MODEL = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.6-pro": "base2-free-mimo-2-6-pro",
  "mimo/mimo-v2.6-flash": "base2-free-mimo",
  "mimo/mimo-v2.6-flash-fast": "base2-free-mimo",
  "mimo/mimo-v2.6-flash-slow": "base2-free-mimo",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "z-ai/glm-5.2": "base2-free-glm",
  "z-ai/glm-5.3": "base2-free-glm-5-3",
  "z-ai/glm-5.3-prime": "base2-free-glm-5-3-prime",
  "z-ai/glm-5-turbo": "base2-free-glm-5-turbo",
  "z-ai/glm-5.3-flashx": "base2-free-glm-5-3-flashx",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-flash-fast": "base2-free-deepseek-flash-fast",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4.1-flash": "base2-free-deepseek-v4-1-flash",
  "deepseek/deepseek-v4.1-flash-fast": "base2-free-deepseek-flash-fast",
  "deepseek/deepseek-v4.1-flash-slow": "base2-free-deepseek-v4-1-flash",
  "openai/gpt-6-luna": "base2-free-luna-6",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "openai/gpt-5.6-luna-es": "base2-free-luna-es",
  "openai/gpt-6.1-sol": "base2-free-gpt-6-1-sol",
  "openai/gpt-6.1-terra": "base2-free-gpt-6-1-terra",
  "openai/gpt-6-sol": "base2-free-gpt-6-sol",
  "google/gemini-3.8-flash": "base2-free-gemini-3-8-flash",
  "google/gemini-4-argon": "base2-free-gemini-4-argon",
  "upstage/solar-mini4": "base2-free-solar-mini4",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "stealth/space-bunny-alpha": "base2-free-space-bunny-alpha",
  "stealth/ox-alpha": "base2-free-ox-alpha",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "moonshotai/kimi-k3": "base2-free-kimi-k3",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
  "meta/muse-spark-1.3-contributor": "base2-free-muse-spark-1-3",
};

// Session/agent-run calls get the same 20s budget the official CLI gives them.
const SESSION_FETCH_TIMEOUT_MS = 20_000;
const SESSION_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_SESSION_TTL_MS = 3_600_000;
const QUEUED_RETRY_MIN_SEC = 1;
const QUEUED_RETRY_MAX_SEC = 30;
const REFUSAL_RETRY_AFTER_SEC = 30;
const MAX_CACHED_SESSIONS = 200;
const MAX_CACHED_KEYS = 400;
const DEFAULT_RUN_ROTATION_MS = 6 * 3_600_000;
// Release an idle session's slot after this much inactivity (design decision; not part of the
// wire protocol). 0 disables.
const DEFAULT_SESSION_IDLE_MS = 10 * 60_000;

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

// Device-key managers per token: sha1(token) -> FreebuffDeviceKeyManager.
const deviceKeys = new Map();
// Idle-release timers per token hash.
const idleTimers = new Map();

// Relay pool URLs already warned about (one warning per relay per process).
const warnedRelays = new Set();

// Overridable persistence of the device-key record onto the provider connection.
let deviceKeyPersister = null;
export function setFreebuffDeviceKeyPersister(fn) {
  deviceKeyPersister = fn;
}

// Device-key records live on the connection: freebuffDeviceKey (cli lane) and
// freebuffDeviceKeyDesktop (cloud-run lane) — one keypair per mode, since the registration is
// scoped to a client type ("cli" vs "desktop").
const DEVICE_KEY_FIELD_BY_LANE = {
  [CLIENT_CLI]: "freebuffDeviceKey",
  [CLIENT_DESKTOP]: "freebuffDeviceKeyDesktop",
};

async function persistDeviceKeyRecord(credentials, record, lane = CLIENT_CLI) {
  if (!credentials?.connectionId) return;
  try {
    if (deviceKeyPersister) {
      await deviceKeyPersister(credentials.connectionId, record, credentials, lane);
      return;
    }
    const { updateProviderConnection } = await import("@/lib/db/repos/connectionsRepo.js");
    await updateProviderConnection(credentials.connectionId, {
      providerSpecificData: {
        ...(credentials.providerSpecificData || {}),
        [DEVICE_KEY_FIELD_BY_LANE[lane] || DEVICE_KEY_FIELD_BY_LANE[CLIENT_CLI]]: record,
      },
    });
  } catch {
    // Persistence is best effort: an unregistered key only costs a re-register next round.
  }
}

function pruneDeviceKeys() {
  if (deviceKeys.size <= MAX_CACHED_KEYS) return;
  for (const key of deviceKeys.keys()) {
    deviceKeys.delete(key);
    if (deviceKeys.size <= MAX_CACHED_KEYS) break;
  }
}

// One manager (one keypair) per token and lane. The record comes from the connection's
// providerSpecificData when it was persisted by an earlier run; registrations carry the lane's
// client type ("cli" or "desktop"). Registration traffic rides the same proxyAwareFetch egress
// (and therefore the same test mocks) as every other upstream call.
function getDeviceKeyManager(credentials, ctx, lane = CLIENT_CLI) {
  const token = tokenOf(credentials);
  const key = `${sessionKey(token)}|${lane}`;
  let manager = deviceKeys.get(key);
  if (!manager) {
    const field = DEVICE_KEY_FIELD_BY_LANE[lane] || DEVICE_KEY_FIELD_BY_LANE[CLIENT_CLI];
    const stored = credentials?.providerSpecificData?.[field];
    manager = new FreebuffDeviceKeyManager({
      record: stored && typeof stored.privateKey === "string" ? stored : null,
      persist: (record) => persistDeviceKeyRecord(credentials, record, lane),
      fetchImpl: (url, init) => proxyAwareFetch(url, init, ctx?.proxyOptions ?? null),
      log: ctx?.log,
      client: lane,
    });
    deviceKeys.set(key, manager);
    pruneDeviceKeys();
  }
  return manager;
}

function accountIdOf(credentials) {
  const id = credentials?.providerSpecificData?.userId;
  return typeof id === "string" && id ? id : null;
}

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

// Read at request time (not import time) so a restart is enough to flip it. 0 = a run per request.
function runRotationMs() {
  const raw = String(process.env.FREEBUFF_RUN_ROTATION_MS ?? "").trim();
  if (!raw) return DEFAULT_RUN_ROTATION_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_RUN_ROTATION_MS;
}

function sessionIdleMs() {
  const raw = String(process.env.FREEBUFF_SESSION_IDLE_MS ?? "").trim();
  if (!raw) return DEFAULT_SESSION_IDLE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : DEFAULT_SESSION_IDLE_MS;
}

function isTruthyEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

// Read at request time (not import time) so a restart is enough to flip it.
function shouldFoldTools() {
  return isTruthyEnv("FREEBUFF_FOLD_TOOLS");
}

// Optional cost_mode for codebuff_metadata (CLI: normal mode omits the field entirely).
function costModeOverride() {
  const raw = String(process.env.FREEBUFF_COST_MODE ?? "").trim();
  return raw || null;
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
  // HTTP 402 "Out of credits" (live-verified): an account condition, not a protocol failure —
  // surface the machine-readable code so 9router's combo/fallback logic moves to another account.
  const error = new FreebuffHttpError(status, status === 402 ? "out_of_credits" : code, `Freebuff: ${message}`, {
    retryAfterSec: retryAfterSecOf(resp, data),
    upstream: data ?? (text ? text.slice(0, 300) : undefined),
  });
  if (status === 402) error.type = "billing_error";
  return error;
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

function clearIdleTimer(token) {
  const timer = idleTimers.get(sessionKey(token));
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(sessionKey(token));
  }
}

// Forget a session the upstream reports as gone (nothing to release). With an instance id only that
// session is dropped, so a stale failure cannot wipe the fresh session a model switch just opened.
function clearSessionCache(token = null, instanceId = null) {
  if (!token) {
    for (const key of [...sessions.keys()]) clearIdleTimerByHash(key);
    sessions.clear();
    return;
  }
  const key = sessionKey(token);
  if (instanceId && sessions.get(key)?.instanceId !== instanceId) return;
  clearIdleTimer(token);
  sessions.delete(key);
}

function clearIdleTimerByHash(key) {
  const timer = idleTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(key);
  }
}

function clearRunCache() {
  activeRuns.clear();
  drainingRuns.clear();
  inflightRunStarts.clear();
}

function clearDeviceKeyCache() {
  deviceKeys.clear();
}

// URL of a session call, per the CLI: POST goes to /admission; DELETE only lands on /attempt for
// client-minted "cli:" claims — a server-assigned instance id ends via plain DELETE /session.
function sessionUrlFor(method, instanceId = "") {
  const claim = typeof instanceId === "string" && instanceId.startsWith(CLI_CLAIM_PREFIX) ? instanceId.slice(CLI_CLAIM_PREFIX.length) : undefined;
  if (method === "POST") return SESSION_ADMISSION_URL;
  if (method === "DELETE" && claim) return SESSION_ATTEMPT_URL;
  return SESSION_URL;
}

// Session-header factory, mirroring the CLI's RWA: auth + tz + env fingerprint + client version,
// multi-session/heartbeat markers only around "cli:" claims, catalog protocol/fetch when a
// catalog is known, admission's model + wallet limit, and never a client-minted instance id on a
// fresh POST. Signing is applied by the caller (it needs the exact target URL).
function buildSessionHeaders(method, token, { instanceId = "", model = null, hasCatalog = false, fetchId = "", compact = false } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": sessionUserAgent(),
    Accept: "application/json",
    [HEADER_TIMEZONE]: localTimeZone(),
    [HEADER_ENV]: clientEnv(),
  };
  const version = cliVersion();
  if (version) headers[HEADER_CLIENT_VERSION] = version;

  const claim = typeof instanceId === "string" && instanceId.startsWith(CLI_CLAIM_PREFIX) ? instanceId.slice(CLI_CLAIM_PREFIX.length) : undefined;
  const multi = Boolean(claim);
  if (multi) {
    headers[HEADER_MULTI_SESSION] = "1";
    headers[HEADER_PURCHASE_CONTINUITY] = "1";
    if (method !== "GET") headers[HEADER_ATTEMPT] = claim;
    if (method === "GET") {
      headers[HEADER_HEARTBEAT] = "1";
      if (!compact) headers[HEADER_INCLUDE_UNUSED_RATE_LIMITS] = "1";
    }
  }
  if (hasCatalog) {
    headers[HEADER_CATALOG_PROTOCOL] = "1";
    if (fetchId) headers[CATALOG_FETCH_HEADER] = fetchId;
  }
  if ((multi || method !== "POST") && instanceId) headers[HEADER_INSTANCE] = instanceId;
  if (method === "GET" && compact) headers[HEADER_COMPACT_SESSION] = "1";
  if (method === "POST") {
    if (model) headers[HEADER_MODEL] = model;
    headers[HEADER_WALLET_SPEND_LIMIT] = "session";
  }
  return headers;
}

// Sign a session call into an existing header object. The scope follows the target URL's origin,
// like the CLI's gWA.
async function signInto(headers, deviceKey, { token, accountId, method, url, body, fetchId }) {
  if (!deviceKey) return;
  const sigHeaders = await deviceKey.headers({
    token,
    accountId,
    apiHost: new URL(url).origin,
    method,
    url,
    body,
    fetchId: fetchId || "",
  });
  Object.assign(headers, sigHeaders);
}

// Desktop admission/session headers (REPORT-DESKTOP.md §6): client + install id + client version,
// instance id and multi-session always sent, model + wallet limit on POST. Signed by the caller.
function buildDesktopSessionHeaders(method, token, { instanceId = "", model = null, hasCatalog = false, fetchId = "", attemptId = null } = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": desktopUserAgent(),
    Accept: "application/json",
    [HEADER_TIMEZONE]: localTimeZone(),
    [HEADER_CLIENT]: CLIENT_DESKTOP,
    [HEADER_INSTALL_ID]: installIdFor(token),
    [HEADER_CLIENT_VERSION]: desktopVersion(),
    [HEADER_INSTANCE]: instanceId,
    [HEADER_MULTI_SESSION]: "1",
    [HEADER_PURCHASE_CONTINUITY]: "1",
  };
  if (hasCatalog) {
    headers[HEADER_CATALOG_PROTOCOL] = "1";
    if (fetchId) headers[CATALOG_FETCH_HEADER] = fetchId;
  }
  if (method === "POST") {
    if (model) headers[HEADER_MODEL] = model;
    headers[HEADER_WALLET_SPEND_LIMIT] = "session";
  }
  if (attemptId) headers[HEADER_ATTEMPT] = attemptId;
  return headers;
}

// Normalise one admission (or queue poll) answer into a session state or throw a FreebuffHttpError.
function interpretSession(result, model, fallbackInstanceId) {
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
    };
  }
  if (ok && upstreamStatus === "queued") {
    const waitSec = Math.ceil((Number(data.estimatedWaitMs) || 0) / 1000);
    const retryAfterSec = Math.min(Math.max(waitSec, QUEUED_RETRY_MIN_SEC), QUEUED_RETRY_MAX_SEC);
    return {
      type: "queued",
      instanceId: data.instanceId || fallbackInstanceId || "",
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
    if (isDeviceKeyError(error.message)) error.code = "device_key_invalid";
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

// x-freebuff-model / cloud-run model must be a live catalog key. Without a matching row the
// upstream answers 409 freebuff_catalog_stale (live-verified), so answer a clean 502 instead of
// guessing; with no catalog at all the key passes through and upstream decides.
function resolveModelForAdmission(catalog, model) {
  if (!catalog) return model;
  const resolved = resolveAdmissionModel(catalog, model);
  if (!resolved) {
    throw new FreebuffHttpError(
      502,
      "invalid_model",
      `Freebuff: model "${model}" is not in the current catalog (a catalog key or its model id are both accepted). Fetch /v1/models for the routable keys.`,
      { type: "invalid_request_error" },
    );
  }
  return resolved;
}

// POST the admission. CLI lane: no client-minted instance id (the server assigns one, and the
// answer travels back in interpretSession). Desktop lane: instance id + multi-session go out per
// REPORT-DESKTOP.md §6.
async function admitOnce(token, model, ctx) {
  // The model header follows the model being admitted (it can differ from the request's after a
  // model_locked redirect), resolved through the catalog each time.
  const admissionModel = resolveModelForAdmission(ctx.catalog, model);
  let headers;
  if (ctx.lane === CLIENT_DESKTOP) {
    headers = buildDesktopSessionHeaders("POST", token, {
      instanceId: ctx.desktopInstanceId,
      model: admissionModel,
      hasCatalog: ctx.hasCatalog,
      fetchId: ctx.fetchId,
      attemptId: ctx.desktopAttemptId,
    });
  } else {
    headers = buildSessionHeaders("POST", token, {
      model: admissionModel,
      hasCatalog: ctx.hasCatalog,
      fetchId: ctx.fetchId,
    });
  }
  await signInto(headers, ctx.deviceKey, {
    token,
    accountId: ctx.accountId,
    method: "POST",
    url: SESSION_ADMISSION_URL,
    fetchId: ctx.fetchId,
  });
  const result = await callJson(SESSION_ADMISSION_URL, { method: "POST", headers, signal: ctx.signal }, ctx.proxyOptions);
  // Full body at debug level: the live probe needed it to diagnose the desktop-lane 409s.
  ctx.log?.debug?.("FREEBUFF", `Admission ${result.status}: ${(result.text || "").slice(0, 800)}`);
  // The CLI treats 404/405 on the admission route as a hard "update your client".
  if (result.status === 404 || result.status === 405) {
    throw new FreebuffHttpError(502, "session_admission_unsupported", `Freebuff: session admission answered ${result.status}`, {
      upstream: { status: result.status },
    });
  }
  return interpretSession(result, model);
}

// Poll a queued session by instance id.
async function pollQueued(token, entry, model, ctx) {
  const url = sessionUrlFor("GET", entry.instanceId);
  const headers =
    entry.lane === CLIENT_DESKTOP
      ? buildDesktopSessionHeaders("GET", token, {
          instanceId: entry.instanceId,
          hasCatalog: ctx.hasCatalog,
          fetchId: ctx.fetchId,
        })
      : buildSessionHeaders("GET", token, {
          instanceId: entry.instanceId,
          hasCatalog: ctx.hasCatalog,
          fetchId: ctx.fetchId,
        });
  await signInto(headers, ctx.deviceKey, {
    token,
    accountId: ctx.accountId,
    method: "GET",
    url,
    fetchId: ctx.fetchId,
  });
  const result = await callJson(url, { method: "GET", headers, signal: ctx.signal }, ctx.proxyOptions);
  if (result.status === 404) return { type: "restart", status: "none" };
  return interpretSession(result, model, entry.instanceId);
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

  if (state.type === "queued") {
    sessions.set(key, {
      type: "queued",
      lane: ctx.lane,
      model,
      serves,
      instanceId: state.instanceId,
      retryAtMs: Date.now() + state.retryAfterSec * 1000,
      position: state.position,
      queueDepth: state.queueDepth,
      retryAfterSec: state.retryAfterSec,
    });
    throw queuedError(state.instanceId, state.position, state.queueDepth, state.retryAfterSec);
  }
  if (state.type === "restart") {
    throw new FreebuffHttpError(502, "freebuff_session_failed", "Freebuff: the session could not be started (no session row)");
  }
  if (state.type === "disabled") {
    const entry = { type: "disabled", lane: ctx.lane, instanceId: "", model, serves, expiresAt: Date.now() + 300_000 };
    sessions.set(key, entry);
    return { instanceId: "", resolvedModel: model };
  }
  if (state.type !== "active") {
    throw new FreebuffHttpError(502, "freebuff_session_failed", `Freebuff: could not open a free session (${state.status || state.type})`);
  }

  const expiresAt = Date.now() + Math.max(1000, state.ttlMs - SESSION_EXPIRY_MARGIN_MS);
  serves.add(state.model);
  const entry = { type: "active", lane: ctx.lane, instanceId: state.instanceId, model: state.model, serves, expiresAt, lastUsedAt: Date.now() };
  pruneSessions();
  sessions.set(key, entry);
  scheduleIdleRelease(token, entry, ctx);
  return { instanceId: entry.instanceId, resolvedModel: entry.model };
}

// Give an occupied slot back before another model is admitted (or when the session went idle):
// DELETE with the assigned instance id, signed. Server-assigned ids end via plain DELETE
// /session; only "cli:" claims would take the /attempt route. Best effort: a failure is logged
// and never fails the request that triggered the switch.
async function releaseSession(token, entry, nextModel, ctx = {}) {
  const key = sessionKey(token);
  if (sessions.get(key) === entry) sessions.delete(key);
  clearIdleTimer(token);
  ctx.log?.info?.("FREEBUFF", `Releasing the ${entry.model} session before admitting ${nextModel}`);
  // The old session's runs are not going to be used again; end them once their requests are done.
  if (entry.type === "active" && entry.lane !== CLIENT_DESKTOP) retireRuns(token, FREEBUFF_AGENT_ID_BY_MODEL[entry.model]);
  if (!entry.instanceId) return;
  const url = sessionUrlFor("DELETE", entry.instanceId);
  const headers =
    entry.lane === CLIENT_DESKTOP
      ? buildDesktopSessionHeaders("DELETE", token, {
          instanceId: entry.instanceId,
          hasCatalog: ctx.hasCatalog,
          fetchId: ctx.fetchId,
        })
      : buildSessionHeaders("DELETE", token, {
          instanceId: entry.instanceId,
          hasCatalog: ctx.hasCatalog,
          fetchId: ctx.fetchId,
        });
  await signInto(headers, ctx.deviceKey, {
    token,
    accountId: ctx.accountId,
    method: "DELETE",
    url,
    fetchId: ctx.fetchId,
  });
  try {
    const result = await callJson(url, { method: "DELETE", headers }, ctx.proxyOptions);
    if (!result.ok && result.status !== 404) {
      ctx.log?.warn?.("FREEBUFF", `Releasing the ${entry.model} session answered ${result.status}`);
    }
  } catch (err) {
    ctx.log?.warn?.("FREEBUFF", `Releasing the ${entry.model} session failed: ${err?.message || err}`);
  }
}

// Release a session's slot after FREEBUFF_SESSION_IDLE_MS without activity, so the single free
// slot does not stay occupied for its whole hour (the stuck-slot bug of the old executor).
function scheduleIdleRelease(token, entry, ctx = {}) {
  clearIdleTimer(token);
  const idleMs = sessionIdleMs();
  if (!(idleMs > 0) || entry.type !== "active") return;
  const timer = setTimeout(
    async () => {
      idleTimers.delete(sessionKey(token));
      const current = sessions.get(sessionKey(token));
      if (current !== entry) return;
      sessions.delete(sessionKey(token));
      try {
        await releaseSession(token, entry, "(idle)", ctx);
        ctx.log?.info?.("FREEBUFF", `Released the idle ${entry.model} session after ${Math.round(idleMs / 1000)}s`);
      } catch {
        // best effort — the slot expires server-side anyway
      }
    },
    idleMs,
  );
  timer.unref?.();
  idleTimers.set(sessionKey(token), timer);
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
    // A cached entry only serves when it was opened on the same lane: the release/admission
    // header styles differ between the CLI and desktop flows.
    const serves = cached?.serves.has(model) === true && cached.lane === (ctx.lane || CLIENT_CLI);
    if (serves && cached.type === "active" && now < cached.expiresAt) {
      cached.lastUsedAt = now;
      scheduleIdleRelease(token, cached, ctx);
      return { instanceId: cached.instanceId, resolvedModel: cached.model };
    }
    if (serves && cached.type === "disabled" && now < cached.expiresAt) {
      return { instanceId: "", resolvedModel: cached.model };
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
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": sessionUserAgent(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (ctx.accountId) headers[HEADER_ACTING_USER] = ctx.accountId;
  ctx.log?.warn?.("DEBUG_AGENT", JSON.stringify({ agentId, action: "START" }));
  const result = await callJson(
    AGENT_RUNS_URL,
    {
      method: "POST",
      headers,
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
function finishAgentRun(token, runId, status = "completed", ctx = {}, errorMessage = "", { totalSteps = 1, accountId = null } = {}) {
  if (!runId) return Promise.resolve();
  const payload = { action: "FINISH", runId, status, totalSteps, directCredits: 0, totalCredits: 0, steps: [] };
  if (errorMessage) payload.errorMessage = String(errorMessage).slice(0, 5000);
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": sessionUserAgent(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (accountId || ctx.accountId) headers[HEADER_ACTING_USER] = accountId || ctx.accountId;
  return callJson(
    AGENT_RUNS_URL,
    { method: "POST", headers, body: JSON.stringify(payload) },
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

function runKey(token, agentId) {
  return `${sessionKey(token)}:${agentId}`;
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
    return Array.isArray(messages) ? messages : msgs;
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

// Build the /chat/completions body in the CLI 0.2.34 shape ($3H + RZA): caller fields pass
// through, but model, messages, stream, codebuff_metadata and provider belong to the handshake.
// codebuff_metadata order follows the CLI spread: extra (instance/env) first, then run_id,
// client_id, and the conditional n / cost_mode / cache_debug_correlation.
function buildChatBody(
  body,
  { model, runId, instanceId = "", reasoningEffort = null, stream = true, costMode = null, freeModeTransforms = null } = {},
) {
  const out = { ...(body || {}) };
  delete out.codebuff_metadata;
  delete out.provider;

  let messages = ensureRootOpening(out.messages);
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

  let carrierPlan = null;
  if (freeModeTransforms) {
    messages = neutralizeSystemPromptMarkers(messages);
    if (Array.isArray(out.tools) && out.tools.length > 0) {
      const packed = packToolsForFreebuff(out.tools);
      out.tools = packed.tools;
      carrierPlan = packed.carrierPlan;
      out[CARRIER_PLAN_SYMBOL] = carrierPlan;
    }
    messages = alignHistoryToolNames(messages, carrierPlan);
  }

  if (out.max_tokens == null && out.max_completion_tokens != null) out.max_tokens = out.max_completion_tokens;
  delete out.max_completion_tokens;

  // RZA: multi-session/surface markers only for client-minted "cli:" claims — a server-assigned
  // instance id travels alone.
  const metadata = {};
  if (instanceId) {
    metadata.freebuff_instance_id = instanceId;
    if (String(instanceId).startsWith(CLI_CLAIM_PREFIX)) {
      metadata.freebuff_multi_session = "1";
      metadata.surface = "cli";
    }
  }
  if (reasoningEffort) metadata.freebuff_reasoning_effort = String(reasoningEffort);
  metadata.freebuff_client_env = clientEnv();
  metadata.run_id = runId;
  metadata.client_id = generateClientId();
  const mode = freeModeTransforms ? resolveCostMode(costMode, costModeOverride()) : (costMode ?? costModeOverride());
  if (mode) metadata.cost_mode = mode;

  out.model = model;
  out.messages = messages;
  out.stream = stream !== false;
  if (out.stream && out.stream_options == null) out.stream_options = { include_usage: true };
  out.codebuff_metadata = metadata;
  out.provider = { order: null, allow_fallbacks: true };
  return out;
}

// Chat headers, mirroring the CLI provider factory + YWA: ai-sdk user agent, gzip recovery,
// acting user, catalog fetch binding, and the device-key signature over this exact body.
async function buildChatHeaders({ token, accountId, bodyStr, fetchId, stream, deviceKey, lane }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": chatUserAgent(),
    Accept: stream ? "text/event-stream" : "application/json",
    [HEADER_GZIP_RECOVERY]: "1",
  };
  if (lane) headers[HEADER_CLIENT] = lane;
  const version = lane === CLIENT_DESKTOP ? desktopVersion() : cliVersion();
  if (version) headers[HEADER_CLIENT_VERSION] = version;
  if (accountId) headers[HEADER_ACTING_USER] = accountId;
  if (fetchId) headers[CATALOG_FETCH_HEADER] = fetchId;
  if (deviceKey) {
    const sigHeaders = await deviceKey.headers({
      token,
      accountId,
      apiHost: new URL(CHAT_URL).origin,
      method: "POST",
      url: CHAT_URL,
      body: bodyStr,
      fetchId: fetchId || "",
    });
    Object.assign(headers, sigHeaders);
  }
  return headers;
}

async function readErrorBody(response) {
  try {
    return await response.clone().text();
  } catch {
    return "";
  }
}

// What a rejected chat call asks us to renew before one retry: "session" (re-admit), "run" (fresh
// START, the session is fine), "catalog" (stale catalog: refetch for a fresh fetchId) or
// "devicekey" (the registered key is unknown: forget it so the next round re-registers).
function gateRetryKind(status, errText) {
  const data = parseJson(errText);
  const code = typeof data?.error === "string" ? data.error : "";
  if (code === "freebuff_catalog_stale") return "catalog";
  if (isDeviceKeyError(errText)) return "devicekey";
  if (code === "freebuff_update_required" || (code && SESSION_INVALID_CODES.has(code))) return "session";
  // The run vanished server side (a long-lived run can expire); a fresh START fixes it.
  if (status === 400 && /runid not (found|running)/i.test(errText)) return "run";
  return null;
}

function carrierSseResponse(response, carrierPlan) {
  return new Response(response.body.pipeThrough(createCarrierSseTransform(carrierPlan)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function carrierJsonResponse(response, carrierPlan) {
  const text = await response.text();
  let out = text;
  try {
    out = JSON.stringify(unpackCarrierToolCalls(JSON.parse(text), carrierPlan));
  } catch {
    out = text;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(out, { status: response.status, statusText: response.statusText, headers });
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
export async function probeFreebuffToken(token, proxyOptions = null, { signal, deviceKey = null, accountId = null } = {}) {
  if (!token) return { valid: false, status: 0, error: "No token" };
  try {
    const headers = buildSessionHeaders("GET", token);
    if (deviceKey) {
      await signInto(headers, deviceKey, { token, accountId, method: "GET", url: SESSION_URL });
    }
    const result = await callJson(SESSION_URL, { method: "GET", headers, signal }, directEgressOptions(proxyOptions));
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

// ---------------------------------------------------------------------------
// cloud-run lane (Desktop 0.0.188 protocol)
// ---------------------------------------------------------------------------

function cloudPollIntervalMs() {
  const raw = Number(process.env.FREEBUFF_CLOUD_POLL_MS);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : CLOUD_POLL_INTERVAL_MS_DEFAULT;
}

function cloudRunTimeoutMs() {
  const raw = Number(process.env.FREEBUFF_CLOUD_RUN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : CLOUD_RUN_TIMEOUT_MS_DEFAULT;
}

// Flatten a chat-completions conversation into the single prompt string a cloud run expects.
function promptFromMessages(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === "user");
  const parts = msgs.map((m) => {
    const text = messageText(m?.content);
    if (!text) return "";
    return `${m.role}: ${text}`;
  });
  const transcript = parts.filter(Boolean).join("\n\n");
  return { prompt: transcript || messageText(lastUser?.content) || "", displayPrompt: messageText(lastUser?.content) };
}

// The POST /api/v1/cloud/runs submission (REPORT-DESKTOP.md §5). Fields the desktop fills from
// its workspace state (github, seed, terminalSessionIds, mission, byok/agent) have no 9router
// counterpart and are simply absent; a 400 "Invalid cloud run request" retry only drops `github`,
// which we never send.
function buildCloudSubmission({ body, model, instanceId }) {
  const { prompt, displayPrompt } = promptFromMessages(body?.messages);
  const threadId = randomUUID();
  const effort = body?.reasoning_effort ? String(body.reasoning_effort) : undefined;
  return {
    workspaceId: threadId,
    runId: randomUUID(),
    instanceId: instanceId || `byok-${threadId}`,
    prompt,
    terminalSessionIds: [],
    displayPrompt: displayPrompt || prompt,
    chatTitle: (displayPrompt || prompt).slice(0, 80),
    model,
    ...(effort ? { effort } : {}),
    agentMode: "chat",
    injectAgentsMd: false,
    images: [],
  };
}

// Text of one polled event. Chunk payloads have been seen as {text} in the desktop bundle; be
// liberal in what we accept.
function cloudChunkText(payload) {
  if (typeof payload === "string") return payload;
  return payload?.text ?? payload?.content ?? payload?.delta ?? "";
}

function chatCompletionBody(content, model) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// Adapt cloud-run chunk events into an SSE response the 9router stream pipeline understands.
function sseResponseFromEvents(events, model) {
  const id = `chatcmpl-${randomUUID()}`;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const push = (obj) => controller.enqueue(encoder.encode(sseFrame(obj)));
      push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      for (const event of events) {
        const text = cloudChunkText(event.payload);
        if (text) push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      }
      push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// Poll GET /api/v1/cloud/runs/{runId}?after=<cursor> until the run completes, fails or the budget
// runs out; then render the collected chunk events as a chat response. On client abort the cloud
// run is cancelled best effort.
async function pollCloudRun({ token, runId, signal, proxyOptions, log, model }) {
  const budgetMs = cloudRunTimeoutMs();
  const deadline = Date.now() + budgetMs;
  const intervalMs = cloudPollIntervalMs();
  const chunks = [];
  let cursor = null;
  let status = "queued";

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await proxyAwareFetch(`${CLOUD_RUNS_URL}/${runId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      }, proxyOptions).catch(() => {});
      return { error: new FreebuffHttpError(499, "client_disconnected", "Freebuff cloud run aborted by the client") };
    }

    const url = cursor ? `${CLOUD_RUNS_URL}/${runId}?after=${encodeURIComponent(cursor)}` : `${CLOUD_RUNS_URL}/${runId}`;
    const result = await callJson(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }, proxyOptions);
    if (!result.ok) {
      return { error: upstreamError(result, "cloud_run_poll_failed") };
    }

    const events = Array.isArray(result.data?.events) ? result.data.events : [];
    for (const event of events) {
      if (typeof event?.id === "string" || typeof event?.id === "number") cursor = String(event.id);
      if (event?.kind === "chunk") chunks.push(event);
    }
    status = result.data?.status || (result.data?.done ? "completed" : status);

    if (status === "completed" || status === "failed") {
      if (status === "failed") {
        const message = result.data?.errorMessage || result.data?.error || "cloud run failed";
        return { error: new FreebuffHttpError(502, "cloud_run_failed", `Freebuff: ${message}`, { upstream: result.data ?? undefined }) };
      }
      const content = chunks.map((event) => cloudChunkText(event.payload)).join("");
      const response = model?.stream
        ? sseResponseFromEvents(chunks, model.model)
        : new Response(JSON.stringify(chatCompletionBody(content, model?.model || "")), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
      return { response };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  await proxyAwareFetch(`${CLOUD_RUNS_URL}/${runId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  }, proxyOptions).catch(() => {});
  return { error: new FreebuffHttpError(504, "cloud_run_timeout", `Freebuff cloud run did not finish within ${Math.round(budgetMs / 1000)}s`) };
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
      "User-Agent": chatUserAgent(),
      Accept: stream ? "text/event-stream" : "application/json",
      [HEADER_GZIP_RECOVERY]: "1",
    };
  }

  transformRequest(model, body, stream) {
    return buildChatBody(body, { model: resolveModel(model), runId: undefined, instanceId: "", stream });
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

  async execute(options) {
    const mode = resolveExecMode(options.credentials);
    if (mode === "cloud-run") return this.executeCloudRun(options);
    return this.executeCliChat(options);
  }

  // Desktop hosted lane: signed catalog + admission, then POST /api/v1/cloud/runs and adapt the
  // JSON event polling into an OpenAI-shaped chat response (see REPORT-DESKTOP.md §5).
  async executeCloudRun({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fail = (error) => ({
      response: error.toResponse(),
      url: CLOUD_RUNS_URL,
      headers: {},
      transformedBody: error.toBody(),
    });

    const token = tokenOf(credentials);
    if (!token) {
      return fail(new FreebuffHttpError(401, "unauthorized", "Freebuff requires an auth token", { type: "authentication_error" }));
    }
    const targetModel = resolveModel(model);
    const tokenHash = tokenHashOf(token);
    const accountId = accountIdOf(credentials);
    const deviceKey = getDeviceKeyManager(credentials, { log }, CLIENT_DESKTOP);

    const ctx = {
      proxyOptions: directEgressOptions(proxyOptions, log),
      signal,
      log,
      deviceKey,
      accountId,
      lane: CLIENT_DESKTOP,
      // Desktop admissions carry a client-side instance id (freeMode.instanceId analogue).
      desktopInstanceId: `byok-${randomUUID()}`,
      desktopAttemptId: randomUUID(),
    };
    const catalogCtx = { token, deviceKey, accountId, client: CLIENT_DESKTOP, proxyFetch: proxyAwareFetch, proxyOptions: ctx.proxyOptions, log };

    let catalog = await getFreebuffCatalog(catalogCtx);
    let fetchId = cachedFetchId(tokenHash, CLIENT_DESKTOP);

    for (let attempt = 0; attempt < 2; attempt++) {
      let session;
      let runId = "";
      let submissionStr = "";
      let submission;
      try {
        ctx.hasCatalog = Boolean(catalog);
        ctx.fetchId = fetchId;
        ctx.catalog = catalog;
        // Live rows are keyed "m-<10hex>": the model field must come from the catalog. No row ->
        // 502 invalid_model (the legacy fnv handle is rejected server-side).
        // A human model id maps to its catalog key; per attempt, the catalog can be refetched.
        const modelKey = catalog ? (resolveCatalogKey(catalog, targetModel) ?? freebuffHandleFor(targetModel)) : freebuffHandleFor(targetModel);
        ctx.admissionModel = resolveModelForAdmission(catalog, modelKey);

        session = await getFreebuffSession(token, modelKey, ctx);
        submission = buildCloudSubmission({ body, model: session.resolvedModel || ctx.admissionModel, instanceId: session.instanceId, stream });
        runId = submission.runId;
        submissionStr = JSON.stringify(submission);
      } catch (err) {
        if (err instanceof FreebuffHttpError) {
          log?.debug?.("FREEBUFF", `Cloud session initialization refused (${err.status} ${err.code})`);
          return fail(err);
        }
        throw err;
      }

      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        [CLOUD_QUESTIONS_HEADER]: "1",
        [PRODUCT_CONTEXT_HEADER]: JSON.stringify({ originApp: "desktop" }),
      };
      log?.debug?.("FETCH", `FREEBUFF -> ${CLOUD_RUNS_URL} | model=${ctx.admissionModel} run=${runId} | body=${submissionStr.length}B`);

      let response;
      try {
        response = await proxyAwareFetch(CLOUD_RUNS_URL, { method: "POST", headers, body: submissionStr, signal }, ctx.proxyOptions);
      } catch (error) {
        if (error.name === "AbortError" && !signal?.aborted) throw new Error("Freebuff cloud run connect failed");
        throw error;
      }

      if (!response.ok) {
        const errText = await readErrorBody(response);
        const code = parseJson(errText)?.error;
        // 409 freebuff_catalog_stale -> refresh the catalog once, retry with the fresh handle.
        if (attempt === 0 && (code === "freebuff_catalog_stale" || response.status === 409 && /catalog_stale/i.test(errText))) {
          log?.debug?.("FREEBUFF", "Cloud run reported a stale catalog, refreshing and retrying");
          invalidateFreebuffCatalog(tokenHash);
          catalog = await getFreebuffCatalog({ ...catalogCtx, force: true });
          fetchId = cachedFetchId(tokenHash, CLIENT_DESKTOP);
          continue;
        }
        return fail(upstreamError({ resp: response, status: response.status, data: parseJson(errText), text: errText }, "cloud_run_failed"));
      }

      // Poll the run's events and adapt them into a chat-shaped response.
      const adapted = await pollCloudRun({
        token,
        runId,
        signal,
        proxyOptions: ctx.proxyOptions,
        log,
        model: { stream, model: ctx.admissionModel },
      });
      if (adapted.error) return fail(adapted.error);
      return { response: adapted.response, url: CLOUD_RUNS_URL, headers, transformedBody: submission };
    }

    throw new Error("Freebuff cloud run failed");
  }

  async executeCliChat({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.buildUrl();
    const fail = (error, headers = {}) => ({
      response: error.toResponse(),
      url,
      headers,
      transformedBody: error.toBody(),
    });

    const token = tokenOf(credentials);
    if (!token) {
      return fail(new FreebuffHttpError(401, "unauthorized", "Freebuff requires an auth token", { type: "authentication_error" }));
    }

    const targetModel = resolveModel(model);
    const tokenHash = tokenHashOf(token);
    const accountId = accountIdOf(credentials);
    const deviceKey = getDeviceKeyManager(credentials, { log }, CLIENT_DESKTOP);

    const ctx = { proxyOptions: directEgressOptions(proxyOptions, log), signal, log, deviceKey, accountId, lane: CLIENT_DESKTOP, desktopInstanceId: `free-${randomUUID()}`, desktopAttemptId: randomUUID() };
    const catalogCtx = { token, deviceKey, accountId, client: CLIENT_DESKTOP, proxyFetch: proxyAwareFetch, proxyOptions: ctx.proxyOptions, log };

    // Catalog first (cached): its fetchId is bound into the admission and chat signatures, and the
    // live rows decide whether the model is routable at all.
    let catalog = await getFreebuffCatalog(catalogCtx);
    let fetchId = cachedFetchId(tokenHash, CLIENT_DESKTOP);

    for (let attempt = 0; attempt < 2; attempt++) {
      let session;
      let lease = null;
      let startFailed = false;
      let bodyStr = "";
      let chatHeaders;
      let carrierPlan = null;
      try {
        ctx.hasCatalog = Boolean(catalog);
        ctx.fetchId = fetchId;
        ctx.catalog = catalog;
        // A human model id maps to its catalog key; per attempt, the catalog can be refetched.
        const modelKey = catalog ? (resolveCatalogKey(catalog, targetModel) ?? freebuffHandleFor(targetModel)) : freebuffHandleFor(targetModel);
        ctx.admissionModel = resolveModelForAdmission(catalog, modelKey);

        session = await getFreebuffSession(token, modelKey, ctx);
        const agentId = resolveFreebuffAgent(targetModel, session.resolvedModel, catalog);
        startFailed = true;
        lease = await acquireAgentRun(token, agentId, ctx);
        startFailed = false;

        const transformedBody = buildChatBody(body, {
          model: session.resolvedModel,
          runId: lease.runId,
          instanceId: session.instanceId,
          reasoningEffort: body?.reasoning_effort ?? null,
          stream,
          freeModeTransforms: {},
        });
        carrierPlan = transformedBody[CARRIER_PLAN_SYMBOL] || null;
        bodyStr = JSON.stringify(transformedBody);
        chatHeaders = await buildChatHeaders({ token, accountId, bodyStr, fetchId, stream, deviceKey, lane: CLIENT_DESKTOP });
      } catch (err) {
        if (err instanceof FreebuffHttpError) {
          // A START that reports a dead session (not our own queued answer) gets one fresh admission.
          if (startFailed && attempt === 0 && SESSION_INVALID_CODES.has(err.code)) {
            log?.debug?.("FREEBUFF", `Agent run START reported ${err.code}, re-admitting`);
            clearSessionCache(token, session?.instanceId);
            continue;
          }
          log?.debug?.("FREEBUFF", `Session/run initialization refused (${err.status} ${err.code})`);
          return fail(err);
        }
        throw err;
      }
      const runId = lease.runId;
      log?.debug?.("FETCH", `FREEBUFF -> ${url} | model=${session.resolvedModel} runId=${runId} | body=${bodyStr.length}B`);
      const debugBody = JSON.parse(bodyStr);
      const safeHeaders = Object.fromEntries(Object.entries(chatHeaders).filter(([k]) => k.toLowerCase() !== "authorization"));
      log?.warn?.("DEBUG_CHAT", JSON.stringify({
        model: debugBody.model,
        codebuff_metadata: debugBody.codebuff_metadata,
        provider: debugBody.provider,
        headers: safeHeaders,
        agentId,
      }));

      // Abort if upstream doesn't return response headers within the connection timeout.
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      let response;
      try {
        response = await proxyAwareFetch(url, { method: "POST", headers: chatHeaders, body: bodyStr, signal: mergedSignal }, ctx.proxyOptions);
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
        let retry = attempt === 0 ? gateRetryKind(response.status, errText) : null;
        // An unknown device key invalidates the registration and the fetchId binding.
        if (isDeviceKeyError(errText)) {
          deviceKey.forgetRegistration({ token, accountId, apiHost: new URL(CHAT_URL).origin });
          invalidateFreebuffCatalog(tokenHash);
          retry = attempt === 0 ? "devicekey" : null;
        }
        if (retry === "run") lease.invalidate();
        else lease.release("failed", `${response.status} ${errText.slice(0, 200)}`);
        if (retry) {
          log?.debug?.("FREEBUFF", `Chat gate rejected the request (${response.status}), renewing the ${retry}`);
          if (retry === "session") clearSessionCache(token, session.instanceId);
          if (retry === "catalog" || retry === "devicekey") {
            invalidateFreebuffCatalog(tokenHash);
            catalog = await getFreebuffCatalog({ ...catalogCtx, force: true });
            fetchId = cachedFetchId(tokenHash, CLIENT_DESKTOP);
          }
          continue;
        }
        // 402 billing must carry the machine-readable code for 9router's fallback logic instead
        // of the raw upstream body.
        if (response.status === 402) {
          return fail(upstreamError({ resp: response, status: response.status, data: parseJson(errText), text: errText }, "out_of_credits"), chatHeaders);
        }
        return { response, url, headers: chatHeaders, transformedBody: JSON.parse(bodyStr) };
      }

      const wrapped = wrapStreamWithCleanup(response, (status, message) => lease.release(status, message));
      const finalResponse = carrierPlan?.active
        ? stream
          ? carrierSseResponse(wrapped, carrierPlan)
          : await carrierJsonResponse(wrapped, carrierPlan)
        : wrapped;
      return { response: finalResponse, url, headers: chatHeaders, transformedBody: JSON.parse(bodyStr) };
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
  clientEnv,
  clearSessionCache,
  clearRunCache,
  clearDeviceKeyCache,
  clearIdleTimers: () => {
    for (const key of [...idleTimers.keys()]) clearIdleTimerByHash(key);
  },
  runRotationMs,
  sessionIdleMs,
  resolveModel,
  tokenOf,
  sessionKey,
  sessions,
  activeRuns,
  drainingRuns,
  warnedRelays,
  deviceKeys,
  invalidateFreebuffCatalog,
  cachedFetchId,
  buildSessionHeaders,
  buildDesktopSessionHeaders,
  buildCloudSubmission,
  promptFromMessages,
  cloudChunkText,
  chatCompletionBody,
  resolveExecMode,
  installIdFor,
  desktopVersion,
  desktopUserAgent,
  laneFor,
  sessionUrlFor,
  gateRetryKind,
  buildChatHeaders,
  ROOT_SYSTEM_PROMPT,
  FREEBUFF_ROOT_OPENING,
  DEFAULT_MODEL,
  FREEBUFF_AGENT_ID_BY_MODEL,
  chatUserAgent,
  sessionUserAgent,
  cliVersion,
  aiSdkVersion,
  setFreebuffDeviceKeyPersister,
  persistDeviceKeyRecord,
  getDeviceKeyManager,
  HEADER_GZIP_RECOVERY,
  HEADER_ACTING_USER,
  HEADER_INSTALL_ID,
  HEADER_CLIENT,
  DEVICE_KEY_HEADER,
  DEVICE_SIG_HEADER,
  DEVICE_TS_HEADER,
  DEFAULT_CLI_VERSION,
  DEFAULT_AISDK_VERSION,
  DEFAULT_DESKTOP_VERSION,
  DEFAULT_RUN_ROTATION_MS,
  DEFAULT_SESSION_IDLE_MS,
  CLOUD_POLL_INTERVAL_MS_DEFAULT,
  CLOUD_RUN_TIMEOUT_MS_DEFAULT,
  BASE_URL,
  CHAT_URL,
  AGENT_RUNS_URL,
  SESSION_URL,
  SESSION_ADMISSION_URL,
  SESSION_ATTEMPT_URL,
  CLOUD_RUNS_URL,
  FREEBUFF_BASE: FREEBUFF_API_BASE,
  CATALOG_URL,
  DEVICE_KEYS_URL,
};

export default FreebuffExecutor;
