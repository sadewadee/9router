import { WORKBUDDY_CONFIG } from "../constants/oauth.js";
import { jwtSubject } from "open-sse/utils/workbuddyIdentity.js";

// WorkBuddy International (workbuddy.ai) - Browser OAuth Polling Flow, no PKCE
// 1. POST stateUrl?platform=CLI -> { state, authUrl }
// 2. Open authUrl in the browser
// 3. Poll tokenUrl?state= until success (code 0; code 11217 = still waiting)
// 4. GET accountUrl?state= with the new Bearer for uid / nickname (answers only after login)
// 5. GET registerUrl?userId= activates the new global account (idempotent)
const LOGIN_PENDING_CODE = 11217;
const REGISTER_OK_CODE = 200;
const REGISTER_REGION_CODE = 500;
const REGISTER_TIMEOUT_MS = 15000;

const REGION_REQUIRED_MESSAGE =
  "WorkBuddy account has no region yet. Open https://www.workbuddy.ai, finish the region step, then retry.";

const authHeaders = (config) => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  Origin: config.origin,
  Referer: `${config.origin}/`,
  "User-Agent": config.userAgent,
});

// Best effort: the account endpoint only enriches the connection, login works without it.
async function fetchAccount(config, state, accessToken) {
  try {
    const response = await fetch(`${config.accountUrl}?state=${encodeURIComponent(state)}`, {
      method: "GET",
      headers: { ...authHeaders(config), Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return {};
    const data = await response.json();
    return data.code === 0 ? data.data || {} : {};
  } catch {
    return {};
  }
}

// Never throws: activation must not block saving the connection.
// -> { status: "ok" | "region_required" | "failed" | "skipped", message? }
async function activateAccount(config, uid, accessToken) {
  if (!uid) return { status: "skipped" };
  try {
    const response = await fetch(`${config.registerUrl}?userId=${encodeURIComponent(uid)}`, {
      method: "GET",
      headers: { ...authHeaders(config), Authorization: `Bearer ${accessToken}`, "X-User-Id": uid },
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (!response.ok) return { status: "failed", message: `HTTP ${response.status}` };
    const body = await response.json();
    const message = body.msg || "";
    if (body.code === REGISTER_OK_CODE) return { status: "ok" };
    if (body.code === REGISTER_REGION_CODE || /region required/i.test(message)) {
      return { status: "region_required", message };
    }
    return { status: "failed", message: message || `code=${body.code}` };
  } catch (error) {
    return { status: "failed", message: error.message };
  }
}

const workbuddy = {
  config: WORKBUDDY_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const response = await fetch(`${config.stateUrl}?platform=${config.platform}`, {
      method: "POST",
      headers: authHeaders(config),
      body: "{}",
    });
    if (!response.ok) throw new Error(`WorkBuddy state request failed: ${await response.text()}`);
    const data = await response.json();
    if (data.code !== 0 || !data.data?.state || !data.data?.authUrl) {
      throw new Error(`WorkBuddy state error: ${data.msg || "missing state/authUrl"}`);
    }
    return {
      device_code: data.data.state,
      verification_uri: data.data.authUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
    };
  },
  pollToken: async (config, deviceCode) => {
    const response = await fetch(`${config.tokenUrl}?state=${encodeURIComponent(deviceCode)}`, {
      method: "GET",
      headers: authHeaders(config),
    });
    if (!response.ok) return { ok: false, data: { error: "request_failed" } };
    const data = await response.json();
    if (data.code === 0 && data.data?.accessToken) {
      const token = data.data;
      const account = await fetchAccount(config, deviceCode, token.accessToken);
      return {
        ok: true,
        data: {
          access_token: token.accessToken,
          refresh_token: token.refreshToken || "",
          token_type: token.tokenType || "Bearer",
          expires_in: token.expiresIn,
          domain: token.domain || config.domain,
          uid: account.uid || jwtSubject(token.accessToken),
          nickname: account.nickname || "",
          enterprise_id: account.enterpriseId || "",
        },
      };
    }
    if (data.code === LOGIN_PENDING_CODE) return { ok: true, data: { error: "authorization_pending" } };
    return { ok: false, data: { error: data.msg || "unknown_error" } };
  },
  postExchange: (tokens) => activateAccount(WORKBUDDY_CONFIG, tokens.uid, tokens.access_token),
  mapTokens: (tokens, activation) => {
    const status = activation?.status || "skipped";
    const lastError = status === "region_required"
      ? REGION_REQUIRED_MESSAGE
      : status === "failed"
        ? `WorkBuddy account activation failed (${activation.message}). Add the account again to retry.`
        : null;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in || 86400,
      ...(tokens.nickname ? { name: tokens.nickname, displayName: tokens.nickname } : {}),
      ...(lastError ? { lastError, lastErrorAt: new Date().toISOString() } : {}),
      providerSpecificData: {
        ...(tokens.uid ? { uid: tokens.uid } : {}),
        domain: tokens.domain,
        ...(tokens.enterprise_id ? { enterpriseId: tokens.enterprise_id } : {}),
        registerStatus: status,
      },
    };
  },
};

export default workbuddy;
