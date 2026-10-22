import { DefaultExecutor } from "./default.js";

/**
 * Shared base of the two CodeBuddy executors (codebuddy-cn, codebuddy-intl).
 *
 * Both gateways run a keyword content filter on the request. We first send the
 * client's system prompt desensitized (zero-width spaces inside sensitive
 * terms, see utils/codebuddyDesensitize.js). If the upstream still rejects the
 * request as a content-filter violation, execute() re-sends it ONCE with the
 * legacy transform (CN: neutral prompt, INTL: bare "You are CodeBuddy Code.").
 *
 * Subclasses read `isLegacyRequest(body)` in transformRequest to pick the
 * transform; execute() below flips it for the fallback attempt.
 */

// Ops switch: force the legacy transform without a rebuild (no fallback needed).
export const SYSTEM_PROMPT_MODE_ENV = "CODEBUDDY_SYSTEM_PROMPT_MODE";

export function resolveSystemPromptMode(env = process.env) {
  return String(env[SYSTEM_PROMPT_MODE_ENV] || "").trim().toLowerCase() === "legacy" ? "legacy" : "desensitize";
}

// Marks the fallback attempt. A symbol key is invisible to JSON.stringify, so
// it can never leak into the upstream payload even if a transform copies it.
const LEGACY_ATTEMPT = Symbol("codebuddy.legacySystemPrompt");

export function markLegacyAttempt(body) {
  return { ...body, [LEGACY_ATTEMPT]: true };
}

/** True when the request must use the legacy system-prompt transform. */
export function isLegacyRequest(body, env = process.env) {
  return body?.[LEGACY_ATTEMPT] === true || resolveSystemPromptMode(env) === "legacy";
}

// Content-filter rejection signatures, each documented:
//  - content_policy_violation / 内容违规: workbuddy2api README ("Typical error
//    message": {"error":{"message":"内容违规","type":"content_policy_violation"}}).
//  - model return error: the generic message CodeBuddy answered when its content
//    filter tripped (#2071, see executors/codebuddy-cn.js history).
// Credit/auth errors (HTTP 401/402/429, code 14018 "Credits exhausted") are
// never content-filter rejections — see isContentFilterRejection.
const CONTENT_FILTER_SIGNATURES = [/content_policy_violation/i, /内容违规/, /model return error/i];
const NEVER_CONTENT_FILTER_STATUS = new Set([401, 402, 429]);
const NEVER_CONTENT_FILTER_CODES = new Set([14018]);
const ERROR_BODY_SAMPLE = 4096;

/** Pure body check: does this upstream error body carry a content-filter signature? */
export function matchesContentFilterBody(text) {
  if (typeof text !== "string" || !text) return false;
  const sample = text.slice(0, ERROR_BODY_SAMPLE);
  try {
    const code = Number(JSON.parse(sample)?.code);
    if (NEVER_CONTENT_FILTER_CODES.has(code)) return false;
  } catch { /* not JSON: fall through to the signature match */ }
  return CONTENT_FILTER_SIGNATURES.some((re) => re.test(sample));
}

/**
 * Is this upstream response a content-filter rejection? Only error responses
 * are inspected (cloned, so the caller can still read the original body).
 * A 200 SSE stream is never peeked: waiting for its first event would hold
 * back the client's keepalive heartbeat during slow prompt prefill.
 */
export async function isContentFilterRejection(response) {
  if (!response || response.ok || NEVER_CONTENT_FILTER_STATUS.has(response.status)) return false;
  try {
    return matchesContentFilterBody(await response.clone().text());
  } catch {
    return false;
  }
}

export class CodeBuddyBaseExecutor extends DefaultExecutor {
  async execute(args) {
    const result = await super.execute(args);
    if (isLegacyRequest(args?.body)) return result; // forced legacy, or already the fallback attempt

    if (!(await isContentFilterRejection(result?.response))) return result;

    const { model, stream, credentials, log } = args;
    const legacyBody = markLegacyAttempt(args.body);

    // Legacy transform would produce the very same request (no system prompt,
    // no tool descriptions to desensitize): a retry cannot change the outcome.
    const legacyPayload = JSON.stringify(this.transformRequest(model, legacyBody, stream, credentials));
    if (legacyPayload === JSON.stringify(result.transformedBody)) return result;

    log?.warn?.("CODEBUDDY", `${this.provider} content-filter rejection (HTTP ${result.response.status}), retrying once with the legacy system prompt`);
    let retry;
    try {
      retry = await super.execute({ ...args, body: legacyBody });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      log?.warn?.("CODEBUDDY", `${this.provider} legacy retry failed (${error?.message}), returning the original rejection`);
      return result;
    }
    try { await result.response.body?.cancel(); } catch { /* original body already released */ }
    return retry;
  }
}

export default CodeBuddyBaseExecutor;
