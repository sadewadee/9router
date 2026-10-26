/**
 * The OpenCode free tier answers 429 FreeUsageLimitError unless the system
 * prompt carries the CLI's `<env>` block AND the body declares tools (the tool
 * half lives in executors/opencode.js). A request missing either half is refused
 * regardless of headers, UA or session shape; both together pass (live probes
 * 2026-10-26). The TLS ClientHello is a third gate, see services/opencodeTlsClient.js.
 *
 * The gate reads text only: a foreign system prompt plus this exact block passes,
 * so the marker is appended to the caller's own prompt rather than replacing it.
 * Values mirror a real CLI instance on this host.
 */
import os from "node:os";
import path from "node:path";

const ENV_TAG = "<env>";
const ENV_HEADING = "Here is some useful information about the environment you are running in:";
const ENV_TMP_DIR = path.join(os.tmpdir(), "opencode");
const ENV_WORKING_DIR = process.cwd();
export const OPENCODE_ENV_PROMPT = [
  ENV_HEADING,
  ENV_TAG,
  `  Working directory: ${ENV_WORKING_DIR}`,
  `  Workspace root folder: ${ENV_WORKING_DIR}`,
  "  Is directory a git repo: no",
  `  Platform: ${process.platform}`,
  `  Prefer ${ENV_TMP_DIR} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
  "</env>",
].join("\n");

/** True when the marker is already present; a genuine opencode client is passthrough. */
function systemCarriesEnv(system) {
  if (typeof system === "string") return system.includes(ENV_TAG);
  if (Array.isArray(system)) {
    return system.some((block) => typeof block?.text === "string" && block.text.includes(ENV_TAG));
  }
  return false;
}

/** Append `text` to a system prompt held as a string, text blocks, or unset. */
function appendSystemText(system, text) {
  if (typeof system === "string") {
    return system.trim() ? `${system}\n\n${text}` : text;
  }
  const blocks = Array.isArray(system) ? [...system] : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (typeof block?.text === "string") {
      const existing = block.text.trim();
      blocks[i] = { ...block, text: existing ? `${block.text}\n\n${text}` : text };
      return blocks;
    }
  }
  return [...blocks, { type: "text", text }];
}

/**
 * Append the CLI's environment marker without replacing the caller's content,
 * covering all three request shapes: Responses (`instructions`), chat
 * (`messages[]` system) and claude-top-level (`system`). Fail-open: the marker
 * is an enhancement, so a surprising body is left untouched.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses instructions, false for chat/claude
 * @param {object} [options]
 * @param {boolean} [options.claude] - body posts to /messages (claude shape)
 * @returns {boolean} true when the marker was added
 */
export function applyEnvFingerprint(body, flat, { claude = false } = {}) {
  try {
    if (!body || typeof body !== "object") return false;

    if (flat) {
      if (body.instructions !== undefined && typeof body.instructions !== "string") return false;
      if (systemCarriesEnv(body.instructions)) return false;
      body.instructions = (typeof body.instructions === "string" && body.instructions.trim())
        ? `${body.instructions}\n\n${OPENCODE_ENV_PROMPT}`
        : OPENCODE_ENV_PROMPT;
      return true;
    }

    // Claude-shaped bodies carry `system` at the top level; /messages rejects role:"system".
    if (claude || body.system !== undefined) {
      if (systemCarriesEnv(body.system)) return false;
      body.system = appendSystemText(body.system, OPENCODE_ENV_PROMPT);
      return true;
    }

    if (!Array.isArray(body.messages)) return false;
    const idx = body.messages.findIndex((msg) => msg?.role === "system");
    if (idx >= 0) {
      const target = body.messages[idx];
      if (systemCarriesEnv(target.content)) return false;
      const content = appendSystemText(target.content, OPENCODE_ENV_PROMPT);
      body.messages = body.messages.map((msg, i) => (i === idx ? { ...msg, content } : msg));
      return true;
    }
    body.messages = [{ role: "system", content: OPENCODE_ENV_PROMPT }, ...body.messages];
    return true;
  } catch {
    return false;
  }
}
