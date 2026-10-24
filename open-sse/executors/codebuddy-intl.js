import { createHash, randomUUID } from "crypto";
import { CodeBuddyBaseExecutor, isLegacyRequest } from "./codebuddy-base.js";
import { contentToText, desensitizeText, desensitizeTools } from "../utils/codebuddyDesensitize.js";
import { extractClientSessionId } from "../utils/sessionManager.js";

// The gateway wants a leading system prompt; this exact line is the verified-good one.
const LEAD_PROMPT = "You are CodeBuddy Code.";

/**
 * Build the INTL message list.
 *
 * CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
 * leading system prompt + user content as typed blocks, not a bare string.
 *
 * Default: the client's system/developer messages (desensitized) are folded
 * into the single leading system message, after LEAD_PROMPT — one string-content
 * system message is the shape the gateway is known to accept, whereas extra
 * consecutive system messages are not guaranteed to survive the per-model
 * conversion behind it. Legacy (fallback / CODEBUDDY_SYSTEM_PROMPT_MODE=legacy):
 * system/developer content is dropped and only LEAD_PROMPT is sent.
 *
 * `leadPrompt` / `prefixLead` let a sibling gateway swap the lead line, or send
 * the client's system text alone (the lead then only stands in when there is none).
 */
export function buildIntlMessages(source, { legacy = false, leadPrompt = LEAD_PROMPT, prefixLead = true } = {}) {
  const systemParts = [];
  const rest = [];
  for (const message of Array.isArray(source) ? source : []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      if (legacy) continue;
      const text = contentToText(message.content);
      if (text) systemParts.push(desensitizeText(text));
    } else if (message.role === "user" && typeof message.content === "string") {
      rest.push({ ...message, content: [{ type: "text", text: message.content }] });
    } else {
      rest.push({ ...message });
    }
  }
  const client = systemParts.join("\n\n");
  const lead = !systemParts.length ? leadPrompt : prefixLead ? `${leadPrompt}\n\n${client}` : client;
  return [{ role: "system", content: lead }, ...rest];
}

// Text of the first user message (string or typed blocks); JSON for non-text content.
function firstUserText(messages) {
  const first = Array.isArray(messages) ? messages.find((m) => m?.role === "user") : null;
  if (!first) return "";
  const text = contentToText(first.content);
  if (text) return text;
  return first.content == null ? "" : JSON.stringify(first.content);
}

// 32 hex chars -> 8-4-4-4-12 with v4 version/variant bits, like the random UUIDs it replaces.
function hexToUuid(hex) {
  const variant = "89ab"[parseInt(hex[16], 16) & 3];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stable X-Conversation-ID. The upstream buckets its prompt-prefix cache by
 * this value, so every turn of one conversation must send the same one.
 * Seed: the client's own session id when the request carries one, else the
 * first USER message (the system prompt is identical across conversations of
 * the same client, so it cannot tell them apart). Always scoped by connection:
 * the cache lives per account. No seed at all -> random, as before.
 */
export function deriveConversationId(credentials, body) {
  const clientSession = extractClientSessionId(credentials?.rawHeaders, body, "codebuddy-intl");
  const userText = clientSession ? "" : firstUserText(body?.messages);
  if (!clientSession && !userText) return randomUUID();
  const seed = clientSession ? `session:${clientSession}` : `first-user:${userText}`;
  return hexToUuid(createHash("sha256").update(`${credentials?.connectionId || ""}\n${seed}`).digest("hex").slice(0, 32));
}

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends CodeBuddyBaseExecutor {
  // `provider` lets sibling gateways on the same platform (workbuddy) reuse the transform.
  constructor(provider = "codebuddy-intl") {
    super(provider);
  }

  // The gateway rejects chat calls without conversation IDs (HTTP 400 code
  // 11128 "request illegal ... failed channel verification"). The official
  // client keeps the conversation ID stable across a conversation and mints
  // fresh request/message IDs on every request; do the same here.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    headers["X-Conversation-ID"] = deriveConversationId(credentials, body);
    headers["X-Conversation-Request-ID"] = randomUUID().replace(/-/g, "");
    headers["X-Conversation-Message-ID"] = randomUUID().replace(/-/g, "");
    return headers;
  }

  // Options for buildIntlMessages; a sibling gateway overrides this to change the lead prompt.
  messageOptions(legacy) {
    return { legacy };
  }

  transformRequest(model, body, stream, credentials) {
    const legacy = isLegacyRequest(body);
    // Shallow copy: the incoming body (shared with chatCore retries and the
    // legacy fallback) must keep its original messages/tools.
    const transformed = { ...super.transformRequest(model, body, stream, credentials) };
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    transformed.messages = buildIntlMessages(transformed.messages, this.messageOptions(legacy));
    if (!legacy) {
      if (Array.isArray(transformed.tools)) transformed.tools = desensitizeTools(transformed.tools);
      if (Array.isArray(transformed.functions)) transformed.functions = desensitizeTools(transformed.functions);
    }

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
