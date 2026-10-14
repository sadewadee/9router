import { describe, expect, it } from "vitest";

import { getExecutor } from "../../open-sse/executors/index.js";

// Live bisection 2026-09-18 against opencode.ai/zen free tier proved the
// upstream client fingerprint requires the lowercase tool quartet
// {bash, glob, grep, read} in the tools payload on every request that carries
// any tools at all. Requests whose tools lack even one of the four names get
// 403 FreeTierError ("OpenCode's free tier can only be used from within
// OpenCode"), even when bash/read are present. Extras are allowed upstream.
//
// The cloak must therefore run on EVERY responses-path request (not only when
// the caller sent no tools) and must ensure all four names, because real
// clients (e.g. Claude Code) send capitalized tool names (Bash/Glob/Grep/Read)
// that never satisfy the lowercase gate.

function toolName(t) {
  return t.function?.name || t.name;
}

function namesOf(body) {
  return new Set((body.tools || []).map(toolName));
}

const QUARTET = ["bash", "glob", "grep", "read"];

function fakeResponsesBody(tools) {
  return {
    model: "muse-spark-1.3-contributor-free",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    max_tokens: 500,
    ...(tools ? { tools } : {}),
  };
}

function chatTool(name) {
  return {
    type: "function",
    function: { name, description: "caller tool", parameters: { type: "object", properties: {} } },
  };
}

function responsesTool(name) {
  return {
    type: "function",
    name,
    description: "caller tool",
    parameters: { type: "object", properties: {} },
  };
}

describe("OpenCode free-tier quartet cloak", () => {
  it("appends missing quartet names when the responses request already carries caller tools", () => {
    const executor = getExecutor("opencode");
    const body = fakeResponsesBody([responsesTool("fake_tool_one"), responsesTool("fake_tool_two")]);
    executor.transformRequest("muse-spark-1.3-contributor-free", body, false, {});
    const names = namesOf(body);
    for (const n of QUARTET) expect(names.has(n), `missing ${n}`).toBe(true);
    expect(names.has("fake_tool_one")).toBe(true);
    expect(names.has("fake_tool_two")).toBe(true);
  });

  it("injects the quartet when the responses request has no tools", () => {
    const executor = getExecutor("opencode");
    const body = fakeResponsesBody(null);
    executor.transformRequest("muse-spark-1.3-contributor-free", body, false, {});
    const names = namesOf(body);
    for (const n of QUARTET) expect(names.has(n), `missing ${n}`).toBe(true);
    expect(body.tool_choice).toBe("auto");
  });

  it("does not satisfy the lowercase gate with capitalized client tools alone (Claude Code shape)", () => {
    const executor = getExecutor("opencode");
    const body = fakeResponsesBody(["Bash", "Read", "Glob", "Grep"].map(responsesTool));
    executor.transformRequest("muse-spark-1.3-contributor-free", body, false, {});
    const names = namesOf(body);
    for (const n of QUARTET) expect(names.has(n), `missing ${n}`).toBe(true);
    // caller's capitalized tools preserved verbatim (extras are allowed upstream)
    for (const n of ["Bash", "Read", "Glob", "Grep"]) expect(names.has(n)).toBe(true);
  });

  it("appends missing quartet names on the chat-completions path with caller tools", () => {
    const executor = getExecutor("opencode");
    const body = {
      model: "mimo-v2.5-free",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 500,
      tools: [chatTool("fake_tool_one")],
    };
    executor.transformRequest("mimo-v2.5-free", body, false, {});
    const names = namesOf(body);
    for (const n of QUARTET) expect(names.has(n), `missing ${n}`).toBe(true);
    expect(names.has("fake_tool_one")).toBe(true);
  });

  it("keeps forcing stream:true upstream on the responses path", () => {
    const executor = getExecutor("opencode");
    const body = fakeResponsesBody(null);
    executor.transformRequest("muse-spark-1.3-contributor-free", body, false, {});
    expect(body.stream).toBe(true);
  });
});
