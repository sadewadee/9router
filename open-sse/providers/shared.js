import { platform, arch } from "os";

// === OS/Arch helpers (Stainless fingerprint) ===
export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

// Anthropic API version (single source — reused across claude-format providers/executors)
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const CLAUDE_CLI_VERSION = "2.1.258";

// Shared Claude-compatible API headers (reused across claude-format providers)
export const CLAUDE_API_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,interleaved-thinking-2025-05-14"
};

// ZCode desktop client fingerprint (mirrors buildCliZCodeSourceHeaders in the ZCode repo).
// Z.ai bills Coding Plan traffic that enters via the official ZCode gateway (zcode.z.ai)
// at the ZCode rate; the gateway expects these static client headers. Bump ZCODE_APP_VERSION
// to track the current ZCode release (root package.json "version").
export const ZCODE_APP_VERSION = "3.16.1";
export const ZCODE_SOURCE_HEADERS = {
  "HTTP-Referer": "https://zcode.z.ai",
  "User-Agent": `ZCode/${ZCODE_APP_VERSION}`,
  "X-ZCode-App-Version": ZCODE_APP_VERSION,
  "X-Title": "Z Code@electron",
  "X-Release-Channel": "production",
  "X-Client-Language": "en-US",
  "X-Client-Timezone": "Asia/Singapore",
  "X-ZCode-Agent": "glm",
  "X-Platform": "darwin-arm64",
  "X-Os-Category": "macos",
  "X-Os-Version": "25.6.0"
};

// Full Claude CLI fingerprint — required by providers that gate on client identity (e.g. agentrouter)
export const CLAUDE_CLI_SPOOF_HEADERS = {
  "Anthropic-Version": ANTHROPIC_API_VERSION,
  "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
  "Anthropic-Dangerous-Direct-Browser-Access": "true",
  "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
  "X-App": "cli",
  "X-Stainless-Helper-Method": "stream",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime-Version": "v24.14.0",
  "X-Stainless-Package-Version": "0.80.0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Arch": mapStainlessArch(),
  "X-Stainless-Os": mapStainlessOs(),
  "X-Stainless-Timeout": "600"
};

const ANTHROPIC_BETA_BASE = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "fast-mode-2026-02-01",
  "redact-thinking-2026-02-12",
  "token-efficient-tools-2026-03-28",
];
const ANTHROPIC_BETA_HEAVY_AGENT = ["advanced-tool-use-2025-11-20", "effort-2025-11-24"];

// Heavy-agent beta flags are gated to opus/sonnet — cheaper models don't need them.
// `redact-thinking` asks Anthropic to return signature-only thinking blocks, which
// is right for clients that never render thinking but blanks the summaries a
// client explicitly requested with `thinking.display: "summarized"`.
const ANTHROPIC_BETA_REDACT_THINKING = "redact-thinking-2026-02-12";

export function wantsThinkingSummaries(body) {
  return body?.thinking?.display === "summarized";
}

export function selectAnthropicBeta(model = "", body = null) {
  const flags = ANTHROPIC_BETA_BASE.filter((flag) => flag !== ANTHROPIC_BETA_REDACT_THINKING || !wantsThinkingSummaries(body));
  if (/^claude-(opus|sonnet)/.test(model)) flags.push(...ANTHROPIC_BETA_HEAVY_AGENT);
  return flags.join(",");
}

// Shared baseUrls
export const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/v1/messages";

// Default base for dynamic compat providers (openai-compatible-* / anthropic-compatible-*) when user gives no baseUrl
export const OPENAI_COMPAT_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_COMPAT_BASE = "https://api.anthropic.com/v1";

// OpenCode Free: /zen/v1 403s every free model since 2026-10-14 (FreeTierError). The v2 CLI
// (2.1.4) takes its endpoints and client identity from the official catalog
// (models.opencode.ai/api.json): chat/responses on /inference/openai/v1, UA
// "opencode/<channel>/<version>/<client>" plus the AI SDK suffix. The v1 shape
// (/inference/v1, "opencode/1.19.0 ai-sdk/..." UA, x-opencode-request) is retired; ops can
// still point the executor back at the legacy base with OPENCODE_FREE_BASE_URL.
export const OPENCODE_FREE_BASE = "https://opencode.ai/inference/openai/v1";
// The /models list was only ever verified on the legacy path, so the model fetcher stays there.
export const OPENCODE_FREE_LEGACY_BASE = "https://opencode.ai/inference/v1";
export const OPENCODE_UA = "opencode/latest/2.1.4/cli ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.4";
export const OPENCODE_CLIENT = "cli";

// Official Antigravity IDE Desktop 2.11.0 fingerprint captured from macOS arm64.
// Keep this static even when 9router runs on Linux: the provider profile is
// intentionally matching the IDE client, not the server host.
export const ANTIGRAVITY_IDE_VERSION = "2.11.0";
export const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_IDE_USER_AGENT = `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} darwin/arm64`;

// WorkBuddy International desktop client identity, from a packet capture of desktop
// WorkBuddy 5.8.4 (2026-10-16). The chat UA's CLI/<v> tail is the CLI bundled in the
// desktop app, not the app itself; non-chat calls (login, refresh, billing) send the
// single-segment WorkBuddy/<v>. Ops can bump these without a rebuild: see
// utils/workbuddyIdentity.js (WORKBUDDY_CLIENT_VERSION, WORKBUDDY_CLI_VERSION, WORKBUDDY_CHAT_UA).
export const WORKBUDDY_CLIENT_VERSION = "5.8.4";
export const WORKBUDDY_CLI_VERSION = "2.161.0";
export const WORKBUDDY_APP_NAME = "workbuddy-ai";
export const workbuddyChatUa = (version = WORKBUDDY_CLIENT_VERSION, cliVersion = WORKBUDDY_CLI_VERSION) =>
  `WorkBuddy/${version} ${WORKBUDDY_APP_NAME}/${version} CLI/${cliVersion}`;
export const workbuddyBillingUa = (version = WORKBUDDY_CLIENT_VERSION) => `WorkBuddy/${version}`;

// Antigravity OAuth client credentials (public CLI client — duplicated in usage.js + src/lib/oauth)
export const ANTIGRAVITY_OAUTH_CLIENT = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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"
};

// Gemini (Google) OAuth client credentials (public CLI client — shared by gemini, gemini-cli, src/lib/oauth)
export const GOOGLE_OAUTH_CLIENT = {
  clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
  clientSecret: "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"
};
