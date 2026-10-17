import { randomUUID } from "node:crypto";
import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn.
 * Injects the three conversation-tracking headers CodeBuddy now requires
 * (mirroring Buddy2api fingerprint.py pattern lines ~140-150):
 *   X-Conversation-ID       stable per connection (derived from connectionId)
 *   X-Conversation-Request-ID  new UUID per HTTP request
 *   X-Conversation-Message-ID  new UUID per HTTP request (separate slot)
 * All three are capped at 64 chars.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
    this._convId = null;
    this._reqId = null;
    this._msgId = null;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    // Generate conversation-tracking IDs once per request so buildHeaders can
    // read them. X-Conversation-ID is stable per connection; the other two are
    // random per request (fingerprint.py pattern ~line 140).
    const baseId = credentials?.connectionId || credentials?.providerConnectionId || randomUUID();
    this._convId = baseId.slice(0, 64);
    this._reqId = randomUUID().slice(0, 64);
    this._msgId = randomUUID().slice(0, 64);

    return transformed;
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);

    // Inject conversation-tracking headers expected by CodeBuddy intl gateway.
    headers["X-Conversation-ID"] = this._convId || randomUUID().slice(0, 64);
    headers["X-Conversation-Request-ID"] = this._reqId || randomUUID().slice(0, 64);
    headers["X-Conversation-Message-ID"] = this._msgId || randomUUID().slice(0, 64);

    return headers;
  }
}

export default CodeBuddyIntlExecutor;
