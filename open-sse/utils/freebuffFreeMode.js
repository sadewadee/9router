import { createHash } from "crypto";
import { FREEBUFF_AGENT_ID_BY_MODEL } from "../executors/freebuff.js";

export const CARRIER_PLAN_SYMBOL = Symbol("freebuffCarrierPlan");

const CARRIER_PREFIX = "proxy__";
const WIRE_NAME_MAX = 64;
const HASH_SUFFIX_LENGTH = 9;
const CARRIER_BASE_MAX = WIRE_NAME_MAX - CARRIER_PREFIX.length - HASH_SUFFIX_LENGTH;
const CATALOG_KEY_PATTERN = /^m-[0-9a-f]{10}$/;

const CLAUDE_CODE_TOOLS = [
  "Agent", "AskUserQuestion", "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read",
  "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "Task", "Skill", "SlashCommand",
  "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree", "ToolSearch", "CronCreate", "CronDelete",
  "CronList", "CronUpdate", "SendMessage", "ListAgents", "TaskStop", "TaskOutput", "Monitor",
  "ScheduleWakeup", "DesignSync", "Artifact",
];
const CURSOR_TOOLS = ["AskQuestion", "ReadLints", "StrReplace", "Shell", "Delete"];
const CODEX_TOOLS = ["exec_command", "write_stdin", "request_user_input"];
const OPENCLAW_TOOLS = ["browser_exec", "delegate_task", "computer_use"];
const OPENCODE_TOOLS = ["todowrite", "todoread", "webfetch"];

export const FOREIGN_TOOL_NAMES = new Set([
  ...CLAUDE_CODE_TOOLS,
  ...CURSOR_TOOLS,
  ...CODEX_TOOLS,
  ...OPENCLAW_TOOLS,
  ...OPENCODE_TOOLS,
]);

export const OFFICIAL_TOOL_NAMES = new Set([
  "add_message", "apply_patch", "add_subgoal", "ask_user", "browser_logs", "cloud_plan_ready",
  "code_search", "composio_get_tool_schemas", "composio_manage_connections", "composio_multi_execute_tool",
  "composio_search_tools", "create_plan", "end_turn", "find_files", "glob", "gravity_index",
  "list_directory", "lookup_agent_info", "propose_str_replace", "propose_write_file", "read_docs",
  "read_files", "read_subtree", "read_url", "render_ui", "run_file_change_hooks", "run_terminal_command",
  "set_messages", "set_output", "skill", "spawn_agent_inline", "spawn_agents", "str_replace",
  "suggest_followups", "task_completed", "think_deeply", "update_subgoal", "web_search", "write_file",
  "write_todos", "decide",
]);

export const SIGNATURE_TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "lookup_agent_info",
      description: "Protocol compatibility marker. Do not call this function.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent ID (short local or full published format)" },
        },
        required: ["agentId"],
        description: "Retrieve information about an agent by ID",
      },
    },
  },
  {
    type: "function",
    function: {
      name: "decide",
      description: "Protocol compatibility marker. Do not call this function.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export function resolveFreebuffAgent(model) {
  if (typeof model === "string") {
    if (CATALOG_KEY_PATTERN.test(model) || model.startsWith("fbm1.")) return "base2-free";
    if (FREEBUFF_AGENT_ID_BY_MODEL[model]) return FREEBUFF_AGENT_ID_BY_MODEL[model];
  }
  return "codebuff";
}

function neutralizeText(text) {
  return text
    .replace(/^[ \t]*x-anthropic-billing-header:[^\n]*(?:\n|$)/gim, "")
    .replace(/\bcc_[a-z0-9_]+=[^;\s]*;?[ \t]*/gi, "")
    .replace(/You are Claude Code/g, "You are a coding agent")
    .replace(/Anthropic[’']s official CLI/g, "a coding CLI tool");
}

function neutralizeMessage(message) {
  if (typeof message.content === "string") {
    const content = neutralizeText(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (typeof part?.text !== "string") return part;
    const text = neutralizeText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...message, content } : message;
}

export function neutralizeSystemPromptMarkers(messages) {
  return messages.map((message) => (message?.role === "system" ? neutralizeMessage(message) : message));
}

function carrierNameFor(name) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const wire = `${CARRIER_PREFIX}${name}`;
  if (safe === name && wire.length <= WIRE_NAME_MAX) return wire;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${CARRIER_PREFIX}${safe.slice(0, CARRIER_BASE_MAX)}_${hash}`;
}

export function packToolsForFreebuff(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { tools, carrierPlan: { forward: {}, carriers: {}, active: false } };
  }
  const forward = {};
  const carriers = {};
  const packed = tools.map((tool) => {
    const name = tool?.function?.name;
    if (typeof name !== "string" || OFFICIAL_TOOL_NAMES.has(name)) return tool;
    const wire = carrierNameFor(name);
    forward[name] = wire;
    carriers[wire] = name;
    return { ...tool, function: { ...tool.function, name: wire } };
  });
  const present = new Set(packed.map((tool) => tool?.function?.name));
  for (const definition of SIGNATURE_TOOL_DEFINITIONS) {
    if (!present.has(definition.function.name)) packed.push(structuredClone(definition));
  }
  return { tools: packed, carrierPlan: { forward, carriers, active: Object.keys(carriers).length > 0 } };
}

function wireNameOf(carrierPlan, name) {
  return typeof name === "string" && Object.hasOwn(carrierPlan.forward, name) ? carrierPlan.forward[name] : name;
}

function aliasToolCall(call, carrierPlan) {
  const name = call?.function?.name;
  const wire = wireNameOf(carrierPlan, name);
  if (wire === name) return call;
  return { ...call, function: { ...call.function, name: wire } };
}

function aliasAssistant(message, carrierPlan) {
  let changed = false;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => {
        const next = aliasToolCall(call, carrierPlan);
        if (next !== call) changed = true;
        return next;
      })
    : message.tool_calls;
  let functionCall = message.function_call;
  if (typeof functionCall?.name === "string") {
    const wire = wireNameOf(carrierPlan, functionCall.name);
    if (wire !== functionCall.name) {
      functionCall = { ...functionCall, name: wire };
      changed = true;
    }
  }
  return changed ? { ...message, tool_calls: toolCalls, function_call: functionCall } : message;
}

export function alignHistoryToolNames(messages, carrierPlan) {
  if (!carrierPlan?.active) return messages;
  let changed = false;
  const aligned = messages.map((message) => {
    let next = message;
    if (message?.role === "assistant") next = aliasAssistant(message, carrierPlan);
    else if (message?.role === "tool") {
      const wire = wireNameOf(carrierPlan, message.name);
      if (wire !== message.name) next = { ...message, name: wire };
    }
    if (next !== message) changed = true;
    return next;
  });
  return changed ? aligned : messages;
}

function restoreCalls(calls, carriers) {
  if (!Array.isArray(calls)) return;
  for (const call of calls) {
    const name = call?.function?.name;
    if (typeof name === "string" && Object.hasOwn(carriers, name)) call.function.name = carriers[name];
  }
}

export function unpackCarrierToolCalls(body, carrierPlan) {
  const carriers = carrierPlan?.carriers;
  if (!carriers || !body || typeof body !== "object" || !Array.isArray(body.choices)) return body;
  for (const choice of body.choices) {
    restoreCalls(choice?.message?.tool_calls, carriers);
    restoreCalls(choice?.delta?.tool_calls, carriers);
  }
  return body;
}

export function createCarrierSseTransform(carrierPlan) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const restoreLine = (line) => {
    const match = /^data:[ \t]?(.*)(\r?)$/.exec(line);
    if (!match || match[1].trim() === "[DONE]") return line;
    try {
      const json = unpackCarrierToolCalls(JSON.parse(match[1]), carrierPlan);
      return `data: ${JSON.stringify(json)}${match[2]}`;
    } catch {
      return line;
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let out = "";
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        out += `${restoreLine(buffer.slice(0, newline))}\n`;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (out) controller.enqueue(encoder.encode(out));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(restoreLine(buffer)));
      buffer = "";
    },
  });
}

export function resolveCostMode(costMode, envOverride) {
  let mode = "free";
  if (costMode != null) mode = costMode;
  else if (envOverride) mode = envOverride;
  return mode === "omit" || mode === "none" ? null : mode;
}
