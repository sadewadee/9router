import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { __test__ } from "../../open-sse/executors/freebuff.js";
import {
  resolveFreebuffAgent,
  neutralizeSystemPromptMarkers,
  packToolsForFreebuff,
  alignHistoryToolNames,
  unpackCarrierToolCalls,
  createCarrierSseTransform,
  resolveCostMode,
  CARRIER_PLAN_SYMBOL,
  OFFICIAL_TOOL_NAMES,
} from "../../open-sse/utils/freebuffFreeMode.js";

const { buildChatBody } = __test__;

const tool = (name, parameters = { type: "object", properties: { x: { type: "string" } } }) => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters },
});

async function runTransform(plan, chunks) {
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(createCarrierSseTransform(plan))).text();
  return out;
}

beforeEach(() => {
  delete process.env.FREEBUFF_COST_MODE;
  delete process.env.FREEBUFF_FOLD_TOOLS;
});

afterEach(() => {
  delete process.env.FREEBUFF_COST_MODE;
});

describe("resolveFreebuffAgent", () => {
  it("maps catalog keys and opaque handles to the catalog root agent", () => {
    expect(resolveFreebuffAgent("m-096e75164d")).toBe("base3-free-catalog");
    expect(resolveFreebuffAgent("m-7e20df6765")).toBe("base3-free-catalog");
    expect(resolveFreebuffAgent("fbm1.abc123")).toBe("base3-free-catalog");
  });

  it("keeps the pinned agent for legacy model ids", () => {
    expect(resolveFreebuffAgent("deepseek/deepseek-v4-flash")).toBe("base3-free-deepseek-flash");
    expect(resolveFreebuffAgent("mimo/mimo-v2.5")).toBe("base3-free-mimo");
  });

  it("falls back to codebuff for unknown models", () => {
    expect(resolveFreebuffAgent("some-unknown-model")).toBe("codebuff");
  });
});

describe("neutralizeSystemPromptMarkers", () => {
  it("rewrites the Claude Code identity and CLI phrase", () => {
    const [sys] = neutralizeSystemPromptMarkers([
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for coding." },
    ]);
    expect(sys.content).toBe("You are a coding agent, a coding CLI tool for coding.");
  });

  it("accepts the curly apostrophe in the CLI phrase", () => {
    const [sys] = neutralizeSystemPromptMarkers([{ role: "system", content: "Anthropic’s official CLI" }]);
    expect(sys.content).toBe("a coding CLI tool");
  });

  it("removes cc_ key-value segments", () => {
    const [sys] = neutralizeSystemPromptMarkers([
      { role: "system", content: "cc_version=1.2.3;cc_entrypoint=main; Keep this." },
    ]);
    expect(sys.content).toBe("Keep this.");
  });

  it("removes the whole billing header line", () => {
    const [sys] = neutralizeSystemPromptMarkers([
      { role: "system", content: "X-Anthropic-Billing-Header: Bearer xxx\nBe helpful." },
    ]);
    expect(sys.content).toBe("Be helpful.");
  });

  it("leaves non-system messages untouched", () => {
    const user = { role: "user", content: "You are Claude Code cc_version=1" };
    const [, out] = neutralizeSystemPromptMarkers([{ role: "system", content: "x" }, user]);
    expect(out).toBe(user);
  });

  it("handles array content parts without mutating the input", () => {
    const input = [{ role: "system", content: [{ type: "text", text: "You are Claude Code" }, { type: "image", url: "u" }] }];
    const out = neutralizeSystemPromptMarkers(input);
    expect(out[0].content[0].text).toBe("You are a coding agent");
    expect(out[0].content[1]).toEqual({ type: "image", url: "u" });
    expect(input[0].content[0].text).toBe("You are Claude Code");
  });
});

describe("packToolsForFreebuff", () => {
  it("renames foreign tools to proxy__ carriers and appends signature tools", () => {
    const { tools, carrierPlan } = packToolsForFreebuff([tool("Bash"), tool("Read")]);
    const names = tools.map((t) => t.function.name);
    expect(names).toEqual(["proxy__Bash", "proxy__Read", "lookup_agent_info", "decide"]);
    expect(carrierPlan.active).toBe(true);
    expect(carrierPlan.forward).toEqual({ Bash: "proxy__Bash", Read: "proxy__Read" });
    expect(carrierPlan.carriers).toEqual({ proxy__Bash: "Bash", proxy__Read: "Read" });
  });

  it("keeps official tool names as-is", () => {
    const { tools, carrierPlan } = packToolsForFreebuff([tool("web_search")]);
    expect(tools[0].function.name).toBe("web_search");
    expect(carrierPlan.active).toBe(false);
  });

  it("does not duplicate signature tools already present", () => {
    const { tools } = packToolsForFreebuff([tool("lookup_agent_info"), tool("decide")]);
    const names = tools.map((t) => t.function.name);
    expect(names.filter((n) => n === "lookup_agent_info")).toHaveLength(1);
    expect(names.filter((n) => n === "decide")).toHaveLength(1);
  });

  it("returns empty tools unchanged with no signature tools", () => {
    const empty = [];
    const { tools, carrierPlan } = packToolsForFreebuff(empty);
    expect(tools).toBe(empty);
    expect(carrierPlan.active).toBe(false);
  });

  it("keeps carrier names within 64 chars and hashes truncated names", () => {
    const longName = "A".repeat(90);
    const { tools, carrierPlan } = packToolsForFreebuff([tool(longName)]);
    const wire = tools[0].function.name;
    const hash = createHash("sha256").update(longName).digest("hex").slice(0, 8);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(wire.startsWith("proxy__")).toBe(true);
    expect(wire.endsWith(`_${hash}`)).toBe(true);
    expect(carrierPlan.carriers[wire]).toBe(longName);
  });

  it("keeps distinct long names with a shared prefix apart", () => {
    const a = `${"B".repeat(80)}_one`;
    const b = `${"B".repeat(80)}_two`;
    const { carrierPlan } = packToolsForFreebuff([tool(a), tool(b)]);
    expect(Object.keys(carrierPlan.carriers)).toHaveLength(2);
  });

  it("does not treat any foreign name as official", () => {
    for (const name of ["Bash", "Read", "Agent", "exec_command"]) {
      expect(OFFICIAL_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

describe("alignHistoryToolNames", () => {
  const { carrierPlan } = packToolsForFreebuff([tool("Bash"), tool("Read")]);

  it("rewrites assistant tool_calls and tool message names", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", name: "Read", content: "ok" },
    ];
    const out = alignHistoryToolNames(messages, carrierPlan);
    expect(out[1].tool_calls[0].function.name).toBe("proxy__Bash");
    expect(out[2].name).toBe("proxy__Read");
    expect(messages[1].tool_calls[0].function.name).toBe("Bash");
  });

  it("returns the same reference when nothing matches", () => {
    const messages = [{ role: "user", content: "hi" }, { role: "tool", name: "web_search", content: "x" }];
    expect(alignHistoryToolNames(messages, carrierPlan)).toBe(messages);
  });

  it("returns the same reference when no carrier plan is active", () => {
    const messages = [{ role: "assistant", tool_calls: [{ function: { name: "Bash" } }] }];
    expect(alignHistoryToolNames(messages, null)).toBe(messages);
  });
});

describe("unpackCarrierToolCalls", () => {
  it("restores the original tool name in a non-streaming body", () => {
    const { carrierPlan } = packToolsForFreebuff([tool("Bash")]);
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "proxy__Bash" } }] } }] };
    unpackCarrierToolCalls(body, carrierPlan);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Bash");
  });

  it("leaves unknown names alone", () => {
    const { carrierPlan } = packToolsForFreebuff([tool("Bash")]);
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "write_file" } }] } }] };
    unpackCarrierToolCalls(body, carrierPlan);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("write_file");
  });
});

describe("createCarrierSseTransform", () => {
  const { carrierPlan } = packToolsForFreebuff([tool("Bash")]);

  it("restores carrier names in data lines", async () => {
    const line = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "proxy__Bash" } }] } }] })}\n\n`;
    const out = await runTransform(carrierPlan, [line]);
    expect(out).toContain('"name":"Bash"');
    expect(out).not.toContain("proxy__");
  });

  it("passes [DONE] and non-data lines through unchanged", async () => {
    const out = await runTransform(carrierPlan, ["event: message\n", ": keepalive\n", "data: [DONE]\n"]);
    expect(out).toBe("event: message\n: keepalive\ndata: [DONE]\n");
  });

  it("buffers partial chunks until the newline arrives", async () => {
    const full = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "proxy__Bash" } }] } }] })}\n`;
    const mid = Math.floor(full.length / 2);
    const out = await runTransform(carrierPlan, [full.slice(0, mid), full.slice(mid)]);
    expect(JSON.parse(out.slice(6).trim()).choices[0].delta.tool_calls[0].function.name).toBe("Bash");
  });

  it("flushes a trailing line without a newline", async () => {
    const out = await runTransform(carrierPlan, [`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "proxy__Bash" } }] } }] })}`]);
    expect(out).toContain('"name":"Bash"');
  });

  it("passes malformed data lines through unchanged", async () => {
    const out = await runTransform(carrierPlan, ["data: {not json\n"]);
    expect(out).toBe("data: {not json\n");
  });
});

describe("resolveCostMode", () => {
  it("defaults to free", () => {
    expect(resolveCostMode(null, null)).toBe("free");
    expect(resolveCostMode(undefined, null)).toBe("free");
  });

  it("prefers an explicit cost mode over the env override", () => {
    expect(resolveCostMode("free", null)).toBe("free");
    expect(resolveCostMode("normal", "free")).toBe("normal");
  });

  it("uses the env override when no explicit mode is passed", () => {
    expect(resolveCostMode(null, "free")).toBe("free");
  });

  it("omits the field for omit and none", () => {
    expect(resolveCostMode("omit", null)).toBeNull();
    expect(resolveCostMode("none", "free")).toBeNull();
    expect(resolveCostMode(null, "omit")).toBeNull();
  });
});

describe("buildChatBody with freeModeTransforms", () => {
  const baseBody = () => ({
    messages: [
      { role: "system", content: "You are Claude Code, Anthropic's official CLI. cc_version=1.0.0;" },
      { role: "user", content: "fix it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "Bash", content: "done" },
    ],
    tools: [tool("Bash"), tool("web_search")],
  });

  it("neutralizes markers, packs tools, aligns history, and defaults cost_mode to free", () => {
    const body = buildChatBody(baseBody(), { model: "m", runId: "r", freeModeTransforms: {} });
    const sys = body.messages.find((m) => m.role === "system" && m.content.includes("coding agent"));
    expect(sys.content).not.toMatch(/Claude Code|official CLI|cc_version/);
    const names = body.tools.map((t) => t.function.name);
    expect(names).toEqual(["proxy__Bash", "web_search", "lookup_agent_info", "decide"]);
    expect(body.messages.find((m) => m.role === "assistant").tool_calls[0].function.name).toBe("proxy__Bash");
    expect(body.messages.find((m) => m.role === "tool").name).toBe("proxy__Bash");
    expect(body.codebuff_metadata.cost_mode).toBe("free");
    expect(body[CARRIER_PLAN_SYMBOL].active).toBe(true);
  });

  it("honours the env override and the omit sentinel", () => {
    process.env.FREEBUFF_COST_MODE = "normal";
    expect(buildChatBody(baseBody(), { model: "m", runId: "r", freeModeTransforms: {} }).codebuff_metadata.cost_mode).toBe("normal");
    process.env.FREEBUFF_COST_MODE = "omit";
    expect(buildChatBody(baseBody(), { model: "m", runId: "r", freeModeTransforms: {} }).codebuff_metadata.cost_mode).toBeUndefined();
  });

  it("keeps the old behaviour without freeModeTransforms", () => {
    const body = buildChatBody(baseBody(), { model: "m", runId: "r" });
    expect(body.tools.map((t) => t.function.name)).toEqual(["Bash", "web_search"]);
    expect(body.messages[1].content).toContain("You are Claude Code");
    expect(body.messages.find((m) => m.role === "assistant").tool_calls[0].function.name).toBe("Bash");
    expect(body.codebuff_metadata.cost_mode).toBeUndefined();
    expect(body[CARRIER_PLAN_SYMBOL]).toBeUndefined();
  });

  it("stays out of the request JSON for the carrier plan", () => {
    const body = buildChatBody(baseBody(), { model: "m", runId: "r", freeModeTransforms: {} });
    const parsed = JSON.parse(JSON.stringify(body));
    expect(parsed[CARRIER_PLAN_SYMBOL]).toBeUndefined();
    expect(parsed.tools.some((t) => t.function.name === "proxy__Bash")).toBe(true);
  });
});

