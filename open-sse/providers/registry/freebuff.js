/**
 * Freebuff (Codebuff free mode, https://www.codebuff.com)
 *
 * Source of truth: the open-source Codebuff repo (free-mode constants) cross-checked against the
 * strings of the Freebuff CLI 0.0.200 binary. The chat endpoint only answers the CLI handshake
 * (free session + agent run + codebuff_metadata), which open-sse/executors/freebuff.js implements.
 *
 * Model ids are the wire ids of the CLI model picker (free tier only). The first entry is the
 * upstream fallback model (FALLBACK_FREEBUFF_MODEL_ID): unmetered and open at every hour.
 * Models the picker meters through the daily premium pool are still free to the account.
 */
export default {
  id: "freebuff",
  priority: 25,
  hasFree: true,
  alias: "cb",
  aliases: ["codebuff"],
  uiAlias: "cb",
  display: {
    name: "Freebuff",
    icon: "bolt",
    color: "#6366F1",
    textIcon: "FB",
    website: "https://www.codebuff.com",
    notice: {
      text: "Free coding models from Codebuff. Sign in with the device code flow or paste a Codebuff auth token. Requests always leave this server directly: relay proxy pools are bypassed.",
      signupUrl: "https://www.codebuff.com",
    },
  },
  category: "free",
  hasOAuth: true,
  authType: "oauth",
  authModes: ["oauth", "apikey"],
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
    timeoutMs: 120000,
  },
  models: [
    { id: "mimo/mimo-v2.5", name: "MiMo 2.6 Flash (Free)" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash (Free)" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4.1 Flash (Free, trains on prompts)" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna (Free)" },
    { id: "mimo/mimo-v2.6-pro", name: "MiMo 2.6 Pro (Free)" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash (Free)" },
    { id: "upstage/solar-mini4", name: "Solar Mini 4 (Free)" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4 (Free)" },
    { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha (Free, Beta)" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 (Free, trains on prompts)" },
  ],
  oauth: {
    deviceCodeUrl: "https://www.codebuff.com/api/auth/cli/code",
    tokenUrl: "https://www.codebuff.com/api/auth/cli/status",
  },
  // Unknown ids reach the executor, which answers a clean 400 when it has no agent id for them.
  passthroughModels: true,
};
