import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { ANTHROPIC_API_VERSION, OPENCODE_UA, OPENCODE_CLIENT } from "../providers/shared.js";
import { estimateInputTokens } from "../utils/usageTracking.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// OpenCode free tier requires the lowercase tool quartet 'bash', 'glob',
// 'grep' and 'read' in the tools payload (verified by live bisection 2026-09-18:
// tools without the full quartet get 403 FreeTierError even when bash/read exist).
// Live bisection 2026-10-14 on /inference/v1 tightened it: each of the four must
// ALSO carry OpenCode's own description sentence (`sig`) and its required
// parameter. Placeholder descriptions or empty schemas 403 as well, and so does a
// second tool with the same lowercase name. A tool that differs only by case
// (Claude Code's Bash/Read/Glob/Grep) coexists fine.
// Injected as cloaked decoys so external CLI tools take precedence while
// satisfying upstream verification.
const OPENCODE_GATE_TOOLS = {
  bash: {
    sig: "IMPORTANT: This tool is for terminal operations",
    description: "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.",
    properties: {
      command: { type: "string", description: "The command to execute" },
      timeout: { type: "integer", description: "Optional timeout in milliseconds" },
      workdir: { type: "string", description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands." },
    },
    required: ["command"],
  },
  glob: {
    sig: "Fast file pattern matching tool",
    description: "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      path: { type: "string", description: "The directory to search in. If not specified, the current working directory will be used." },
    },
    required: ["pattern"],
  },
  grep: {
    sig: "Fast content search tool",
    description: "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Returns file paths and line numbers with matching lines",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for in file contents" },
      path: { type: "string", description: "The directory to search in. Defaults to the current working directory." },
      include: { type: "string", description: "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")" },
    },
    required: ["pattern"],
  },
  read: {
    sig: "Read a file or directory from the local filesystem",
    description: "Read a file or directory from the local filesystem. If the path does not exist, an error is returned.",
    properties: {
      filePath: { type: "string", description: "The absolute path to the file or directory to read" },
      offset: { type: "integer", description: "The line number to start reading from (1-indexed)" },
      limit: { type: "integer", description: "The maximum number of lines to read (defaults to 2000)" },
    },
    required: ["filePath"],
  },
};
const OPENCODE_GATE_NAMES = Object.keys(OPENCODE_GATE_TOOLS);
const OPENCODE_DECOY_NOTE = " This tool is currently unavailable and must not be used.";

function opencodeDecoy(name, isResponses) {
  const { description, properties, required } = OPENCODE_GATE_TOOLS[name];
  const def = {
    name,
    description: description + OPENCODE_DECOY_NOTE,
    parameters: { type: "object", properties: structuredClone(properties), required: [...required] },
  };
  return isResponses ? { type: "function", ...def } : { type: "function", function: def };
}

// Does a caller tool that owns a quartet name already pass the upstream gate
// (i.e. it is OpenCode's own definition)? Case-sensitive on purpose: a false
// negative only costs an alias, a false positive costs a 403.
function meetsOpencodeGate(name, def) {
  const { sig, required } = OPENCODE_GATE_TOOLS[name];
  const params = def.parameters;
  return typeof def.description === "string" && def.description.includes(sig)
    && Array.isArray(params?.required)
    && required.every((k) => params.required.includes(k) && params.properties?.[k]);
}

function cloakOpencodeTools(body, isResponses, credentials) {
  if (!body || typeof body !== "object") return;
  const toolNameMap = credentials?._opencodeToolNameMap || new Map();
  if (credentials) credentials._opencodeToolNameMap = toolNameMap;
  if (!Array.isArray(body.tools)) body.tools = [];

  const satisfied = new Set();
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    const def = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = typeof def.name === "string" ? def.name : "";
    const lower = name.trim().toLowerCase();
    if (!OPENCODE_GATE_TOOLS[lower]) continue;
    if (name !== lower) {
      // Differently-cased caller tool (Claude Code's Bash): it coexists with the
      // lowercase decoy. Should the model call the decoy anyway, hand the call
      // back to the caller's real tool.
      toolNameMap.set(lower, name);
      continue;
    }
    if (meetsOpencodeGate(name, def)) {
      satisfied.add(name);
      continue;
    }
    // A caller tool that owns the exact lowercase name without being OpenCode's
    // would duplicate it (403): move it aside under an alias, map the model's
    // calls back to the original name, and let the decoy take the quartet slot.
    const alias = `${name}_ext`;
    def.name = alias;
    toolNameMap.set(alias, name);
    const choice = body.tool_choice;
    const chosen = isResponses ? choice : choice?.function;
    if (chosen && typeof chosen === "object" && chosen.name === name) chosen.name = alias;
  }

  for (const name of OPENCODE_GATE_NAMES) {
    if (!satisfied.has(name)) body.tools.push(opencodeDecoy(name, isResponses));
  }
  // tool_choice "none" 403s too (live 2026-10-14): the gate wants tools enabled,
  // so the decoys stay callable in principle and rely on their "unavailable" note.
  if (!body.tool_choice || body.tool_choice === "none") body.tool_choice = "auto";
}

// A downstream UA is forwarded only when it is a genuine official one:
// - v2 CLI: "opencode/<channel>/<x.y.z>/<client>", optionally followed by the AI SDK
//   suffix (" ai-sdk/provider-utils/<v> runtime/<rt>"), major >= 2.
// - v1 client: /inference 403s a bare "opencode/<ver>" UA and 426s anything older
//   than 1.18 (live 2026-10-14), so it must be the full
//   "opencode/<ver> ai-sdk/... runtime/..." form, >= 1.18.
const OPENCODE_V2_UA_RE = /^opencode\/[a-z0-9._-]+\/(\d+)\.\d+\.\d+\/[a-z0-9._-]+(?: .+)?$/i;

function isOfficialOpencodeUa(ua) {
  const text = String(ua || "").trim();
  const v2 = text.match(OPENCODE_V2_UA_RE);
  if (v2) return parseInt(v2[1], 10) >= 2;
  const m = text.match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m || !text.includes(" ai-sdk/")) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 18);
}
// Models served by /responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
const MESSAGES_MODELS = new Set(["union-alpha"]);

let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;

  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

// Upstream validates that the 12-hex prefix of ses_ ids is a real
// timestamp-encoded value (48 bits = ms << 12 | counter), not random hash
// bytes (decolua/9router#4780; 403 FreeTierError otherwise).
function encodeTimeHex(value) {
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
}

export function translateSessionId(sessionId, clientTool = "", timestamp = Date.now()) {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  // A downstream session keeps ONE stable ses_ id (like a real OpenCode
  // session), so cache the translation per (clientTool, sessionId).
  const cacheKey = `opencode:tr:${clientTool || "generic"}:${sessionId || ""}`;
  const existing = stableOpencodeSessions.get(cacheKey);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(cacheKey);
    stableOpencodeSessions.set(cacheKey, existing);
    return existing.sessionId;
  }
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  // Session ids are descending (inverted), same as generateSessionId().
  const timeHex = encodeTimeHex(~(BigInt(timestamp) * 0x1000n + BigInt(counter)));
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  const id = `ses_${timeHex}${randomPart}`;
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(cacheKey, { sessionId: id, lastUsed: Date.now() });
  return id;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isMessagesModel(model) {
  return MESSAGES_MODELS.has(baseModelId(model));
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  // rotated override (set after upstream 500s) wins over any derived session
  const overrideIdentity = identityKey(credentials)
    ? identityKey(credentials) + ":" + baseModelId(String(body?.model || ""))
    : null;
  const overridden = overrideIdentity ? opencodeSessionOverrides.get(overrideIdentity) : null;
  if (overridden?.session) return overridden.session;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: OpenCode Free uses public/pooled credentials
    // (`Bearer public`) routing to an upstream OpenAI/Console account pool.
    // OpenAI Responses API strictly enforces that reasoning `encrypted_content`
    // can only be decrypted by the exact caller/account that issued it; sending it
    // across different accounts or rotating proxy relays triggers:
    // [invalid_request_error] reasoning `encrypted_content` was not issued to this caller (400).
    // Furthermore, under stateless mode (store=false), omitting encrypted_content
    // causes OpenAI to reject the referenced reasoning item as "not found or was deleted".
    // Dropping prior reasoning items allows multi-turn conversations and tool-calling
    // loops to succeed cleanly.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

// Session overrides: when upstream answers 500 [server_error] for a request
// whose session is deterministically derived from the conversation id (real
// clients), that exact upstream session can be poisoned server-side and every
// retry keeps hitting it (observed live 2026-09-18: one conversation 500'd for
// ~40 min while fresh sessions succeeded in the same seconds). Store a freshly
// minted session per identity on 500; drop it once a request succeeds.
const opencodeSessionOverrides = new Map(); // identityKey -> { session, setAt }
const MAX_SESSION_OVERRIDES = 500;

// The v2 CLI sends promptCacheKey = affinity id, minus the "ses_" prefix when it is
// the 64-hex form (packages/core/src/session/model-request.ts, v2.1.4).
const OPENCODE_SESSION_64HEX_RE = /^ses_[0-9a-f]{64}$/;

function promptCacheKey(affinity) {
  return OPENCODE_SESSION_64HEX_RE.test(affinity) ? affinity.slice(4) : affinity;
}

// v2 dropped x-opencode-request; per-request tracing is a W3C traceparent
// (version-traceId-parentId-flags, 01 = sampled).
function newTraceparent() {
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
}

// Env overrides are read per call so ops can flip them without a rebuild.
function opencodeUa() {
  return process.env.OPENCODE_UA?.trim() || OPENCODE_UA;
}

function opencodeClient() {
  return process.env.OPENCODE_CLIENT?.trim() || OPENCODE_CLIENT;
}

function freeBaseUrl(configBase) {
  return (process.env.OPENCODE_FREE_BASE_URL?.trim() || configBase).replace(/\/+$/, "");
}

// The official catalog (models.opencode.ai) serves Anthropic-format free models from
// /inference/anthropic/v1 while chat and responses share /inference/openai/v1. Any
// other base (e.g. the legacy /inference/v1 flipped in via OPENCODE_FREE_BASE_URL)
// serves every path itself.
function freeMessagesBase(base) {
  return base.replace(/\/inference\/openai\/v1$/, "/inference/anthropic/v1");
}

// Free-lane request size cap. The free allowance behaves like a token bucket keyed on
// request size (anomalyco/opencode#58751: one account, same minute, 447k-token context
// -> 429 FreeUsageLimitError, 23k-token new session -> 200; 167k fails, compacted to 49k
// passes), so big agent contexts only burn upstream quota to be refused. Requests whose
// estimated input exceeds this are refused locally; 0 disables the guard.
const DEFAULT_FREE_MAX_INPUT_TOKENS = 60000;

function freeMaxInputTokens() {
  const raw = process.env.OPENCODE_FREE_MAX_INPUT_TOKENS?.trim();
  if (!raw) return DEFAULT_FREE_MAX_INPUT_TOKENS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FREE_MAX_INPUT_TOKENS;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
    // Zen's muse free tier flaps with 500 [server_error] in short windows
    // (observed live 2026-09-18: bursts of consecutive 500s that clear within
    // minutes). DEFAULT_RETRY_CONFIG covers 502/503/504 but not 500, so every
    // flap surfaced straight to the client. Retry 500 a couple of times so the
    // window self-heals; genuinely-broken requests just pay ~5s extra latency.
    this.config.retry = { ...(this.config.retry || {}), 500: { attempts: 2, delayMs: 2500 } };
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    // Zen rejects non-streaming requests on free models with 403 FreeTierError;
    // always stream upstream and let the handler layer aggregate for non-stream clients.
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      // ponytail: chỉ model đã xác nhận auto-only; mở allowlist khi có bằng chứng.
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens and takes thinking
      // as reasoning:{effort,summary} — normalize the Chat fields at this boundary.
      if (body.max_output_tokens === undefined) {
        if (body.max_completion_tokens !== undefined) body.max_output_tokens = body.max_completion_tokens;
        else if (body.max_tokens !== undefined) body.max_output_tokens = body.max_tokens;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
      // Decoys MUST be ensured even when caller tools exist: upstream 403s
      // FreeTierError whenever any tools payload lacks the lowercase quartet
      // bash/glob/grep/read (verified live 2026-09-18; extras are allowed).
      // cloakOpencodeTools appends only missing names, so this is idempotent.
      cloakOpencodeTools(body, true, credentials);
    } else if (body && typeof body === "object") {
      cloakOpencodeTools(body, false, credentials);
    }
    // Anthropic-format /messages bodies reject unknown fields, so no cache key there.
    const session = credentials?.[SESSION_FIELD];
    if (session && body && typeof body === "object" && !isMessagesModel(model || body.model)) {
      body.prompt_cache_key = promptCacheKey(session);
    }
    return injectReasoningContent({ provider: this.provider, model, body });
  }

  // Size guard for the free lane (see freeMaxInputTokens). Returns an execute()-shaped
  // result carrying a local 413, or null when the request may go upstream.
  //
  // Why 413 with "request not allowed" in the text: chatCore turns this response into
  // an error result and the combo loop (open-sse/services/combo.js) then asks
  // checkFallbackError(status, text) whether to try the next model. A request-scoped
  // 4xx normally returns to the client without fallback (accountFallback.js), but the
  // "request not allowed" text rule matches first and yields shouldFallback=true with
  // the shortest cooldown (5s). The noAuth "opencode" connection is virtual
  // (id "noauth"), so markAccountUnavailable (src/sse/services/auth.js) returns early
  // and persists no modelLock: a size refusal never rate-limits later small requests.
  // 413 also keeps SDK clients from retrying (they retry 429/5xx) and tells a direct
  // caller exactly what happened. 429/5xx would fall back too but misreport an upstream
  // limit, so they are deliberately avoided.
  // Estimate = JSON length / 4 (shared estimator); inline base64 images inflate it,
  // which only errs towards falling back.
  refuseOversizedRequest({ model, body, log } = {}) {
    const limit = freeMaxInputTokens();
    if (!limit) return null;
    const estimate = estimateInputTokens(body);
    if (estimate <= limit) return null;
    const warning = `free lane size guard: ~${estimate} input tokens > ${limit} (${baseModelId(model)}), not sent upstream`;
    if (log?.warn) log.warn("OPENCODE", warning);
    else console.warn(`[OPENCODE] ${warning}`);
    const message = `OpenCode free lane: request not allowed, estimated input ~${estimate} tokens exceeds the ${limit} limit (OPENCODE_FREE_MAX_INPUT_TOKENS); the free allowance is keyed on request size, compact the context or use another model`;
    return {
      response: new Response(message, { status: 413, headers: { "Content-Type": "text/plain" } }),
      url: this.buildUrl(model),
      headers: {},
      transformedBody: null,
    };
  }

  async execute(args) {
    const refused = this.refuseOversizedRequest(args);
    if (refused) return refused;
    const credentials = this.prepareRequestCredentials(args);
    const result = await super.execute({ ...args, credentials });
    if (args?.credentials && credentials?._opencodeToolNameMap) {
      args.credentials._opencodeToolNameMap = credentials._opencodeToolNameMap;
    }
    try {
      const identityKeyStr = identityKey(credentials);
      const identity = identityKeyStr
        ? identityKeyStr + ":" + baseModelId(String(args?.model || ""))
        : null;
      if (result?.response?.status === 500) {
        try {
          const dbgSes = credentials?.[SESSION_FIELD];
          result.response.clone().text().then((t) => {
            console.error("[OC-DEBUG] 500 ses=" + String(dbgSes).slice(0, 40)
              + " model=" + String(args?.model || "") + " body=" + String(t).slice(0, 400));
          }).catch(() => { });
        } catch { }
      }
      if (identity && result?.response?.status === 500) {
        // poisoned or broken upstream session: rotate so the next attempt (and
        // the built-in retries of that attempt) uses a freshly minted session
        if (opencodeSessionOverrides.size >= MAX_SESSION_OVERRIDES) opencodeSessionOverrides.clear();
        opencodeSessionOverrides.set(identity, { session: generateSessionId(), setAt: Date.now() });
      } else if (identity && result?.response?.status && result.response.status < 400) {
        opencodeSessionOverrides.delete(identity);
      }
    } catch {
      // rotation is best-effort; never fail the request because of it
    }
    return result;
  }

  buildUrl(model) {
    const base = freeBaseUrl(this.config.baseUrl);
    if (isResponsesModel(model)) return `${base}/responses`;
    if (isMessagesModel(model)) return `${freeMessagesBase(base)}/messages`;
    return `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const isOpencodeDownstream = isOfficialOpencodeUa(downstreamUa);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];

    // Mirrors the v2.1.4 CLI (packages/core/src/session/model-request.ts). One session
    // per conversation, so id and affinity are the same value; downstream
    // x-opencode-request (v1 only) is never forwarded.
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      "x-opencode-session-id": session,
      "x-session-affinity": session,
      "X-Session-Id": session,
      "User-Agent": isOpencodeDownstream ? downstreamUa : opencodeUa(),
      "x-opencode-project": lower["x-opencode-project"] || "global",
      "x-opencode-session": session,
      "x-opencode-client": lower["x-opencode-client"] || opencodeClient(),
      "traceparent": newTraceparent(),
      "Accept": stream ? "text/event-stream" : "*/*",
    };
    if (url.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }
}
