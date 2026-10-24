import { createHash, randomBytes, randomUUID } from "crypto";
import { PROVIDERS, PROVIDER_OAUTH } from "../providers/index.js";
import {
  WORKBUDDY_CLIENT_VERSION,
  WORKBUDDY_CLI_VERSION,
  workbuddyChatUa,
  workbuddyBillingUa,
} from "../providers/shared.js";

/**
 * WorkBuddy client identity: the version/User-Agent (env-overridable), the
 * account identity, and the header sets of the desktop client's call families.
 * Shared by the executor (chat), the token refresh, the usage fetcher and the
 * OAuth login.
 */

const envValue = (env, name) => String(env?.[name] ?? "").trim();

// --- client version / User-Agent -----------------------------------------
// Read per call, so a bumped env value needs a restart but never a rebuild.

/** WORKBUDDY_CLIENT_VERSION, else the captured desktop version. Feeds X-IDE-Version and both UAs. */
export function workBuddyClientVersion(env = process.env) {
  return envValue(env, "WORKBUDDY_CLIENT_VERSION") || WORKBUDDY_CLIENT_VERSION;
}

/** Chat UA: WORKBUDDY_CHAT_UA verbatim, else built from the client + bundled CLI (WORKBUDDY_CLI_VERSION) versions. */
export function workBuddyChatUserAgent(env = process.env) {
  return envValue(env, "WORKBUDDY_CHAT_UA")
    || workbuddyChatUa(workBuddyClientVersion(env), envValue(env, "WORKBUDDY_CLI_VERSION") || WORKBUDDY_CLI_VERSION);
}

/** Single-segment UA of the non-chat calls (login, refresh, billing). */
export function workBuddyBillingUserAgent(env = process.env) {
  return workbuddyBillingUa(workBuddyClientVersion(env));
}

// --- account identity ----------------------------------------------------

/** `sub` claim (the WorkBuddy user id) of a JWT access token; "" when absent. Not verified. */
export function jwtSubject(token) {
  if (typeof token !== "string") return "";
  const payload = token.split(".")[1];
  if (!payload) return "";
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims?.sub === "string" ? claims.sub : "";
  } catch {
    return "";
  }
}

/** Account uid: stored at login (providerSpecificData.uid), else the access token's `sub`. */
export function resolveWorkBuddyUid(credentials) {
  return credentials?.providerSpecificData?.uid || jwtSubject(credentials?.accessToken) || "";
}

/**
 * Stable UUID-shaped device/session id for one account. Fixed salt, so it
 * survives restarts; a different seed gives a different id, so accounts never
 * share a virtual device; `purpose` keeps the two ids apart. Version/variant
 * bits are set like the desktop's own (hyphenated v4-shaped) machine id.
 */
export function deriveWorkBuddyStableId(seed, purpose) {
  const h = createHash("sha256").update(`wb2a:${purpose}:${seed}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * { "X-Machine-ID", "X-Session-ID" } for an account seed ({} without one).
 * Billing/usage calls only: the desktop's chat calls do not carry them, so
 * sending them on chat would be a gateway signature.
 */
export function workBuddyDeviceHeaders(seed) {
  if (!seed) return {};
  return {
    "X-Machine-ID": deriveWorkBuddyStableId(seed, "machine"),
    "X-Session-ID": deriveWorkBuddyStableId(seed, "session"),
  };
}

/** Enterprise accounts add X-Enterprise-Id / X-Tenant-Id (stored at login); personal accounts add nothing. */
export function workBuddyEnterpriseHeaders(providerSpecificData) {
  const id = providerSpecificData?.enterpriseId;
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {};
}

// --- ids and trace headers ------------------------------------------------

/** RFC 9562 UUIDv7 without hyphens (32 hex): the desktop's request/message/trace id shape. */
export function uuidv7Hex(now = Date.now()) {
  const timestamp = (BigInt(now) & 0xffffffffffffn).toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  const variant = "89ab"[parseInt(rand[3], 16) & 3];
  return `${timestamp}7${rand.slice(0, 3)}${variant}${rand.slice(4, 19)}`;
}

/** Desktop chat trace family: one random trace id and one random span id per request, no parent span. */
export function workBuddyTraceHeaders() {
  const trace = uuidv7Hex();
  const span = randomBytes(8).toString("hex");
  return {
    "X-Trace-ID": trace,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1`,
    "X-B3-TraceId": trace,
    "X-B3-SpanId": span,
    "X-B3-Sampled": "1",
  };
}

// --- non-chat call families (refresh, billing) ------------------------------

// Browser-style headers the desktop sends on its non-chat calls.
function nonChatHeaders(env) {
  const registry = PROVIDERS["workbuddy"]?.headers || {};
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": registry["X-Requested-With"],
    "User-Agent": workBuddyBillingUserAgent(env),
    Origin: registry["Origin"],
    Referer: registry["Referer"],
    "X-CodeBuddy-Request": registry["X-CodeBuddy-Request"],
    "Accept-Language": registry["Accept-Language"],
  };
}

const accountDomain = (providerSpecificData) => providerSpecificData?.domain || PROVIDER_OAUTH["workbuddy"]?.domain;

/**
 * Billing / usage headers (the caller adds Authorization). The only calls that
 * carry the per-account X-Machine-ID / X-Session-ID (seeded by the uid).
 */
export function buildWorkBuddyBillingHeaders(credentials, env = process.env) {
  const uid = resolveWorkBuddyUid(credentials);
  const enterprise = workBuddyEnterpriseHeaders(credentials?.providerSpecificData);
  return {
    ...nonChatHeaders(env),
    "X-Domain": accountDomain(credentials?.providerSpecificData),
    ...(uid ? { "X-User-Id": uid } : {}),
    "X-Request-ID": randomUUID().replace(/-/g, ""),
    ...workBuddyDeviceHeaders(uid),
    ...(Object.keys(enterprise).length ? enterprise : { "X-No-Enterprise-Id": "1" }),
  };
}

/** Token refresh headers: the refresh token rides X-Refresh-Token, never Authorization; no device ids. */
export function buildWorkBuddyRefreshHeaders(refreshToken, credentials, env = process.env) {
  const uid = resolveWorkBuddyUid(credentials);
  const enterpriseId = credentials?.providerSpecificData?.enterpriseId;
  return {
    ...nonChatHeaders(env),
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    ...(uid ? { "X-User-Id": uid } : {}),
    "X-Domain": accountDomain(credentials?.providerSpecificData),
    ...(enterpriseId ? { "X-Enterprise-Id": enterpriseId } : {}),
  };
}
