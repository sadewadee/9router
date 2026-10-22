// Automatic daily check-in for CodeBuddy OAuth connections (codebuddy-cn, codebuddy-intl).
// The check-in campaign grants free credits; connections that ran out of credits are
// usually auto-deactivated, so inactive connections are included on purpose.
// Fail-open everywhere: one bad connection or a network error never stops the tick,
// and a tick error never kills the interval. Tokens are never logged.
//
// Upstream (same base URL / headers as the usage service, POST with an empty JSON body):
//   /v2/billing/meter/checkin-status -> { code:0, data:{ active, today_checked_in, daily_credit, ... } }
//   /v2/billing/meter/daily-checkin  -> only called when active === true && today_checked_in === false

import * as log from "../utils/logger.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { PROVIDERS, PROVIDER_OAUTH } from "open-sse/config/providers.js";
import {
  CODEBUDDY_CHECKIN_INTERVAL_MS,
  CODEBUDDY_CHECKIN_INITIAL_DELAY_MS,
  CODEBUDDY_CHECKIN_REQUEST_TIMEOUT_MS,
} from "open-sse/config/runtimeConfig.js";

const TAG = "CODEBUDDY_CHECKIN";
const CHECKIN_PROVIDERS = new Set(["codebuddy-cn", "codebuddy-intl"]);
const STATUS_PATH = "/v2/billing/meter/checkin-status";
const CHECKIN_PATH = "/v2/billing/meter/daily-checkin";
// Pause between accounts so a tick never bursts the billing API.
const CONNECTION_GAP_MS = 1500;
// Credit amount in the daily-checkin response (field name not documented; first numeric wins).
const CREDIT_KEYS = ["credit", "credits", "granted_credit", "reward_credit", "reward", "daily_credit", "amount"];

// Survives duplicate module instances (Next bundle + raw import): one scheduler per process.
const STATE_KEY = Symbol.for("9router.codebuddyCheckin");
const state = (globalThis[STATE_KEY] ??= { started: false, intervalHandle: null, initialHandle: null, tickRunning: false });

/** CODEBUDDY_AUTO_CHECKIN=false|0|no|off disables the scheduler (default: enabled). */
export function isCheckinEnabled(env = process.env) {
  const v = String(env.CODEBUDDY_AUTO_CHECKIN ?? "").trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  return process.env.NEXT_RUNTIME === "edge";
}

/**
 * Pure selection: every CodeBuddy OAuth connection that has a credential,
 * regardless of isActive (inactive usually means credits exhausted).
 */
export function selectCheckinConnections(connections) {
  if (!Array.isArray(connections)) return [];
  return connections.filter((conn) => {
    if (!conn || !CHECKIN_PROVIDERS.has(conn.provider)) return false;
    if (String(conn.authType || "").toLowerCase().replace(/_/g, "") !== "oauth") return false;
    return Boolean(conn.accessToken || conn.refreshToken);
  });
}

async function loadCodebuddyConnections() {
  // Dynamic import avoids a circular load with the db / app graph at module eval time.
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  const lists = await Promise.all([...CHECKIN_PROVIDERS].map((provider) => getProviderConnections({ provider })));
  return lists.flat();
}

// Same proxy resolution as the usage route; strictProxy:false falls back to direct on failure.
async function resolveProxyOptions(conn) {
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");
  const cfg = await resolveConnectionProxyConfig(conn.providerSpecificData);
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

// Existing refresh path (persists the new token to the DB). Resolves the new
// access token, or null when the refresh did not produce a different one.
async function refreshAccessToken(conn) {
  const { checkAndRefreshToken } = await import("./tokenRefresh.js");
  const next = await checkAndRefreshToken(conn.provider, conn, { force: true });
  return next?.accessToken && next.accessToken !== conn.accessToken ? next.accessToken : null;
}

function connLabel(conn) {
  return conn?.name || conn?.email || conn?.id || "unknown";
}

function pickCredit(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of CREDIT_KEYS) {
    const n = Number(data[key]);
    if (data[key] != null && data[key] !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Check in one connection. Resolves { action, code?, msg?, credit? } where action is one of:
 * checked-in | already-checked-in | inactive-campaign | not-eligible |
 * status-error | checkin-error | auth-failed | no-credential.
 * Throws only on network/unexpected errors (the tick catches per connection).
 */
export async function checkinConnection(conn, deps = {}) {
  const fetchFn = deps.fetch || proxyAwareFetch;
  const refresh = deps.refreshAccessToken || refreshAccessToken;
  const timeoutMs = deps.requestTimeoutMs || CODEBUDDY_CHECKIN_REQUEST_TIMEOUT_MS;

  const baseUrl = PROVIDER_OAUTH[conn.provider]?.baseUrl;
  if (!baseUrl) return { action: "no-credential" };

  // At most one refresh per connection per tick, whichever call needs it first.
  let refreshed = false;
  let token = conn.accessToken;
  if (!token && conn.refreshToken) {
    refreshed = true;
    token = await refresh(conn);
  }
  if (!token) return { action: "no-credential" };

  const proxyOptions = await (deps.resolveProxyOptions || resolveProxyOptions)(conn);
  const baseHeaders = {
    ...(PROVIDERS[conn.provider]?.headers || {}),
    "X-Domain": new URL(baseUrl).host,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const post = async (path) => {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    }, proxyOptions);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body: status code is all we have */ }
    return { status: res.status, json };
  };

  // 401: refresh once per connection (shared by both calls), retry that call once, never loop.
  const call = async (path) => {
    let res = await post(path);
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      const next = conn.refreshToken ? await refresh(conn) : null;
      if (next) {
        token = next;
        res = await post(path);
      }
    }
    return res;
  };

  const status = await call(STATUS_PATH);
  if (status.status === 401) return { action: "auth-failed", code: status.json?.code, msg: status.json?.msg };
  if (status.status < 200 || status.status >= 300 || status.json?.code !== 0) {
    return { action: "status-error", code: status.json?.code ?? status.status, msg: status.json?.msg };
  }
  const info = status.json.data || {};
  if (info.active !== true) return { action: "inactive-campaign", code: status.json.code, msg: status.json.msg };
  if (info.today_checked_in === true) return { action: "already-checked-in", code: status.json.code, msg: status.json.msg };
  if (info.today_checked_in !== false) return { action: "not-eligible", code: status.json.code, msg: status.json.msg };

  const result = await call(CHECKIN_PATH);
  if (result.status === 401) return { action: "auth-failed", code: result.json?.code, msg: result.json?.msg };
  const ok = result.status >= 200 && result.status < 300 && result.json?.code === 0;
  return {
    action: ok ? "checked-in" : "checkin-error",
    code: result.json?.code ?? result.status,
    msg: result.json?.msg,
    credit: ok ? (pickCredit(result.json?.data) ?? pickCredit(info)) : null,
  };
}

function formatLine(conn, outcome) {
  const parts = [`conn=${connLabel(conn)}`, `provider=${conn.provider}`, `action=${outcome.action}`];
  if (outcome.credit != null) parts.push(`credit=${outcome.credit}`);
  if (outcome.code != null) parts.push(`code=${outcome.code}`);
  if (outcome.msg) parts.push(`msg=${JSON.stringify(String(outcome.msg).slice(0, 120))}`);
  if (outcome.error) parts.push(`error=${JSON.stringify(String(outcome.error).slice(0, 160))}`);
  return parts.join(" ");
}

/**
 * One scheduler tick (never overlaps another). Fail-open per connection and at top level.
 * @param {{ loadConnections?: Function, sleep?: Function, env?: object } & object} [deps]
 *   deps are also forwarded to checkinConnection (fetch, refreshAccessToken, resolveProxyOptions, ...)
 * @returns {Promise<Array<{ id: string, provider: string, outcome: object }>|null>} per-connection
 *   outcomes, or null when skipped (disabled / a tick is already running)
 */
export async function runCodebuddyCheckinTick(deps = {}) {
  if (!isCheckinEnabled(deps.env || process.env) || state.tickRunning) return null;
  state.tickRunning = true;
  const results = [];
  try {
    const load = deps.loadConnections || loadCodebuddyConnections;
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const connections = selectCheckinConnections(await load());

    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      let outcome;
      try {
        outcome = await checkinConnection(conn, deps);
        log.info(TAG, formatLine(conn, outcome));
      } catch (err) {
        outcome = { action: "error", error: err?.message ?? String(err) };
        log.warn(TAG, formatLine(conn, outcome));
      }
      results.push({ id: conn.id, provider: conn.provider, outcome });
      if (i < connections.length - 1) await sleep(CONNECTION_GAP_MS);
    }
  } catch (err) {
    log.warn(TAG, "Tick failed (swallowed)", { error: err?.message ?? String(err) });
  } finally {
    state.tickRunning = false;
  }
  return results;
}

/**
 * Start the scheduler: first tick after a short delay, then every interval.
 * Idempotent; no-op when disabled via CODEBUDDY_AUTO_CHECKIN=false.
 * @param {{ intervalMs?: number, initialDelayMs?: number }} [opts]
 * @returns {boolean} true if started by this call
 */
export function startCodebuddyCheckin({ intervalMs, initialDelayMs } = {}) {
  if (state.started) return false;
  if (!isCheckinEnabled()) {
    log.info(TAG, "Auto check-in disabled (CODEBUDDY_AUTO_CHECKIN=false)");
    return false;
  }
  if (isNonServerRuntime()) return false;

  state.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : CODEBUDDY_CHECKIN_INTERVAL_MS;
  const firstDelay = Number.isFinite(initialDelayMs) && initialDelayMs >= 0 ? initialDelayMs : CODEBUDDY_CHECKIN_INITIAL_DELAY_MS;

  const safeTick = () => {
    runCodebuddyCheckinTick().catch((err) => {
      log.warn(TAG, "Unhandled tick rejection (swallowed)", { error: err?.message ?? String(err) });
    });
  };

  state.initialHandle = setTimeout(safeTick, firstDelay);
  if (state.initialHandle.unref) state.initialHandle.unref();
  state.intervalHandle = setInterval(safeTick, period);
  if (state.intervalHandle.unref) state.intervalHandle.unref();
  log.info(TAG, `Scheduler started: first tick in ${firstDelay}ms, then every ${period}ms`);
  return true;
}

export function stopCodebuddyCheckin() {
  if (state.initialHandle) clearTimeout(state.initialHandle);
  if (state.intervalHandle) clearInterval(state.intervalHandle);
  state.initialHandle = null;
  state.intervalHandle = null;
  state.started = false;
}
