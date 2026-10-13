import { randomBytes } from "node:crypto";
import { FREEBUFF_CONFIG } from "../constants/oauth.js";

// Device-code sign-in of the Freebuff / Codebuff CLI:
//   POST /api/auth/cli/code   { fingerprintId }                          -> { loginUrl, fingerprintHash, expiresAt, expiresInMs }
//   GET  /api/auth/cli/status ?fingerprintId&fingerprintHash&expiresAt   -> 401 while pending, { user: { authToken, ... } } once approved
// The status endpoint verifies an HMAC over (fingerprintId, expiresAt), so all three values must be echoed
// back unchanged. They travel through the generic device flow packed in the opaque `device_code` string.
const FREEBUFF_API = "https://www.codebuff.com";
const DEFAULT_CODE_LIFETIME_MS = 60 * 60 * 1000;
const POLL_INTERVAL_SEC = 5;
const REQUEST_TIMEOUT_MS = 20000;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Same shape the CLI itself falls back to ("codebuff-cli-" + 8 base64url chars).
function newFingerprintId() {
  return `codebuff-cli-${randomBytes(6).toString("base64url").slice(0, 8)}`;
}

function endpoint(config, key, fallbackPath) {
  return (config && config[key]) || `${FREEBUFF_API}${fallbackPath}`;
}

function parseDeviceCode(deviceCode) {
  if (typeof deviceCode === "string" && deviceCode.startsWith("{")) {
    try {
      return JSON.parse(deviceCode);
    } catch {
      // fall through to the bare fingerprint form
    }
  }
  return { fingerprintId: deviceCode };
}

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",

  requestDeviceCode: async (config) => {
    const fingerprintId = newFingerprintId();
    const response = await fetch(endpoint(config, "deviceCodeUrl", "/api/auth/cli/code"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": BROWSER_UA,
      },
      body: JSON.stringify({ fingerprintId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Freebuff device code request failed (${response.status}): ${error.slice(0, 300)}`);
    }

    const data = await response.json();
    if (!data.loginUrl || !data.fingerprintHash || !data.expiresAt) {
      throw new Error("Freebuff device code response is missing loginUrl/fingerprintHash/expiresAt");
    }

    const expiresInMs = Number(data.expiresInMs) > 0 ? Number(data.expiresInMs) : DEFAULT_CODE_LIFETIME_MS;

    return {
      device_code: JSON.stringify({
        fingerprintId,
        fingerprintHash: data.fingerprintHash,
        expiresAt: data.expiresAt,
      }),
      // The web page asks the user to confirm this fingerprint; show its short form.
      user_code: fingerprintId.replace(/^codebuff-cli-/, ""),
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      expires_in: Math.floor(expiresInMs / 1000),
      interval: POLL_INTERVAL_SEC,
    };
  },

  pollToken: async (config, deviceCode) => {
    const { fingerprintId, fingerprintHash, expiresAt } = parseDeviceCode(deviceCode);

    const url = new URL(endpoint(config, "tokenUrl", "/api/auth/cli/status"));
    if (fingerprintId) url.searchParams.set("fingerprintId", fingerprintId);
    if (fingerprintHash) url.searchParams.set("fingerprintHash", fingerprintHash);
    if (expiresAt) url.searchParams.set("expiresAt", expiresAt);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // 401 = the user has not approved the login yet.
    if (response.status === 401) {
      return { ok: false, data: { error: "authorization_pending" } };
    }
    if (!response.ok) {
      const text = await response.text();
      return {
        ok: false,
        data: { error: "poll_failed", error_description: `HTTP ${response.status}: ${text.slice(0, 300)}` },
      };
    }

    const data = await response.json();
    // Current servers answer { user: {...} }; older ones used { default: {...} } or a bare user object.
    const user = data.user || data.default || (data.authToken ? data : null);
    if (user && user.authToken) {
      return {
        ok: true,
        data: {
          access_token: user.authToken,
          _userId: user.id,
          _email: user.email,
          _name: user.name,
          _fingerprintId: user.fingerprintId || fingerprintId,
          _fingerprintHash: user.fingerprintHash || fingerprintHash,
        },
      };
    }
    return { ok: false, data: { error: "authorization_pending" } };
  },

  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: null,
    expiresIn: null,
    email: tokens._email || null,
    displayName: tokens._name || tokens._email || "Freebuff User",
    name: tokens._name || tokens._email || "Freebuff User",
    providerSpecificData: {
      userId: tokens._userId,
      fingerprintId: tokens._fingerprintId,
      fingerprintHash: tokens._fingerprintHash,
    },
  }),
};

export default freebuff;
