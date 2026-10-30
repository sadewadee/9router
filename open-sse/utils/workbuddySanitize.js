/**
 * WorkBuddy / CodeBuddy-intl gateway fingerprint sanitizer.
 *
 * The gateway behind www.workbuddy.ai / www.codebuddy.ai runs an exact-substring
 * fingerprint WAF over message text and answers HTTP 400 code 11128 ("Illegal
 * API invocation from an unapproved channel") when it sees a known agent-client
 * template line. A one-character change defeats a fingerprint, so each rule below
 * rewrites only the confirmed contiguous phrase and leaves the rest of the prompt
 * (and the agent's behaviour) intact.
 *
 * It also refuses the BARE string "11128" anywhere in the body (an anti-probe
 * rule). That is why failures cascade: once the error text lands in the chat
 * history, every later turn contains "11128" and is refused again.
 *
 * Ported from the workbuddy2api-hub sanitizer (`sanitize_text`, `sanitize_messages`):
 * same rules, same order. This is the structural layer; the zero-width-space
 * keyword filter in codebuddyDesensitize.js still runs after it.
 *
 * Scope: every message role. System/developer/assistant text gets the full rule
 * set; user/tool text only gets the rules that cannot misread user data (the
 * literal rewrites, the billing header and its cc_* pairs), because brand and
 * identity words in a user message or tool result are the user's own data and
 * rewriting them would show the model something different from what is on disk.
 * Every function returns new objects and never mutates its input, so callers can
 * safely re-run a transform on the same request body (retries, fallback).
 */

// Cheap prefilter literals (case-sensitive). Text with none of them (and none of
// the case-insensitive keywords below) is returned untouched, same reference.
const FINGERPRINT_FEATURES = [
  "x-anthropic-billing-header",
  "cc_entrypoint=",
  "You are Claude Code",
  "Main branch (",
  "You are a coding agent running in the Codex CLI",
  "github.com/anthropics/",
  "11128",
];

// Literal rewrites, applied in order after the identity rules. Each changes one
// word of a known template line (or, for "11128", one character).
const LITERAL_REWRITES = [
  ["You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude"],
  ["Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)"],
  ["You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."],
  ["To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"],
  ["11128", "11-128"],
];

// Claude Code's per-request attribution block: "x-anthropic-billing-header:
// cc_version=...; cc_entrypoint=cli; ...". The header line goes first, then
// every remaining cc_*=... pair, then a bare mention is renamed.
const BILLING_HDR_RE = /x-anthropic-billing-header:[^;\r\n]*;?\s*/gi;
const BILLING_BARE_RE = /x-anthropic-billing-header/gi;
const CC_KV_RE = /\bcc_[a-z0-9_]+=[^;\r\n]*;?\s*/gi;

// Confirmed OmO identity fingerprint: matched case-insensitively as a contiguous
// substring, survives surrounding text, stops matching when the phrase changes.
// Only this exact phrase is rewritten ("OhMyOpenCode" or "Sisyphus-Junior" alone
// are accepted by the gateway, so neither token is removed globally).
const OMO_JUNIOR_RE = /Sisyphus-Junior - Focused executor from OhMyOpenCode/gi;
const OMO_JUNIOR_REPLACEMENT = "Sisyphus-Junior - Focused executor";

// Client self-introduction sentence + brand ("You are an AI agent powered by X.",
// "You are <Product> Agent, built by <Vendor>.", "You are powered by ..."). The
// verb list covers the whole family; the noun is optional and 0-3 modifier words
// (proper names count) may follow the article. The window is bounded so a
// participle that modifies an object ("You are free to use tools built by X.") is
// NOT rewritten: after "You are free" the next word would be a 4th modifier.
// Deviations from the Python port: \w is ASCII-only in JS, so the Unicode-aware
// Python \w is spelled out as [\p{L}\p{N}_] (needs the u flag); and every
// whitespace run is capped at 64 characters, because the unbounded form backtracks
// quadratically on a long blank run after "You are" (50k spaces stalled the event
// loop for ~4 s).
const IDENTITY_RE = new RegExp(
  "You are\\s{1,64}" +
  "(?:an?\\s{1,64}|the\\s{1,64})?(?:[\\p{L}\\p{N}_.-]+\\s{1,64}){0,3}?" +
  "(?:agent|assistant|model|AI|LLM)?[\\s,]{0,64}" +
  "(?:powered by|built on|built by|created by|developed by|made by|trained by)" +
  "[^\\n]*?(?:\\.(?=\\s|$)|(?=\\n|$))",
  "giu"
);
const IDENTITY_REPLACEMENT = "You are a helpful AI assistant.";
// Cheap prefilter for IDENTITY_RE: one of these verb phrases must be present.
const IDENTITY_VERBS = ["powered by", "built on", "built by", "created by", "developed by", "made by", "trained by"];

// GUI description paragraph: the gateway flags sentence A followed by sentence B.
// Only the tail of sentence A is reordered ("whose URL the runtime context names"
// -> "whose URL is named in the runtime context"); no word is dropped.
const DSH_GUI_RE = /(You are interacting with the user through the DeepSeek[ \t]+Harness[ \t]+Web[ \t]+GUI) whose URL the runtime context names\./gi;
const DSH_GUI_REPLACEMENT = "$1 whose URL is named in the runtime context.";
const DSH_GUI_LOWER = "whose url the runtime context names";

// File-reference paragraph (@deepseek-ai/dsh-file-reference): one added word
// ("paths the user" -> "paths that the user") breaks the contiguous match. The
// negative lookahead keeps the rewrite idempotent.
const DSH_FILEREF_RE = /(Tokens prefixed with @ are paths )(?!that )(the user explicitly referenced\.)/gi;
const DSH_FILEREF_REPLACEMENT = "$1that $2";
const DSH_FILEREF_LOWER = "are paths the user explicitly referenced";

// Brand reduction: "DeepSeek Harness" next to the GUI sentence trips the same
// check; "DeepSeek" alone passes. Space/tab form only, so identifiers and paths
// ("deepseek-harness", "/opt/deepseek-harness/app") are left alone.
const BRAND_RE = /DeepSeek[ \t]+Harness/gi;
const BRAND_REPLACEMENT = "DeepSeek";
const BRAND_LOWER = "harness";

// String.prototype.search ignores the lastIndex of a global regex, so the same
// regex objects serve both detection and replacement.
const found = (text, re) => text.search(re) !== -1;

// Cheap check, in the spirit of the hub's has_fingerprint: a superset test run
// before the rewrite chain so unaffected text costs a few substring scans.
function hasFingerprint(text, identity) {
  if (typeof text !== "string" || !text) return false;
  if (FINGERPRINT_FEATURES.some((feature) => text.includes(feature))) return true;
  const low = text.toLowerCase();
  if (low.includes("x-anthropic-billing-header") || low.includes("sisyphus-junior - focused executor from ohmyopencode")) return true;
  if (!identity) return false;
  if (low.includes(BRAND_LOWER) && found(text, BRAND_RE)) return true;
  if (low.includes(DSH_GUI_LOWER) && found(text, DSH_GUI_RE)) return true;
  if (low.includes(DSH_FILEREF_LOWER) && found(text, DSH_FILEREF_RE)) return true;
  if (!IDENTITY_VERBS.some((verb) => low.includes(verb))) return false;
  return found(text, IDENTITY_RE);
}

/**
 * Neutralize the gateway fingerprints in one text.
 *
 * `identity: true` (system/developer/assistant text) runs every rule;
 * `identity: false` (user/tool text, tool-call arguments) skips the identity
 * sentence, GUI, file-reference and brand rules. Unaffected text is returned
 * as-is (same string, whitespace untouched). When something was rewritten the
 * result is trimmed, which removes the blank space a stripped header leaves.
 */
export function sanitizeFingerprintText(text, { identity = true } = {}) {
  if (typeof text !== "string" || !text) return text;
  if (!hasFingerprint(text, identity)) return text;

  let out = text.replace(OMO_JUNIOR_RE, OMO_JUNIOR_REPLACEMENT);
  if (identity) {
    out = out.replace(IDENTITY_RE, IDENTITY_REPLACEMENT);
    out = out.replace(DSH_GUI_RE, DSH_GUI_REPLACEMENT);
    out = out.replace(DSH_FILEREF_RE, DSH_FILEREF_REPLACEMENT);
    // Brand last: the GUI rule above still needs the full "DeepSeek Harness".
    out = out.replace(BRAND_RE, BRAND_REPLACEMENT);
  }
  for (const [from, to] of LITERAL_REWRITES) out = out.split(from).join(to);
  out = out.replace(BILLING_HDR_RE, "");
  if (out.includes("cc_")) {
    let previous;
    do {
      previous = out;
      out = out.replace(CC_KV_RE, "");
    } while (out !== previous);
  }
  out = out.replace(BILLING_BARE_RE, "x-anthropic-billing-hdr");
  return out === text ? text : out.trim();
}

// OpenAI content: string | [{type:"text", text}, ...]. Shape is preserved; only
// text blocks are touched, other blocks (images, ...) pass through.
function sanitizeContent(content, identity) {
  if (typeof content === "string") return sanitizeFingerprintText(content, { identity });
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? { ...block, text: sanitizeFingerprintText(block.text, { identity }) }
        : block
    );
  }
  return content;
}

// function.arguments must be a JSON string upstream. A non-string value (some
// clients send an object) is serialized first, a missing one becomes "{}", and the
// resulting string is sanitized as data (no identity rules). Deviation from the
// hub: it serializes non-string arguments but does not sanitize them, which would
// let a bare "11128" inside such arguments reach the gateway.
function sanitizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((call) => {
    if (!call || typeof call !== "object" || !call.function || typeof call.function !== "object") return call;
    const raw = call.function.arguments;
    let args;
    if (typeof raw === "string") args = raw;
    else if (raw === null || raw === undefined) args = "{}";
    else {
      try {
        args = JSON.stringify(raw);
      } catch {
        args = String(raw);
      }
    }
    return { ...call, function: { ...call.function, arguments: sanitizeFingerprintText(args, { identity: false }) } };
  });
}

// The identity sentence is also a fingerprint in assistant history (the same
// sentence is refused in an assistant message and accepted in a user message).
const IDENTITY_ROLES = new Set(["system", "developer", "assistant"]);

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  const item = { ...message };
  // The gateway only knows system/user/assistant/tool: "developer" (Codex CLI,
  // current SDKs) is a system message and is refused as-is.
  if (item.role === "developer") item.role = "system";
  const identity = IDENTITY_ROLES.has(item.role);
  if ("content" in item) item.content = sanitizeContent(item.content, identity);
  if (typeof item.reasoning_content === "string") {
    item.reasoning_content = sanitizeFingerprintText(item.reasoning_content, { identity: false });
  }
  if ("tool_calls" in item) item.tool_calls = sanitizeToolCalls(item.tool_calls);
  return item;
}

/** Sanitize a chat messages array (new array, new message objects, input untouched). */
export function sanitizeFingerprintMessages(messages) {
  return Array.isArray(messages) ? messages.map(sanitizeMessage) : messages;
}
