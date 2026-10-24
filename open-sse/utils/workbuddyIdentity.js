import { createHash } from "crypto";

/**
 * WorkBuddy account identity helpers, shared by the executor, the token
 * refresh and the usage fetcher.
 */

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
 * Stable 36-hex device/session id for one account (X-Machine-ID / X-Session-ID).
 * Fixed salt, so it survives restarts; different seed -> different id, so
 * accounts never share a virtual device; `purpose` keeps the two ids apart.
 */
export function deriveWorkBuddyStableId(seed, purpose) {
  return createHash("sha256").update(`wb2a:${purpose}:${seed}`).digest("hex").slice(0, 36);
}

/** { "X-Machine-ID", "X-Session-ID" } for an account seed (uid, else connection id); {} without a seed. */
export function workBuddyDeviceHeaders(seed) {
  if (!seed) return {};
  return {
    "X-Machine-ID": deriveWorkBuddyStableId(seed, "machine"),
    "X-Session-ID": deriveWorkBuddyStableId(seed, "session"),
  };
}
