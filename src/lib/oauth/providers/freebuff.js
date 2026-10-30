import { randomUUID } from "node:crypto";
import { FREEBUFF_CONFIG } from "../constants/oauth.js";

// Device-code sign-in of the official Freebuff Desktop (0.0.200), NOT the Codebuff CLI flow.
// Mirrors the Desktop orchestrator's Login.issue() / Login.poll(), auth host https://freebuff.com:
//   POST /api/auth/cli/code   { fingerprintId: <uuid> }                  -> { loginUrl, fingerprintHash, expiresAt, expiresInMs }
//   GET  /api/auth/cli/status ?fingerprintId&fingerprintHash&expiresAt   -> 401 while pending, { user: { authToken, id, email, name } } once approved
// The login page is opened with ?cli_flow=<cliFlowId> appended to loginUrl. The status endpoint
// verifies an HMAC over (fingerprintId, expiresAt), so all three values must be echoed back unchanged.
// They travel through the generic device flow packed in the opaque `device_code` string.
const DEFAULT_AUTH_HOST = "https://freebuff.com";
const DEFAULT_CODE_LIFETIME_MS = 60 * 60 * 1000;
const MAX_CODE_LIFETIME_MS = 2 * 60 * 60 * 1000;
const POLL_INTERVAL_SEC = 5;
// Same request timeouts the Desktop uses (ISSUE_REQUEST_TIMEOUT_MS / POLL_REQUEST_TIMEOUT_MS).
const ISSUE_TIMEOUT_MS = 15000;
const POLL_TIMEOUT_MS = 10000;

// The Desktop identifies as Freebuff-CLI/<version> (CODEBUFF_CLI_VERSION in the binary); Node's fetch
// would otherwise say "node", so the User-Agent is set explicitly.
const FREEBUFF_CLI_VERSION = process.env.FREEBUFF_CLI_VERSION || "0.0.200";
const FREEBUFF_UA = `Freebuff-CLI/${FREEBUFF_CLI_VERSION}`;

function canonicalizeHost(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return String(raw).replace(/\/+$/, "");
  }
}

// FREEBUFF_AUTH_HOST repoints the whole login (the Desktop honours the same variable); otherwise the
// registry URLs apply, with the Desktop host as the last resort.
function endpoint(config, key, fallbackPath) {
  const override = (process.env.FREEBUFF_AUTH_HOST || "").trim();
  if (override) return `${canonicalizeHost(override)}${fallbackPath}`;
  return (config && config[key]) || `${DEFAULT_AUTH_HOST}${fallbackPath}`;
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

// Desktop validateHostedLoginUrl(): the login page must live on the auth host and carry no credentials.
function validateLoginUrl(value, authOrigin) {
  if (typeof value !== "string") throw new Error("Freebuff device code response is missing loginUrl");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Freebuff device code response has an invalid loginUrl");
  }
  if (url.origin !== authOrigin) throw new Error("Freebuff device code response has an unexpected loginUrl origin");
  if (url.username || url.password) throw new Error("Freebuff device code response has unexpected loginUrl credentials");
  return url;
}

function codeLifetimeMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_CODE_LIFETIME_MS;
  return Math.min(ms, MAX_CODE_LIFETIME_MS);
}

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",

  requestDeviceCode: async (config) => {
    const codeUrl = endpoint(config, "deviceCodeUrl", "/api/auth/cli/code");
    const fingerprintId = randomUUID();
    const cliFlowId = randomUUID();

    const response = await fetch(codeUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": FREEBUFF_UA },
      body: JSON.stringify({ fingerprintId }),
      signal: AbortSignal.timeout(ISSUE_TIMEOUT_MS),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Freebuff device code request failed (${response.status}): ${error.slice(0, 300)}`);
    }

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw new Error("Freebuff device code response is invalid");

    const loginUrl = validateLoginUrl(data.loginUrl, new URL(codeUrl).origin);
    loginUrl.searchParams.set("cli_flow", cliFlowId);

    const fingerprintHash = typeof data.fingerprintHash === "string" ? data.fingerprintHash.trim() : "";
    if (!fingerprintHash) throw new Error("Freebuff device code response is missing fingerprintHash");

    const expiresAt = Number(data.expiresAt);
    if (!Number.isInteger(expiresAt) || expiresAt <= 0) {
      throw new Error("Freebuff device code response has an invalid expiresAt");
    }

    return {
      device_code: JSON.stringify({ fingerprintId, fingerprintHash, expiresAt, cliFlowId }),
      // Short form of the fingerprint for the modal; the Desktop login page itself needs no code.
      user_code: fingerprintId.slice(0, 8),
      verification_uri: loginUrl.toString(),
      verification_uri_complete: loginUrl.toString(),
      expires_in: Math.floor(codeLifetimeMs(data.expiresInMs) / 1000),
      interval: POLL_INTERVAL_SEC,
    };
  },

  pollToken: async (config, deviceCode) => {
    const { fingerprintId, fingerprintHash, expiresAt, cliFlowId } = parseDeviceCode(deviceCode);

    const url = new URL(endpoint(config, "tokenUrl", "/api/auth/cli/status"));
    if (fingerprintId) url.searchParams.set("fingerprintId", fingerprintId);
    if (fingerprintHash) url.searchParams.set("fingerprintHash", fingerprintHash);
    if (expiresAt) url.searchParams.set("expiresAt", String(expiresAt));

    // No custom headers beyond the runtime's own User-Agent, like the Desktop's poll.
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": FREEBUFF_UA },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
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
          _cliFlowId: cliFlowId,
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
      // Tells Desktop-flow connections apart from older ones minted through the Codebuff CLI flow.
      freebuffAuthOrigin: "desktop",
      cliFlowId: tokens._cliFlowId,
    },
  }),
};

export default freebuff;
