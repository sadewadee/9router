import { describe, it, expect } from "vitest";
import { applyEnvFingerprint, OPENCODE_ENV_PROMPT } from "../../open-sse/utils/opencodeEnvFingerprint.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const count = (text, needle) => text.split(needle).length - 1;

// The upstream free tier answers 429 FreeUsageLimitError unless the system prompt
// carries the CLI's `<env>` block AND the body declares tools. Both halves are
// required; either one alone is refused (decolua/9router ce060c79, live 2026-10-26).
describe("applyEnvFingerprint", () => {
  it("appends the marker to a chat system message without replacing it", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages[0].content).toContain("You are helpful.");
    expect(body.messages[0].content).toContain("<env>");
    expect(body.messages[0].content).toContain("Working directory:");
    expect(body.messages).toHaveLength(2);
  });

  it("creates the system message when the chat body has none", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: OPENCODE_ENV_PROMPT });
    expect(body.messages).toHaveLength(2);
  });

  it("appends to a chat system message held as text parts", () => {
    const body = { messages: [{ role: "system", content: [{ type: "text", text: "Be terse." }] }] };
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages[0].content[0].text).toContain("Be terse.");
    expect(body.messages[0].content[0].text).toContain("<env>");
  });

  it("appends to Responses instructions, or sets them when absent", () => {
    const withText = { instructions: "Be terse." };
    expect(applyEnvFingerprint(withText, true)).toBe(true);
    expect(withText.instructions).toContain("Be terse.");
    expect(withText.instructions).toContain("<env>");

    const bare = { input: [] };
    expect(applyEnvFingerprint(bare, true)).toBe(true);
    expect(bare.instructions).toBe(OPENCODE_ENV_PROMPT);
  });

  it("leaves Responses instructions alone when they are not a string", () => {
    const body = { instructions: [{ type: "text", text: "x" }] };
    expect(applyEnvFingerprint(body, true)).toBe(false);
    expect(body.instructions).toEqual([{ type: "text", text: "x" }]);
  });

  it("appends to a claude top-level system field instead of adding role:system", () => {
    const body = { system: "Be terse.", messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system).toContain("Be terse.");
    expect(body.system).toContain("<env>");
    expect(body.messages).toHaveLength(1);
  });

  it("creates the claude system field when the body has none", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system).toEqual([{ type: "text", text: OPENCODE_ENV_PROMPT }]);
    expect(body.messages).toHaveLength(1);
  });

  it("handles claude system held as text blocks, appending to the last one", () => {
    const body = { system: [{ type: "text", text: "A" }, { type: "text", text: "B", cache_control: { type: "ephemeral" } }], messages: [] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system[0].text).toBe("A");
    expect(body.system[1].text).toContain("B");
    expect(body.system[1].text).toContain("<env>");
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("is idempotent for every shape (the retry loop re-runs transformRequest)", () => {
    const chat = { messages: [{ role: "system", content: "x\n\n<env>\n</env>" }, { role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(chat, false)).toBe(false);
    expect(chat.messages[0].content).toBe("x\n\n<env>\n</env>");

    const responses = { instructions: "x" };
    expect(applyEnvFingerprint(responses, true)).toBe(true);
    expect(applyEnvFingerprint(responses, true)).toBe(false);
    expect(count(responses.instructions, "<env>")).toBe(1);

    const claude = { system: [{ type: "text", text: "x" }] };
    expect(applyEnvFingerprint(claude, false, { claude: true })).toBe(true);
    expect(applyEnvFingerprint(claude, false, { claude: true })).toBe(false);
    expect(count(claude.system[0].text, "<env>")).toBe(1);
  });

  it("fails open on a body it does not understand", () => {
    expect(applyEnvFingerprint(null, false)).toBe(false);
    expect(applyEnvFingerprint({}, false)).toBe(false);
    expect(applyEnvFingerprint({ messages: "nope" }, false)).toBe(false);
  });
});

describe("OpenCodeExecutor.transformRequest carries the env marker in all three shapes", () => {
  const executor = new OpenCodeExecutor();
  const credentials = {};

  it("chat (big-pickle): marker in the system message, tool quartet still declared", () => {
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] };
    const sent = executor.transformRequest("big-pickle", body, true, credentials);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[0].content).toContain("<env>");
    const toolNames = sent.tools.map((t) => t.function.name);
    for (const name of ["bash", "glob", "grep", "read"]) expect(toolNames).toContain(name);
  });

  it("Responses (muse-spark): marker in instructions, tool quartet still declared", () => {
    const body = { model: "muse-spark-1.3-contributor-free", instructions: "Be terse.", input: "hi" };
    const sent = executor.transformRequest("muse-spark-1.3-contributor-free", body, true, credentials);
    expect(sent.instructions).toContain("Be terse.");
    expect(sent.instructions).toContain("<env>");
    expect(sent.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["bash", "glob", "grep", "read"]));
  });

  it("claude /messages (union-alpha): marker in top-level system, never as role:system", () => {
    const body = { model: "union-alpha", system: "Be terse.", messages: [{ role: "user", content: "hi" }] };
    const sent = executor.transformRequest("union-alpha", body, true, credentials);
    expect(sent.system).toContain("Be terse.");
    expect(sent.system).toContain("<env>");
    expect(sent.messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("claude /messages without a system prompt gets one", () => {
    const body = { model: "union-alpha", messages: [{ role: "user", content: "hi" }] };
    const sent = executor.transformRequest("union-alpha", body, true, credentials);
    expect(JSON.stringify(sent.system)).toContain("<env>");
    expect(sent.messages).toHaveLength(1);
  });

  it("stays a single marker when transformRequest runs again on the same body", () => {
    const body = { model: "big-pickle", messages: [{ role: "system", content: "x" }, { role: "user", content: "hi" }] };
    executor.transformRequest("big-pickle", body, true, credentials);
    executor.transformRequest("big-pickle", body, true, credentials);
    expect(count(body.messages[0].content, "<env>")).toBe(1);
  });
});
