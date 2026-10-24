// WorkBuddy International (workbuddy.ai) — Tencent's desktop agent. Same
// CodeBuddy platform/gateway as codebuddy-intl, but a separate realm: accounts,
// domain and client fingerprint differ, and accounts are not shared between
// codebuddy.ai and workbuddy.ai. Wire protocol per HanawaBanana/workbuddy2api
// (realm `global`): stream-only /v2/chat/completions, no PKCE login, refresh via
// X-Refresh-Token. A wrong platform segment in the User-Agent is answered with
// 403 code 11140 ("request illegal").
export default {
  id: "workbuddy",
  alias: "wb",
  uiAlias: "wb",
  hidden: false,
  priority: 90,
  display: {
    name: "WorkBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.workbuddy.ai",
    notice: {
      signupUrl: "https://www.workbuddy.ai",
    },
  },
  category: "oauth",
  authType: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://www.workbuddy.ai/v2/chat/completions",
    forceStream: true,
    // Same unified OpenAI reasoning_effort shape as the CodeBuddy gateways.
    thinkingFormat: "openai",
    // Desktop client fingerprint (the executor adds the per-account identity
    // headers: X-User-Id, X-Machine-ID, X-Session-ID, conversation family).
    headers: {
      "User-Agent": "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
      "X-Requested-With": "XMLHttpRequest",
      "X-CodeBuddy-Request": "1",
      "Origin": "https://www.workbuddy.ai",
      "Referer": "https://www.workbuddy.ai/",
      "Accept-Language": "en-US",
      "X-No-Enterprise-Id": "1",
      "X-Domain": "www.workbuddy.ai",
      "X-Agent-Purpose": "conversation",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Version": "5.5.4",
      "X-Product": "WorkBuddy",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Global billing has no /v2 prefix; the usage fetcher falls back to the
    // /v2 path when this one answers 404 (see services/usage/codebuddy-cn.js).
    usage: {
      url: "https://www.workbuddy.ai/billing/meter/get-user-resource",
      fallbackUrl: "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // Global model catalog, live-verified union of /v3/config and
  // /v2/enterprises/personal/models on a real global account. default-model /
  // fast-model / balanced-model / primary-model / deep-model are server-side
  // routing aliases, but real routable ids (default-model is free).
  models: [
    { id: "default-model", name: "Auto" },
    { id: "fast-model", name: "Fast" },
    { id: "balanced-model", name: "Balanced" },
    { id: "primary-model", name: "Primary" },
    { id: "deep-model", name: "Deep" },
    { id: "gpt-6-astra", name: "GPT-6-Astra" },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
    { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "kimi-k3", name: "Kimi-K3" },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "hy4-preview", name: "Hy4 Preview" },
    { id: "hy4-preview-f", name: "Hy4 Preview F" },
    { id: "hy3", name: "Hy3" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ],
  oauth: {
    baseUrl: "https://www.workbuddy.ai",
    stateUrl: "https://www.workbuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.workbuddy.ai/v2/plugin/auth/token",
    accountUrl: "https://www.workbuddy.ai/v2/plugin/login/account",
    refreshUrl: "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    // Idempotent account activation every new global account needs after login.
    registerUrl: "https://www.workbuddy.ai/auth/realms/copilot/overseas/user/register",
    // Single-segment UA of the client's non-chat calls (login, billing).
    userAgent: "WorkBuddy/5.5.4",
    origin: "https://www.workbuddy.ai",
    domain: "www.workbuddy.ai",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
  },
};
