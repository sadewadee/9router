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

// Live bisection 2026-10-14 on /inference/v1: the quartet names alone no longer pass.
// Each tool must carry OpenCode's own description sentence and its required
// parameter; placeholder descriptions, empty schemas, tool_choice "none" and a
// duplicate lowercase name all 403 with FreeTierError.
const GATE = {
  bash: { sig: "IMPORTANT: This tool is for terminal operations", required: "command" },
  glob: { sig: "Fast file pattern matching tool", required: "pattern" },
  grep: { sig: "Fast content search tool", required: "pattern" },
  read: { sig: "Read a file or directory from the local filesystem", required: "filePath" },
};

function defOf(tool) {
  return tool.function || tool;
}

function expectGateShape(tools) {
  for (const [name, { sig, required }] of Object.entries(GATE)) {
    const matches = tools.filter((t) => defOf(t).name === name);
    expect(matches.length, `${name} must appear exactly once`).toBe(1);
    const def = defOf(matches[0]);
    expect(def.description).toContain(sig);
    expect(def.parameters.required).toContain(required);
    expect(def.parameters.properties[required]).toBeTruthy();
  }
}

describe("OpenCode free-tier gate shape (/inference)", () => {
  it("injects decoys with OpenCode's own description and required params (chat)", () => {
    const executor = getExecutor("opencode");
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }] };
    executor.transformRequest("big-pickle", body, true, {});
    expectGateShape(body.tools);
  });

  it("injects decoys with OpenCode's own description and required params (responses)", () => {
    const executor = getExecutor("opencode");
    const body = fakeResponsesBody(null);
    executor.transformRequest("muse-spark-1.3-contributor-free", body, true, {});
    expectGateShape(body.tools);
  });

  it("upgrades tool_choice none to auto on both paths (the gate 403s none)", () => {
    const executor = getExecutor("opencode");
    const chat = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tool_choice: "none" };
    executor.transformRequest("big-pickle", chat, true, {});
    expect(chat.tool_choice).toBe("auto");
    const responses = { ...fakeResponsesBody(null), tool_choice: "none" };
    executor.transformRequest("muse-spark-1.2-contributor-free", responses, true, {});
    expect(responses.tool_choice).toBe("auto");
  });

  it("is idempotent when transformRequest re-runs on the same body (retry path)", () => {
    const executor = getExecutor("opencode");
    const credentials = {};
    const body = {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [chatTool("Bash"), chatTool("read")],
    };
    executor.transformRequest("big-pickle", body, true, credentials);
    const once = JSON.stringify(body.tools);
    executor.transformRequest("big-pickle", body, true, credentials);
    expect(JSON.stringify(body.tools)).toBe(once);
    expectGateShape(body.tools.filter((t) => defOf(t).name !== "Bash" && defOf(t).name !== "read_ext"));
  });

  it("keeps a genuine OpenCode quartet definition as-is instead of duplicating it", () => {
    const executor = getExecutor("opencode");
    const genuine = (name) => ({
      type: "function",
      function: {
        name,
        description: `${GATE[name].sig}. Real OpenCode tool text.`,
        parameters: {
          type: "object",
          properties: { [GATE[name].required]: { type: "string" } },
          required: [GATE[name].required],
        },
      },
    });
    const tools = Object.keys(GATE).map(genuine);
    const body = { model: "big-pickle", messages: [{ role: "user", content: "hi" }], tools };
    const credentials = {};
    executor.transformRequest("big-pickle", body, true, credentials);
    expect(body.tools.length).toBe(4);
    expect(body.tools[0].function.description).toContain("Real OpenCode tool text.");
    expect(credentials._opencodeToolNameMap.size).toBe(0);
  });

  it("moves a non-OpenCode lowercase caller tool aside and retargets tool_choice", () => {
    const executor = getExecutor("opencode");
    const credentials = {};
    const body = {
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [chatTool("read")],
      tool_choice: { type: "function", function: { name: "read" } },
    };
    executor.transformRequest("big-pickle", body, true, credentials);
    expect(body.tools.map((t) => defOf(t).name)).toEqual(["read_ext", "bash", "glob", "grep", "read"]);
    expect(body.tool_choice.function.name).toBe("read_ext");
    expect(credentials._opencodeToolNameMap.get("read_ext")).toBe("read");
    expectGateShape(body.tools.filter((t) => defOf(t).name !== "read_ext"));
  });

  it("maps a lowercase decoy call back to a differently-cased caller tool", () => {
    const executor = getExecutor("opencode");
    const credentials = {};
    const body = fakeResponsesBody(["Bash", "Read"].map(responsesTool));
    executor.transformRequest("muse-spark-1.3-contributor-free", body, true, credentials);
    expect(credentials._opencodeToolNameMap.get("bash")).toBe("Bash");
    expect(credentials._opencodeToolNameMap.get("read")).toBe("Read");
    expect(namesOf(body).has("Bash")).toBe(true);
    expectGateShape(body.tools.filter((t) => !["Bash", "Read"].includes(defOf(t).name)));
  });
});
