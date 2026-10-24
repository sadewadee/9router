import { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
import {
  resolveWorkBuddyUid,
  uuidv7Hex,
  workBuddyChatUserAgent,
  workBuddyClientVersion,
  workBuddyEnterpriseHeaders,
  workBuddyTraceHeaders,
} from "../utils/workbuddyIdentity.js";

// The desktop's chat calls send the browser-style Accept, not an event-stream one.
const CHAT_ACCEPT = "application/json, text/plain, */*";

// Stands in when the client sent no system prompt.
const DEFAULT_LEAD_PROMPT = "You are a helpful assistant.";
// Content-filter fallback re-send: a minimal neutral prompt replaces the client's.
const NEUTRAL_LEAD_PROMPT = "You are a helpful assistant. Respond in the user's language, follow the user's instructions, and be direct and concise.";

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * WorkBuddy runs on the same CodeBuddy gateway as codebuddy-intl, so the body
 * transform is shared: forced stream, reasoning mirror, desensitized system
 * prompt with the content-filter legacy fallback, stable X-Conversation-ID.
 * What differs is the identity: chat goes out as the WorkBuddy desktop client
 * (registry headers + the per-request part added here). Not on chat: X-Machine-ID /
 * X-Session-ID (billing only), X-Device-Token, X-Refresh-Token.
 *
 * System prompt: the client's own text goes through alone (the CodeBuddy "You are
 * CodeBuddy Code." identity line is not WorkBuddy's); without one, a neutral line
 * stands in, as the other gateways of this family do.
 */
export class WorkBuddyExecutor extends CodeBuddyIntlExecutor {
  constructor() {
    super("workbuddy");
  }

  messageOptions(legacy) {
    return { legacy, leadPrompt: legacy ? NEUTRAL_LEAD_PROMPT : DEFAULT_LEAD_PROMPT, prefixLead: false };
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    // The intl base already set X-Conversation-ID (stable per conversation).
    const headers = super.buildHeaders(credentials, stream, url, model, body);

    // Version and UA are env-overridable, so they are read per request.
    headers["User-Agent"] = workBuddyChatUserAgent();
    headers["X-IDE-Version"] = workBuddyClientVersion();
    headers["Accept"] = CHAT_ACCEPT;
    headers["X-User-Id"] = resolveWorkBuddyUid(credentials) || "anonymous";
    Object.assign(headers, workBuddyEnterpriseHeaders(credentials?.providerSpecificData));

    // Per request: the conversation request id doubles as the root request id,
    // the message id as the request id (both UUIDv7 hex, like the desktop's).
    const requestId = uuidv7Hex();
    const messageId = uuidv7Hex();
    headers["X-Conversation-Request-ID"] = requestId;
    headers["X-Root-Request-ID"] = requestId;
    headers["X-Conversation-Message-ID"] = messageId;
    headers["X-Request-ID"] = messageId;
    Object.assign(headers, workBuddyTraceHeaders());
    return headers;
  }
}

export default WorkBuddyExecutor;
