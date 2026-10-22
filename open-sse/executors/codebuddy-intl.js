import { randomUUID } from "crypto";
import { CodeBuddyBaseExecutor, isLegacyRequest } from "./codebuddy-base.js";
import { contentToText, desensitizeText, desensitizeTools } from "../utils/codebuddyDesensitize.js";

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
 */
export function buildIntlMessages(source, { legacy = false } = {}) {
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
  const lead = systemParts.length ? `${LEAD_PROMPT}\n\n${systemParts.join("\n\n")}` : LEAD_PROMPT;
  return [{ role: "system", content: lead }, ...rest];
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
  constructor() {
    super("codebuddy-intl");
  }

  // The gateway rejects chat calls without per-request conversation IDs
  // (HTTP 400 code 11128 "request illegal ... failed channel verification").
  // The official client mints fresh IDs on every request, so do the same here.
  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    headers["X-Conversation-ID"] = randomUUID();
    headers["X-Conversation-Request-ID"] = randomUUID().replace(/-/g, "");
    headers["X-Conversation-Message-ID"] = randomUUID().replace(/-/g, "");
    return headers;
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

    transformed.messages = buildIntlMessages(transformed.messages, { legacy });
    if (!legacy) {
      if (Array.isArray(transformed.tools)) transformed.tools = desensitizeTools(transformed.tools);
      if (Array.isArray(transformed.functions)) transformed.functions = desensitizeTools(transformed.functions);
    }

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
