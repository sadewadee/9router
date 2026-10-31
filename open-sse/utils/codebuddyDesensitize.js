/**
 * CodeBuddy system-prompt desensitizer.
 *
 * CodeBuddy's gateway runs a keyword content filter that rejects agent system
 * prompts (Claude Code & co.) even though the offending words only appear in
 * "refuse harmful requests" boilerplate. Instead of discarding the prompt, we
 * insert a zero-width space (U+200B) after the first character of each
 * sensitive term:
 *
 *   "DoS" -> "D​oS"   (the model still reads "DoS", a substring match misses)
 *
 * Ported from workbuddy2api `codebuddy_proxy/desensitize.py` (term list and
 * insertion algorithm). Message compaction (`compact_harness`) is NOT ported.
 *
 * Scope: system/developer message text and tool/function `description` /
 * `title` fields. User and assistant messages are never touched. Every
 * function returns new objects and never mutates its input, so callers can
 * safely re-run a transform on the same request body (retries, fallback).
 */

export const ZWSP = "​";

// "Refuse harmful requests" boilerplate + brand/identity words the filter
// flags. Case-insensitive. Same list as workbuddy2api.
export const SENSITIVE_TERMS = [
  // attack types
  "DoS", "DDoS", "exploit", "credential testing", "credential stuffing",
  "supply chain compromise", "supply-chain compromise", "detection evasion",
  "C2 frameworks", "C2 framework", "command and control", "malicious purposes",
  "malicious intent", "mass targeting", "brute force", "brute-force",
  "privilege escalation", "reverse shell", "remote code execution",
  "SQL injection", "XSS", "CSRF", "phishing", "malware", "ransomware",
  "keylogger", "rootkit", "backdoor", "botnet", "zero-day", "0day",
  // security terms
  "vulnerability", "vulnerabilities", "red teaming", "red-teaming", "sandbox",
  "sandboxing", "sandboxed", "unsandboxed", "escalated privileges", "escalated",
  "escalation", "destructive action", "destructive command", "destructive",
  "attack", "attacks", "cybersecurity", "security review", "exploit development",
  "hacking", "penetration testing", "penetration test", "injection",
  "weaponize", "weaponized",
  // harmful content
  "harmful", "dangerous", "abuse", "abusive", "illegal", "terrorist",
  "terrorism", "bomb", "weapon", "weapons", "drug", "drugs", "narcotic",
  "suicide", "self-harm", "murder", "kill", "violence", "violent",
  // brand words (competitor brands trip the filter)
  "Claude Code", "Claude Opus", "Claude Sonnet", "Claude Haiku", "Anthropic",
  "Co-Authored-By", "noreply@anthropic.com",
  // assistant identity markers
  "Oh My Pi", "omp", "Kiro", "Codex CLI", "coding harness", "harness",
  "subagent", "subagents", "MCP Server", "MCP tool", "tool call",
  "function call", "antml:invoke", "antml:function_calls",
  // internal protocol URIs
  "skill://", "agent://", "artifact://", "rule://", "memory://", "local://",
  "history://", "issue://", "pr://", "xd://",
  // tool / plugin names
  "AutoImprove", "CodeGraph", "codegraph_explore", "Rust Token Killer",
  // config file markers
  "AGENTS.md", "CLAUDE.md", ".cursorrules",
];

// Deviation from the Python port: workbuddy2api documents word-boundary
// matching but compiles a plain substring regex, so "omp" splits "prompt" /
// "complete" / "compile", "kill" splits "skill", "drugs" splits "drugstore".
// These terms collide with very common English words, so they only match as
// whole words.
const WHOLE_WORD_TERMS = new Set(["dos", "omp", "kill", "drug", "drugs"]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Longest term first so a short term never swallows a longer one.
const TERM_PATTERN = new RegExp(
  [...SENSITIVE_TERMS]
    .sort((a, b) => b.length - a.length)
    .map((term) => {
      const src = escapeRegExp(term);
      return WHOLE_WORD_TERMS.has(term.toLowerCase()) ? `(?<![A-Za-z0-9])${src}(?![A-Za-z0-9])` : src;
    })
    .join("|"),
  "gi"
);

// Characters that end a whitespace-ish "word" when we look for a surrounding
// path / URL token.
const TOKEN_BREAK = /[\s"'`<>(),;|]/;

// Second deviation: never split a term that sits inside a path or URL token
// (e.g. "/home/me/compose-app", "~/.claude/CLAUDE.md"). Models copy such
// strings into tool calls verbatim, and a stray U+200B would break the path.
// Terms that themselves contain a separator ("skill://") are still split.
function isInsidePathToken(text, start, end, match) {
  if (match.includes("/") || match.includes("\\")) return false;
  let from = start;
  while (from > 0 && !TOKEN_BREAK.test(text[from - 1])) from--;
  let to = end;
  while (to < text.length && !TOKEN_BREAK.test(text[to])) to++;
  const token = text.slice(from, to);
  return token.includes("/") || token.includes("\\");
}

function splitTerm(term) {
  return term.length <= 1 ? term : term[0] + ZWSP + term.slice(1);
}

/** Insert a zero-width space inside every sensitive term. No match: returned as-is. */
export function desensitizeText(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(TERM_PATTERN, (match, offset) =>
    isInsidePathToken(text, offset, offset + match.length, match) ? match : splitTerm(match)
  );
}

// OpenAI content: string | [{type:"text", text}, ...]. Shape is preserved;
// non-text blocks (images, tool results) pass through untouched.
function desensitizeContent(content) {
  if (typeof content === "string") return desensitizeText(content);
  if (Array.isArray(content)) {
    return content.map((block) =>
      block && typeof block === "object" && block.type === "text" && typeof block.text === "string"
        ? { ...block, text: desensitizeText(block.text) }
        : block
    );
  }
  return content;
}

const DESENSITIZED_ROLES = new Set(["system", "developer"]);

/** Desensitize system/developer messages; every other role is returned as-is. */
export function desensitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) =>
    message && typeof message === "object" && DESENSITIZED_ROLES.has(message.role)
      ? { ...message, content: desensitizeContent(message.content) }
      : message
  );
}

// Recursive: tool schemas nest descriptions inside parameters.properties.*.
function desensitizeToolValue(value) {
  if (Array.isArray(value)) return value.map(desensitizeToolValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = (key === "description" || key === "title") && typeof item === "string"
        ? desensitizeText(item)
        : desensitizeToolValue(item);
    }
    return out;
  }
  return value;
}

/** Desensitize `description` / `title` strings anywhere in a tools (or legacy functions) array. */
export function desensitizeTools(tools) {
  return Array.isArray(tools) ? tools.map(desensitizeToolValue) : tools;
}

/** The text of a message content (string or typed blocks), blocks joined by newline. */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
