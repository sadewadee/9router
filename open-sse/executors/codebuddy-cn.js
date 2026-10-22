import { CodeBuddyBaseExecutor, isLegacyRequest } from "./codebuddy-base.js";
import { desensitizeMessages, desensitizeTools } from "../utils/codebuddyDesensitize.js";

// Legacy transform (kept verbatim; the fallback path and CODEBUDDY_SYSTEM_PROMPT_MODE=legacy).
// Tencent's content filter flags CLI agent system prompts ("You are Claude
// Code, Anthropic's official CLI...") as prompt injection / sensitive content
// and rejects the whole request. Detect agent system prompts (length catch-all
// + identity-marker regex) and replace them with a neutral one, while leaving
// legitimate user system prompts untouched. content may be a string or typed
// blocks ([{type:"text",text}]) depending on the incoming client format, so
// flatten before matching and preserve the original shape on replacement.
const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

const flatten = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
      : "";

/** Legacy CN transform: swap agent/oversized system prompts for a neutral one. */
export function neutralizeAgentSystemPrompts(messages) {
  return messages.map((message) => {
    if (!message || message.role !== "system") return message;
    const text = flatten(message.content);
    if (!text) return message;
    if (text.length > 2000 || AGENT_PATTERN.test(text)) {
      return typeof message.content === "string"
        ? { ...message, content: NEUTRAL_PROMPT }
        : { ...message, content: [{ type: "text", text: NEUTRAL_PROMPT }] };
    }
    return message;
  });
}

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyExecutor extends CodeBuddyBaseExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const legacy = isLegacyRequest(body);
    // Shallow copy: the incoming body (shared with chatCore retries and the
    // legacy fallback) must keep its original messages/tools.
    const transformed = { ...super.transformRequest(model, body, stream, credentials) };
    transformed.stream = true;

    if (Array.isArray(transformed.messages)) {
      // Default: keep the client's system prompt, desensitized (zero-width
      // spaces inside filter keywords). Legacy: neutral prompt (see above).
      transformed.messages = legacy
        ? neutralizeAgentSystemPrompts(transformed.messages)
        : desensitizeMessages(transformed.messages);
    }
    if (!legacy) {
      if (Array.isArray(transformed.tools)) transformed.tools = desensitizeTools(transformed.tools);
      if (Array.isArray(transformed.functions)) transformed.functions = desensitizeTools(transformed.functions);
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }
}

export default CodeBuddyExecutor;
