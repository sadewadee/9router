import { CodeBuddyIntlExecutor } from "./codebuddy-intl.js";
import { resolveWorkBuddyUid, workBuddyDeviceHeaders } from "../utils/workbuddyIdentity.js";

const CHAT_ACCEPT = "application/json, text/event-stream";

/**
 * WorkBuddyExecutor — talks to https://www.workbuddy.ai/v2/chat/completions
 *
 * WorkBuddy runs on the same CodeBuddy gateway as codebuddy-intl, so the body
 * transform is shared: forced stream, reasoning mirror, desensitized system
 * prompt with the content-filter legacy fallback, stable X-Conversation-ID.
 * What differs is the client fingerprint. The static part (User-Agent,
 * Origin/Referer, X-Domain, X-IDE-*, ...) comes from the registry; this class
 * adds the per-account identity (X-User-Id, X-Machine-ID, X-Session-ID) and the
 * trace header family the desktop client sends. X-Refresh-Token never goes on
 * a chat call.
 */
export class WorkBuddyExecutor extends CodeBuddyIntlExecutor {
  constructor() {
    super("workbuddy");
  }

  buildHeaders(credentials, stream = true, url, model, body = null) {
    // The intl base already set X-Conversation-ID (stable per conversation) and
    // fresh X-Conversation-Request-ID / X-Conversation-Message-ID per request.
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    headers["Accept"] = CHAT_ACCEPT;

    const uid = resolveWorkBuddyUid(credentials);
    if (uid) headers["X-User-Id"] = uid;
    else headers["X-No-User-Id"] = "1";
    Object.assign(headers, workBuddyDeviceHeaders(uid || credentials?.connectionId));

    // Request-level ids mirror the message id, root/trace ids the request id,
    // like the official client's header family (B3 trace ids are 32 hex).
    const requestId = headers["X-Conversation-Request-ID"];
    const messageId = headers["X-Conversation-Message-ID"];
    headers["X-Request-ID"] = messageId;
    headers["X-Root-Request-ID"] = requestId;
    headers["X-Trace-ID"] = requestId;
    headers["X-B3-TraceId"] = requestId;
    headers["X-B3-SpanId"] = messageId.slice(0, 16);
    headers["X-B3-Sampled"] = "1";
    return headers;
  }
}

export default WorkBuddyExecutor;
