import { WORKBUDDY_CLIENT_VERSION, workbuddyChatUa } from "../shared.js";

// WorkBuddy International (workbuddy.ai) — Tencent's desktop agent. Same
// CodeBuddy platform/gateway as codebuddy-intl, but a separate realm: accounts,
// domain and client fingerprint differ, and accounts are not shared between
// codebuddy.ai and workbuddy.ai. Wire protocol: stream-only /v2/chat/completions,
// no PKCE login, refresh via X-Refresh-Token. Chat goes out as the desktop client
// (WorkBuddy 5.8.4 packet capture, see shared.js); a wrong platform segment in the
// User-Agent is answered with 403 code 11140 ("request illegal"). The UA and
// X-IDE-Version below are defaults: WorkBuddyExecutor re-reads WORKBUDDY_CLIENT_VERSION /
// WORKBUDDY_CLI_VERSION / WORKBUDDY_CHAT_UA on every request.
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
    // Desktop client chat fingerprint. The executor adds the per-request part:
    // X-User-Id, Accept, the conversation and trace id families. The desktop's chat
    // calls carry no X-Machine-ID / X-Session-ID (those ride billing calls only).
    headers: {
      "User-Agent": workbuddyChatUa(),
      "X-Requested-With": "XMLHttpRequest",
      "X-CodeBuddy-Request": "1",
      "Origin": "https://www.workbuddy.ai",
      "Referer": "https://www.workbuddy.ai/",
      "Accept-Language": "en-US",
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
      "X-Agent-Type": "main",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Version": WORKBUDDY_CLIENT_VERSION,
      "X-Private-Data": "true",
      "X-Product": "SaaS",
      "X-Domain": "www.workbuddy.ai",
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
    origin: "https://www.workbuddy.ai",
    domain: "www.workbuddy.ai",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
  },
};
