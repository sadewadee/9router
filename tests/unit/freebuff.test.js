/**
 * Unit tests for the Freebuff (Codebuff free mode) provider.
 *
 * Nothing here talks to codebuff.com: proxyAwareFetch (executor) and global fetch (OAuth) are mocked.
 * Covers the parts that would silently break the free-mode handshake:
 *   - registration (registry entry, executor aliases, OAuth provider, model list vs. agent ids)
 *   - canonical system-prompt opening (byte-exact prefix gate, caller text never wrapped)
 *   - request body (codebuff_metadata, tools passthrough vs. FREEBUFF_FOLD_TOOLS)
 *   - session handshake (admission, cache, in-flight dedupe, queued -> 503, model_locked retry)
 *   - agent run START / FINISH lifecycle around the response stream
 *   - direct egress (relay proxy pools are ignored, plain proxies honoured)
 *   - upstream error pass-through and the dashboard token probe
 *   - device-code OAuth flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock proxyAwareFetch so no test ever reaches the network.
const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

import {
  FreebuffExecutor,
  FREEBUFF_AGENT_ID_BY_MODEL,
  FREEBUFF_ROOT_OPENING,
  probeFreebuffToken,
  __test__,
} from "../../open-sse/executors/freebuff.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getDefaultModel } from "../../open-sse/config/providerModels.js";
import { parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";
import freebuffRegistry from "../../open-sse/providers/registry/freebuff.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FREE_PROVIDERS, AI_PROVIDERS } from "../../src/shared/constants/providers.js";

const {
  ensureRootOpening,
  buildChatBody,
  buildToolNotice,
  normalizeToolSchemas,
  wrapStreamWithCleanup,
  directEgressOptions,
  generateClientId,
  clearSessionCache,
  sessions,
  warnedRelays,
  ROOT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  DEFAULT_USER_AGENT,
  CHAT_URL,
  AGENT_RUNS_URL,
  SESSION_URL,
  SESSION_ADMISSION_URL,
} = __test__;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(chunks) {
  const parts = chunks || ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

let tokenCounter = 0;
function newToken() {
  tokenCounter += 1;
  return `fb-test-token-${tokenCounter}`;
}

function parseCall([url, init, opts]) {
  let body = null;
  if (init?.body) {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  return { url, method: init?.method || "GET", headers: init?.headers || {}, body, opts };
}

const allCalls = () => fetchMock.mock.calls.map(parseCall);
const callsTo = (url, method) => allCalls().filter((c) => c.url === url && (!method || c.method === method));
const agentRunCalls = (action) => callsTo(AGENT_RUNS_URL, "POST").filter((c) => c.body?.action === action);

/**
 * Default upstream: admission echoes the claim id back as an active session, START hands out
 * sequential run ids, FINISH is acknowledged, chat streams a tiny SSE body. Per-test overrides
 * replace individual endpoints.
 */
function installUpstream(overrides = {}) {
  let runSeq = 0;
  const handlers = {
    admission: (headers) =>
      json({
        status: "active",
        instanceId: headers["x-freebuff-instance-id"],
        model: headers["x-freebuff-model"],
        remainingMs: 600_000,
      }),
    session: () => json({ status: "none" }),
    start: () => json({ runId: `run-${++runSeq}` }),
    finish: () => json({}),
    chat: () => sse(),
    ...overrides,
  };
  fetchMock.mockImplementation(async (url, init) => {
    const headers = init?.headers || {};
    const body = init?.body ? JSON.parse(init.body) : null;
    if (url === SESSION_ADMISSION_URL) return handlers.admission(headers, body);
    if (url === SESSION_URL) return handlers.session(headers, init?.method);
    if (url === AGENT_RUNS_URL) return body?.action === "FINISH" ? handlers.finish(body) : handlers.start(body);
    if (url === CHAT_URL) return handlers.chat(body, headers);
    throw new Error(`unexpected fetch to ${url}`);
  });
  return handlers;
}

async function drain(response) {
  return await response.text();
}

function makeExecuteArgs(overrides = {}) {
  return {
    model: "mimo/mimo-v2.5",
    body: { model: "cb/mimo/mimo-v2.5", messages: [{ role: "user", content: "hello" }] },
    stream: true,
    credentials: { accessToken: newToken() },
    signal: undefined,
    log: undefined,
    proxyOptions: null,
    ...overrides,
  };
}

const executor = new FreebuffExecutor();

beforeEach(() => {
  fetchMock.mockReset();
  clearSessionCache();
  warnedRelays.clear();
  delete process.env.FREEBUFF_FOLD_TOOLS;
  delete process.env.FREEBUFF_USER_AGENT;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FREEBUFF_FOLD_TOOLS;
  delete process.env.FREEBUFF_USER_AGENT;
});

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("declares the free provider with oauth + apikey modes and both aliases", () => {
    expect(freebuffRegistry.id).toBe("freebuff");
    expect(freebuffRegistry.alias).toBe("cb");
    expect(freebuffRegistry.aliases).toContain("codebuff");
    expect(freebuffRegistry.category).toBe("free");
    expect(freebuffRegistry.hasFree).toBe(true);
    expect(freebuffRegistry.hasOAuth).toBe(true);
    expect(freebuffRegistry.authModes).toEqual(["oauth", "apikey"]);
  });

  it("was added to the registry without clobbering another entry", () => {
    const ids = REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("freebuff");
    expect(ids).toContain("ollama-search");
    expect(new Set(ids).size).toBe(ids.length);

    // A duplicate `import pNN` is a SyntaxError in real ESM even though the test transform tolerates it.
    const source = readFileSync(fileURLToPath(new URL("../../open-sse/providers/registry/index.js", import.meta.url)), "utf8");
    const names = [...source.matchAll(/^import (p\d+) from /gm)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is listed among the free providers with its auth modes", () => {
    expect(FREE_PROVIDERS.freebuff).toBeTruthy();
    expect(FREE_PROVIDERS.freebuff.hasFree).toBe(true);
    expect(FREE_PROVIDERS.freebuff.authModes).toEqual(["oauth", "apikey"]);
    expect(AI_PROVIDERS.freebuff.alias).toBe("cb");
  });

  it("resolves every alias to the freebuff provider, keeping slashes inside model ids", () => {
    expect(resolveProviderAlias("cb")).toBe("freebuff");
    expect(resolveProviderAlias("codebuff")).toBe("freebuff");
    expect(parseModel("cb/z-ai/glm-5.3-flash")).toMatchObject({ provider: "freebuff", model: "z-ai/glm-5.3-flash" });
    expect(parseModel("codebuff/mimo/mimo-v2.5")).toMatchObject({ provider: "freebuff", model: "mimo/mimo-v2.5" });
  });

  it("registers the executor under freebuff, cb and codebuff", async () => {
    // Imported lazily: the executor index pulls in every provider executor (and their root dependencies),
    // which would otherwise take the whole file down in an environment that only installed tests/.
    const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");
    for (const key of ["freebuff", "cb", "codebuff"]) expect(hasSpecializedExecutor(key)).toBe(true);
    expect(getExecutor("freebuff")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("cb")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("codebuff")).toBeInstanceOf(FreebuffExecutor);
    expect(getExecutor("freebuff").getProvider()).toBe("freebuff");
  });

  it("uses the chat completions endpoint as base URL", () => {
    expect(PROVIDERS.freebuff.baseUrl).toBe("https://www.codebuff.com/api/v1/chat/completions");
    expect(executor.buildUrl()).toBe(CHAT_URL);
    expect(PROVIDER_ID_TO_ALIAS.freebuff).toBe("cb");
  });

  it("leads the model list with the upstream fallback model", () => {
    expect(getDefaultModel("cb")).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("mimo/mimo-v2.5");
    expect(PROVIDER_MODELS.cb[0].id).toBe("mimo/mimo-v2.5");
  });

  it("only lists models that have a free-mode root agent id", () => {
    const listed = PROVIDER_MODELS.cb.map((m) => m.id);
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) expect(FREEBUFF_AGENT_ID_BY_MODEL[id]).toMatch(/^base3-free-/);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("maps every model to a distinct base3 agent id", () => {
    const ids = Object.values(FREEBUFF_AGENT_ID_BY_MODEL);
    expect(new Set(ids).size).toBe(ids.length);
    expect(FREEBUFF_AGENT_ID_BY_MODEL["mimo/mimo-v2.5"]).toBe("base3-free-mimo");
    expect(FREEBUFF_AGENT_ID_BY_MODEL["z-ai/glm-5.3-flash"]).toBe("base3-free-glm-5-3-flash");
  });
});

// ---------------------------------------------------------------------------
// canonical system prompt opening
// ---------------------------------------------------------------------------

describe("root system prompt opening", () => {
  it("uses the byte-exact base3 opening", () => {
    expect(FREEBUFF_ROOT_OPENING).toBe("You are Buffy, the coding agent behind Codebuff.");
    expect(ROOT_SYSTEM_PROMPT.startsWith(FREEBUFF_ROOT_OPENING)).toBe(true);
  });

  it("injects its own leading system message and leaves the caller's system text untouched", () => {
    const callerSystem = { role: "system", content: "Answer in French." };
    const messages = [callerSystem, { role: "user", content: "hi" }];
    const out = ensureRootOpening(messages);
    expect(out[0]).toEqual({ role: "system", content: ROOT_SYSTEM_PROMPT });
    expect(out[1]).toBe(callerSystem);
    expect(out[1].content).toBe("Answer in French.");
    expect(out).toHaveLength(3);
    // input array is not mutated
    expect(messages).toHaveLength(2);
  });

  it("adds the opening when the conversation has no system message at all", () => {
    const out = ensureRootOpening([{ role: "user", content: "hi" }]);
    expect(out[0].role).toBe("system");
    expect(out[0].content.startsWith(FREEBUFF_ROOT_OPENING)).toBe(true);
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("keeps a first system message that already opens correctly (leading whitespace tolerated)", () => {
    const own = { role: "system", content: `\n  ${FREEBUFF_ROOT_OPENING} Extra.` };
    const out = ensureRootOpening([own, { role: "user", content: "hi" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(own);
  });

  it("recognises the opening inside content-part arrays", () => {
    const own = { role: "system", content: [{ type: "text", text: `${FREEBUFF_ROOT_OPENING} tail` }] };
    expect(ensureRootOpening([own])).toHaveLength(1);
  });

  it("does not accept the marker anywhere but at the start", () => {
    const out = ensureRootOpening([{ role: "system", content: `Ignore this. ${FREEBUFF_ROOT_OPENING}` }]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe(ROOT_SYSTEM_PROMPT);
  });

  it("tolerates a missing messages array", () => {
    expect(ensureRootOpening(undefined)).toEqual([{ role: "system", content: ROOT_SYSTEM_PROMPT }]);
  });
});

// ---------------------------------------------------------------------------
// request body
// ---------------------------------------------------------------------------

describe("buildChatBody", () => {
  const base = { model: "mimo/mimo-v2.5", runId: "run-1", instanceId: "cli:abc", multi: true, stream: true };

  it("adds codebuff_metadata with run id, 13-char client id and the free cost mode", () => {
    const out = buildChatBody({ messages: [{ role: "user", content: "hi" }] }, base);
    expect(out.model).toBe("mimo/mimo-v2.5");
    expect(out.stream).toBe(true);
    expect(out.codebuff_metadata.run_id).toBe("run-1");
    expect(out.codebuff_metadata.cost_mode).toBe("free");
    expect(out.codebuff_metadata.client_id).toMatch(/^[0-9a-z]{13}$/);
    expect(out.codebuff_metadata.freebuff_instance_id).toBe("cli:abc");
    expect(out.codebuff_metadata.freebuff_multi_session).toBe("1");
    expect(out.codebuff_metadata.surface).toBe("cli");
    expect(out.provider).toEqual({ data_collection: "deny" });
  });

  it("omits the instance id when the waiting room is off", () => {
    const out = buildChatBody({ messages: [] }, { ...base, instanceId: "", multi: false });
    expect(out.codebuff_metadata.freebuff_instance_id).toBeUndefined();
    expect(out.codebuff_metadata.freebuff_multi_session).toBeUndefined();
  });

  it("does not add the multi-session markers for a legacy (non cli:) instance id", () => {
    const out = buildChatBody({ messages: [] }, { ...base, instanceId: "legacy-uuid", multi: false });
    expect(out.codebuff_metadata.freebuff_instance_id).toBe("legacy-uuid");
    expect(out.codebuff_metadata.freebuff_multi_session).toBeUndefined();
    expect(out.codebuff_metadata.surface).toBeUndefined();
  });

  it("never lets the caller override the handshake fields", () => {
    const out = buildChatBody(
      { messages: [], codebuff_metadata: { run_id: "evil", cost_mode: "max" }, provider: { only: ["x"] }, stream: false },
      base,
    );
    expect(out.codebuff_metadata.run_id).toBe("run-1");
    expect(out.codebuff_metadata.cost_mode).toBe("free");
    expect(out.provider).toEqual({ data_collection: "deny" });
    expect(out.stream).toBe(true);
  });

  it("honours a non-streaming request", () => {
    expect(buildChatBody({ messages: [] }, { ...base, stream: false }).stream).toBe(false);
  });

  it("maps max_completion_tokens to max_tokens", () => {
    const out = buildChatBody({ messages: [], max_completion_tokens: 512 }, base);
    expect(out.max_tokens).toBe(512);
    expect(out.max_completion_tokens).toBeUndefined();
    expect(buildChatBody({ messages: [], max_tokens: 10, max_completion_tokens: 99 }, base).max_tokens).toBe(10);
  });

  it("generates fresh base36 client ids", () => {
    expect(generateClientId()).toMatch(/^[0-9a-z]{13}$/);
    expect(generateClientId()).not.toBe(generateClientId());
  });
});

describe("tools handling", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ];
  const base = { model: "mimo/mimo-v2.5", runId: "run-1", instanceId: "cli:abc", multi: true, stream: true };
  const bodyWithTools = () => ({
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
  });

  it("passes tools and tool_choice through by default", () => {
    const out = buildChatBody(bodyWithTools(), base);
    expect(out.tools).toEqual(tools);
    expect(out.tool_choice).toBe("auto");
    expect(out.parallel_tool_calls).toBe(true);
    // canonical opening + the caller's own system message + user message
    expect(out.messages.map((m) => m.role)).toEqual(["system", "system", "user"]);
  });

  it("folds tools into a system message when FREEBUFF_FOLD_TOOLS=1 (read at request time)", () => {
    process.env.FREEBUFF_FOLD_TOOLS = "1";
    const out = buildChatBody(bodyWithTools(), base);
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.parallel_tool_calls).toBeUndefined();
    expect(out.messages[0].content).toBe(ROOT_SYSTEM_PROMPT);
    const notice = out.messages[1];
    expect(notice.role).toBe("system");
    expect(notice.content).toContain("[Available Tools]");
    expect(notice.content).toContain("read_file");
    expect(notice.content).toContain('"path"');

    // flipping the variable back takes effect on the next call without re-importing anything
    delete process.env.FREEBUFF_FOLD_TOOLS;
    expect(buildChatBody(bodyWithTools(), base).tools).toEqual(tools);
  });

  it("does not treat FREEBUFF_FOLD_TOOLS=0 as enabled", () => {
    process.env.FREEBUFF_FOLD_TOOLS = "0";
    expect(buildChatBody(bodyWithTools(), base).tools).toEqual(tools);
  });

  it("builds an empty notice for tools without names", () => {
    expect(buildToolNotice([{ type: "function", function: {} }])).toBe("");
  });

  it("returns schemas without $ref/null constructs unchanged (same object)", () => {
    const out = normalizeToolSchemas(tools);
    expect(out[0]).toBe(tools[0]);
  });

  it("collapses nullable anyOf/type arrays and inlines local $ref", () => {
    const out = normalizeToolSchemas([
      {
        type: "function",
        function: {
          name: "t",
          parameters: {
            type: "object",
            $defs: { Path: { type: "string", description: "p" } },
            properties: {
              a: { anyOf: [{ type: "string" }, { type: "null" }] },
              b: { type: ["integer", "null"] },
              c: { $ref: "#/$defs/Path" },
            },
          },
        },
      },
    ]);
    const props = out[0].function.parameters.properties;
    expect(props.a).toEqual({ type: "string" });
    expect(props.b).toEqual({ type: "integer" });
    expect(props.c).toEqual({ type: "string", description: "p" });
  });
});

// ---------------------------------------------------------------------------
// executor: happy path, headers, run lifecycle
// ---------------------------------------------------------------------------

describe("execute: handshake and run lifecycle", () => {
  it("runs admission -> START -> chat and finishes the run when the stream ends", async () => {
    installUpstream();
    const args = makeExecuteArgs();
    const { response, url, transformedBody } = await executor.execute(args);

    expect(response.status).toBe(200);
    expect(url).toBe(CHAT_URL);
    expect(await drain(response)).toContain("[DONE]");

    const order = allCalls().map((c) => `${c.method} ${c.url}`);
    expect(order.slice(0, 3)).toEqual([
      `POST ${SESSION_ADMISSION_URL}`,
      `POST ${AGENT_RUNS_URL}`,
      `POST ${CHAT_URL}`,
    ]);

    // START carries the agent id resolved from the model
    const [start] = agentRunCalls("START");
    expect(start.body).toEqual({ action: "START", agentId: "base3-free-mimo", ancestorRunIds: [] });

    // chat body ties the run and the session together and opens with the canonical prompt
    const [chat] = callsTo(CHAT_URL);
    const [admission] = callsTo(SESSION_ADMISSION_URL);
    expect(chat.body.model).toBe("mimo/mimo-v2.5");
    expect(chat.body.codebuff_metadata.run_id).toBe("run-1");
    expect(chat.body.codebuff_metadata.freebuff_instance_id).toBe(admission.headers["x-freebuff-instance-id"]);
    expect(chat.body.codebuff_metadata.freebuff_instance_id).toMatch(/^cli:[0-9a-f-]{36}$/);
    expect(chat.body.messages[0]).toEqual({ role: "system", content: ROOT_SYSTEM_PROMPT });
    expect(transformedBody.codebuff_metadata.run_id).toBe("run-1");

    // FINISH is best effort and fired once the body has been read to the end
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));
    expect(agentRunCalls("FINISH")[0].body).toMatchObject({ action: "FINISH", runId: "run-1", status: "completed" });
  });

  it("sends the CLI-style headers on every call", async () => {
    installUpstream();
    const args = makeExecuteArgs();
    const { response } = await executor.execute(args);
    await drain(response);
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));

    const token = args.credentials.accessToken;
    for (const call of allCalls()) {
      expect(call.headers.Authorization).toBe(`Bearer ${token}`);
      expect(call.headers["User-Agent"]).toBe(DEFAULT_USER_AGENT);
    }
    expect(DEFAULT_USER_AGENT).toBe("Freebuff-CLI/0.0.200");

    const [chat] = callsTo(CHAT_URL);
    expect(chat.headers["Content-Type"]).toBe("application/json");
    expect(chat.headers.Accept).toBe("text/event-stream");

    const [admission] = callsTo(SESSION_ADMISSION_URL);
    expect(admission.headers["x-freebuff-model"]).toBe("mimo/mimo-v2.5");
    expect(admission.headers["x-freebuff-multi-session"]).toBe("1");
    expect(admission.headers["x-freebuff-desktop-attempt-id"]).toBe(admission.headers["x-freebuff-instance-id"].slice(4));
    expect(admission.headers["x-fb-timezone"]).toBeTruthy();
  });

  it("asks for JSON on a non-streaming request", async () => {
    installUpstream({ chat: () => json({ choices: [{ message: { content: "hi" } }] }) });
    const { response } = await executor.execute(makeExecuteArgs({ stream: false }));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).choices[0].message.content).toBe("hi");
    const [chat] = callsTo(CHAT_URL);
    expect(chat.headers.Accept).toBe("application/json");
    expect(chat.body.stream).toBe(false);
  });

  it("lets FREEBUFF_USER_AGENT override the User-Agent (read at request time)", async () => {
    process.env.FREEBUFF_USER_AGENT = "Freebuff-CLI/9.9.9";
    installUpstream();
    const { response } = await executor.execute(makeExecuteArgs());
    await drain(response);
    for (const call of allCalls()) expect(call.headers["User-Agent"]).toBe("Freebuff-CLI/9.9.9");
  });

  it("accepts an API-key credential as well as an OAuth access token", async () => {
    installUpstream();
    const key = newToken();
    const { response } = await executor.execute(makeExecuteArgs({ credentials: { apiKey: key } }));
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(CHAT_URL)[0].headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("finishes the run as cancelled when the client goes away mid-stream", async () => {
    installUpstream({
      chat: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
            },
          }),
          { status: 200 },
        ),
    });
    const { response } = await executor.execute(makeExecuteArgs());
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));
    expect(agentRunCalls("FINISH")[0].body.status).toBe("cancelled");
  });

  it("finishes the run as failed when the chat call itself throws", async () => {
    installUpstream({
      chat: () => {
        throw new Error("socket hang up");
      },
    });
    await expect(executor.execute(makeExecuteArgs())).rejects.toThrow("socket hang up");
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));
    expect(agentRunCalls("FINISH")[0].body).toMatchObject({ status: "failed", errorMessage: "socket hang up" });
  });

  it("ignores a FINISH failure", async () => {
    installUpstream({
      finish: () => {
        throw new Error("finish boom");
      },
    });
    const { response } = await executor.execute(makeExecuteArgs());
    await expect(drain(response)).resolves.toContain("[DONE]");
  });

  it("sends tools through by default and folds them when FREEBUFF_FOLD_TOOLS=1", async () => {
    installUpstream();
    const tools = [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }];
    const body = () => ({ messages: [{ role: "user", content: "hi" }], tools, tool_choice: "auto" });

    await drain((await executor.execute(makeExecuteArgs({ body: body() }))).response);
    expect(callsTo(CHAT_URL)[0].body.tools).toEqual(tools);

    fetchMock.mockClear();
    process.env.FREEBUFF_FOLD_TOOLS = "1";
    await drain((await executor.execute(makeExecuteArgs({ body: body() }))).response);
    expect(callsTo(CHAT_URL)[0].body.tools).toBeUndefined();
    expect(callsTo(CHAT_URL)[0].body.messages[1].content).toContain("[Available Tools]");
  });
});

describe("wrapStreamWithCleanup", () => {
  it("reports completion exactly once", async () => {
    const done = vi.fn();
    const wrapped = wrapStreamWithCleanup(sse(["a", "b"]), done);
    expect(await wrapped.text()).toBe("ab");
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toBe("completed");
  });

  it("reports a failure when the body errors", async () => {
    const done = vi.fn();
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("boom"));
        },
      }),
    );
    const wrapped = wrapStreamWithCleanup(broken, done);
    await expect(wrapped.text()).rejects.toThrow("boom");
    expect(done).toHaveBeenCalledWith("failed", "boom");
  });

  it("drops encoding/length headers that no longer describe the decoded body", () => {
    const upstream = new Response("x", { headers: { "content-encoding": "gzip", "content-length": "20", "x-keep": "1" } });
    const wrapped = wrapStreamWithCleanup(upstream, () => {});
    expect(wrapped.headers.get("content-encoding")).toBeNull();
    expect(wrapped.headers.get("content-length")).toBeNull();
    expect(wrapped.headers.get("x-keep")).toBe("1");
  });

  it("finishes immediately for a bodiless response", () => {
    const done = vi.fn();
    const res = new Response(null, { status: 204 });
    expect(wrapStreamWithCleanup(res, done)).toBe(res);
    expect(done).toHaveBeenCalledWith("completed");
  });
});

// ---------------------------------------------------------------------------
// session cache, dedupe, queued, model_locked
// ---------------------------------------------------------------------------

describe("free session handling", () => {
  it("reuses the session for the same token and model, but not across tokens or models", async () => {
    installUpstream();
    const credentials = { accessToken: newToken() };

    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);
    // ...but every request still gets its own agent run
    expect(agentRunCalls("START")).toHaveLength(2);
    // the second chat call reuses the first session's instance id
    const [first, second] = callsTo(CHAT_URL);
    expect(second.body.codebuff_metadata.freebuff_instance_id).toBe(first.body.codebuff_metadata.freebuff_instance_id);
    expect(second.body.codebuff_metadata.run_id).not.toBe(first.body.codebuff_metadata.run_id);

    await drain((await executor.execute(makeExecuteArgs({ credentials, model: "z-ai/glm-5.3-flash" }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);

    await drain((await executor.execute(makeExecuteArgs({ credentials: { accessToken: newToken() } }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(3);
  });

  it("never keeps the raw token as a cache key", async () => {
    installUpstream();
    const credentials = { accessToken: newToken() };
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(sessions.size).toBe(1);
    for (const key of sessions.keys()) expect(key).not.toContain(credentials.accessToken);
  });

  it("admits a fresh session once the cached one is about to expire", async () => {
    installUpstream();
    const credentials = { accessToken: newToken() };
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);

    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now");
    // remainingMs is 600s and the cache keeps a 60s safety margin
    nowSpy.mockReturnValue(realNow + 530_000);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);

    nowSpy.mockReturnValue(realNow + 545_000);
    await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);
  });

  it("shares one in-flight admission between concurrent requests", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    installUpstream({
      admission: async (headers) => {
        await gate;
        return json({ status: "active", instanceId: headers["x-freebuff-instance-id"], model: headers["x-freebuff-model"], remainingMs: 600_000 });
      },
    });
    const credentials = { accessToken: newToken() };
    const runs = [
      executor.execute(makeExecuteArgs({ credentials })),
      executor.execute(makeExecuteArgs({ credentials })),
      executor.execute(makeExecuteArgs({ credentials })),
    ];
    await vi.waitFor(() => expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1));
    release();
    const results = await Promise.all(runs);
    for (const r of results) await drain(r.response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);
    expect(agentRunCalls("START")).toHaveLength(3);
  });

  it("keeps a shared admission alive when the first caller aborts", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    installUpstream({
      admission: async (headers) => {
        await gate;
        return json({ status: "active", instanceId: headers["x-freebuff-instance-id"], model: headers["x-freebuff-model"], remainingMs: 600_000 });
      },
    });
    const credentials = { accessToken: newToken() };
    const controller = new AbortController();
    const first = executor.execute(makeExecuteArgs({ credentials, signal: controller.signal }));
    const second = executor.execute(makeExecuteArgs({ credentials }));
    await vi.waitFor(() => expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1));
    controller.abort();
    release();
    await first.catch(() => {});
    const { response } = await second;
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);
  });

  it("does not cache a failed admission", async () => {
    let calls = 0;
    installUpstream({
      admission: (headers) => {
        calls += 1;
        if (calls === 1) return json({ error: "boom" }, { status: 500 });
        return json({ status: "active", instanceId: headers["x-freebuff-instance-id"], model: headers["x-freebuff-model"], remainingMs: 600_000 });
      },
    });
    const credentials = { accessToken: newToken() };
    const first = await executor.execute(makeExecuteArgs({ credentials }));
    expect(first.response.status).toBe(500);
    const second = await executor.execute(makeExecuteArgs({ credentials }));
    expect(second.response.status).toBe(200);
    await drain(second.response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);
  });

  describe("queued", () => {
    const queued = (estimatedWaitMs) => () =>
      json({ status: "queued", instanceId: "cli:queued-1", position: 3, queueDepth: 9, estimatedWaitMs });

    it("answers 503 with Retry-After and an OpenAI-style error body, without starting a run", async () => {
      installUpstream({ admission: queued(12_000) });
      const { response } = await executor.execute(makeExecuteArgs());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("12");
      const body = await response.json();
      expect(body.error.code).toBe("waiting_room_queued");
      expect(body.error.type).toBe("server_error");
      expect(body.error.message).toContain("position 3/9");
      expect(agentRunCalls("START")).toHaveLength(0);
      expect(callsTo(CHAT_URL)).toHaveLength(0);
    });

    it("clamps Retry-After between 1 and 30 seconds", async () => {
      installUpstream({ admission: queued(600_000) });
      expect((await executor.execute(makeExecuteArgs())).response.headers.get("retry-after")).toBe("30");
      clearSessionCache();
      installUpstream({ admission: queued(0) });
      expect((await executor.execute(makeExecuteArgs())).response.headers.get("retry-after")).toBe("1");
    });

    it("does not re-admit while the queue answer is fresh, then polls the queued instance", async () => {
      const handlers = installUpstream({ admission: queued(5_000) });
      const credentials = { accessToken: newToken() };
      const first = await executor.execute(makeExecuteArgs({ credentials }));
      expect(first.response.status).toBe(503);

      const again = await executor.execute(makeExecuteArgs({ credentials }));
      expect(again.response.status).toBe(503);
      expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);
      expect(callsTo(SESSION_URL)).toHaveLength(0);

      // once the retry window has passed the queued instance is polled and can turn active
      handlers.session = () => json({ status: "active", instanceId: "cli:queued-1", model: "mimo/mimo-v2.5", remainingMs: 600_000 });
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(Date.now() + 10_000);
      const ok = await executor.execute(makeExecuteArgs({ credentials }));
      expect(ok.response.status).toBe(200);
      await drain(ok.response);
      const [poll] = callsTo(SESSION_URL, "GET");
      expect(poll.headers["x-freebuff-instance-id"]).toBe("cli:queued-1");
      expect(callsTo(CHAT_URL)[0].body.codebuff_metadata.freebuff_instance_id).toBe("cli:queued-1");
    });
  });

  describe("model_locked", () => {
    const lockedTo = (currentModel) => (headers) =>
      headers["x-freebuff-model"] === currentModel
        ? json({ status: "active", instanceId: headers["x-freebuff-instance-id"], model: currentModel, remainingMs: 600_000 })
        : json({ status: "model_locked", currentModel, requestedModel: headers["x-freebuff-model"] }, { status: 409 });

    it("retries once with the locked model and uses its agent id and model for the chat call", async () => {
      installUpstream({ admission: lockedTo("z-ai/glm-5.3-flash") });
      const { response } = await executor.execute(makeExecuteArgs({ model: "mimo/mimo-v2.5" }));
      expect(response.status).toBe(200);
      await drain(response);

      const admissions = callsTo(SESSION_ADMISSION_URL);
      expect(admissions.map((c) => c.headers["x-freebuff-model"])).toEqual(["mimo/mimo-v2.5", "z-ai/glm-5.3-flash"]);
      expect(agentRunCalls("START")[0].body.agentId).toBe("base3-free-glm-5-3-flash");
      expect(callsTo(CHAT_URL)[0].body.model).toBe("z-ai/glm-5.3-flash");
    });

    it("remembers the lock instead of repeating the round trip on every request", async () => {
      installUpstream({ admission: lockedTo("z-ai/glm-5.3-flash") });
      const credentials = { accessToken: newToken() };
      await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
      await drain((await executor.execute(makeExecuteArgs({ credentials }))).response);
      expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);
      expect(callsTo(CHAT_URL)).toHaveLength(2);
    });

    it("passes a lock onto a model this proxy cannot run through as a 409", async () => {
      installUpstream({ admission: lockedTo("some/unknown-model") });
      const { response } = await executor.execute(makeExecuteArgs());
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("model_locked");
      expect(body.error.upstream.currentModel).toBe("some/unknown-model");
      expect(callsTo(CHAT_URL)).toHaveLength(0);
    });
  });

  it("falls back to the legacy session route when the admission route does not exist", async () => {
    installUpstream({
      admission: () => json({ error: "not found" }, { status: 404 }),
      session: (headers, method) =>
        method === "POST" ? json({ status: "active", instanceId: "legacy-1", model: headers["x-freebuff-model"], remainingMs: 600_000 }) : json({ status: "none" }),
    });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(SESSION_URL, "POST")).toHaveLength(1);
    const meta = callsTo(CHAT_URL)[0].body.codebuff_metadata;
    expect(meta.freebuff_instance_id).toBe("legacy-1");
    expect(meta.freebuff_multi_session).toBeUndefined();
  });

  it("chats without an instance id when the waiting room is disabled", async () => {
    installUpstream({ admission: () => json({ status: "disabled" }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(CHAT_URL)[0].body.codebuff_metadata.freebuff_instance_id).toBeUndefined();
  });

  it("re-admits once when the chat gate says the session is gone", async () => {
    let chats = 0;
    installUpstream({
      chat: () => {
        chats += 1;
        return chats === 1 ? json({ error: "session_superseded", message: "Another session took over" }, { status: 409 }) : sse();
      },
    });
    const credentials = { accessToken: newToken() };
    const { response } = await executor.execute(makeExecuteArgs({ credentials }));
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);
    expect(agentRunCalls("START")).toHaveLength(2);
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(2));
    expect(agentRunCalls("FINISH").map((c) => c.body.status).sort()).toEqual(["completed", "failed"]);
  });

  it("gives up after a single re-admission", async () => {
    installUpstream({ chat: () => json({ error: "session_superseded", message: "gone" }, { status: 409 }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(409);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);
  });

  it("re-admits when START reports a dead session, but not for its own queued answer", async () => {
    let starts = 0;
    installUpstream({
      start: () => {
        starts += 1;
        return starts === 1 ? json({ error: "session_expired", message: "expired" }, { status: 409 }) : json({ runId: "run-ok" });
      },
    });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(2);

    fetchMock.mockReset();
    clearSessionCache();
    installUpstream({ admission: () => json({ status: "queued", instanceId: "cli:q", estimatedWaitMs: 1000 }) });
    const queued = await executor.execute(makeExecuteArgs());
    expect(queued.response.status).toBe(503);
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// direct egress
// ---------------------------------------------------------------------------

describe("direct egress", () => {
  const relay = "https://relay.example.workers.dev/proxy";

  it("drops a relay pool URL but keeps plain proxy settings", () => {
    const log = { warn: vi.fn() };
    const out = directEgressOptions(
      { vercelRelayUrl: relay, connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8080", connectionNoProxy: "localhost" },
      log,
    );
    expect(out).toEqual({ connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:8080", connectionNoProxy: "localhost" });
    expect(out.vercelRelayUrl).toBeUndefined();
  });

  it("passes options without a relay through untouched", () => {
    const opts = { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:1080" };
    expect(directEgressOptions(opts)).toBe(opts);
    expect(directEgressOptions(null)).toBeNull();
    expect(directEgressOptions(undefined)).toBeUndefined();
  });

  it("warns once per relay with a single line", () => {
    const log = { warn: vi.fn() };
    directEgressOptions({ vercelRelayUrl: relay }, log);
    directEgressOptions({ vercelRelayUrl: relay }, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toBe("FREEBUFF");
    expect(log.warn.mock.calls[0][1]).toMatch(/relay/i);
    directEgressOptions({ vercelRelayUrl: `${relay}2` }, log);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it("never hands the relay URL to any of the outgoing calls", async () => {
    installUpstream();
    const log = { warn: vi.fn(), debug: vi.fn() };
    const { response } = await executor.execute(
      makeExecuteArgs({ log, proxyOptions: { vercelRelayUrl: relay, connectionProxyEnabled: false } }),
    );
    await drain(response);
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));

    const calls = allCalls();
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) {
      expect(call.opts?.vercelRelayUrl).toBeUndefined();
      expect(JSON.stringify(call.opts || {})).not.toContain("relay.example");
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("still routes through a plain HTTP/SOCKS proxy", async () => {
    installUpstream();
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:1080", connectionNoProxy: "" };
    const { response } = await executor.execute(makeExecuteArgs({ proxyOptions }));
    await drain(response);
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));
    for (const call of allCalls()) expect(call.opts).toEqual(proxyOptions);
  });
});

// ---------------------------------------------------------------------------
// error pass-through
// ---------------------------------------------------------------------------

describe("upstream errors", () => {
  it.each([
    [403, { error: "free_mode_cli_required", message: "Free mode requires the Freebuff CLI" }],
    [403, { error: "country_blocked", message: "Free mode is not available in your country" }],
    [409, { error: "model_locked", message: "Session locked" }],
    [403, { error: "free_mode_invalid_agent_hierarchy", message: "Invalid agent hierarchy" }],
    [401, { error: "unauthorized", message: "Invalid auth token" }],
    [429, { error: "rate_limited", message: "Slow down" }],
    [404, { error: { message: "No endpoints found for mimo/mimo-v2.5", code: 404 } }],
  ])("passes a %i chat error through untouched", async (status, payload) => {
    installUpstream({ chat: () => json(payload, { status }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(payload);
    await vi.waitFor(() => expect(agentRunCalls("FINISH")).toHaveLength(1));
    expect(agentRunCalls("FINISH")[0].body.status).toBe("failed");
  });

  it("surfaces Codebuff's machine-readable code through parseError", () => {
    const parsed = executor.parseError({ status: 403 }, JSON.stringify({ error: "free_mode_cli_required", message: "Use the CLI" }));
    expect(parsed).toEqual({ status: 403, message: "free_mode_cli_required: Use the CLI" });
    expect(executor.parseError({ status: 404 }, JSON.stringify({ error: { message: "No endpoints found", code: 404 } }))).toEqual({
      status: 404,
      message: "404: No endpoints found",
    });
    expect(executor.parseError({ status: 502 }, "<html>bad gateway</html>")).toEqual({ status: 502, message: "<html>bad gateway</html>" });
    expect(executor.parseError({ status: 500 }, "")).toEqual({ status: 500, message: "HTTP 500" });
  });

  it("keeps an admission refusal's status and code without calling chat", async () => {
    installUpstream({ admission: () => json({ error: "country_blocked", message: "Not available in your country" }, { status: 403 }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("country_blocked");
    expect(body.error.message).toContain("Not available in your country");
    expect(callsTo(CHAT_URL)).toHaveLength(0);
    expect(agentRunCalls("START")).toHaveLength(0);
  });

  it("turns a refusal delivered in a 2xx body into a real HTTP status", async () => {
    installUpstream({ admission: () => json({ status: "country_blocked" }) });
    const blocked = await executor.execute(makeExecuteArgs());
    expect(blocked.response.status).toBe(403);
    expect((await blocked.response.json()).error.code).toBe("country_blocked");

    clearSessionCache();
    installUpstream({ admission: () => json({ status: "rate_limited", retryAfterMs: 42_000 }) });
    const limited = await executor.execute(makeExecuteArgs());
    expect(limited.response.status).toBe(429);
    expect(limited.response.headers.get("retry-after")).toBe("42");
  });

  it("passes a 401 from admission straight through", async () => {
    installUpstream({ admission: () => json({ error: "unauthorized", message: "Invalid auth token" }, { status: 401 }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
  });

  it("gives a 429 from admission a Retry-After even when upstream sent none", async () => {
    installUpstream({ admission: () => json({ error: "rate_limited", message: "Too many" }, { status: 429 }) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("passes a START refusal through and never chats", async () => {
    installUpstream({
      start: () => json({ error: "free_mode_invalid_agent_hierarchy", message: "Invalid agent hierarchy" }, { status: 403 }),
    });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("free_mode_invalid_agent_hierarchy");
    expect(callsTo(CHAT_URL)).toHaveLength(0);
  });

  it("rejects a START answer without a run id", async () => {
    installUpstream({ start: () => json({}) });
    const { response } = await executor.execute(makeExecuteArgs());
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("agent_run_start_failed");
  });

  it("answers a clean 400 for a model without a known agent id, without any upstream call", async () => {
    installUpstream();
    const { response } = await executor.execute(makeExecuteArgs({ model: "some/unheard-of-model" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_supported");
    expect(body.error.message).toContain("some/unheard-of-model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips a thinking suffix such as (high) from the model", async () => {
    installUpstream();
    const { response } = await executor.execute(makeExecuteArgs({ model: "z-ai/glm-5.3-flash(high)" }));
    expect(response.status).toBe(200);
    await drain(response);
    expect(callsTo(SESSION_ADMISSION_URL)[0].headers["x-freebuff-model"]).toBe("z-ai/glm-5.3-flash");
    expect(agentRunCalls("START")[0].body.agentId).toBe("base3-free-glm-5-3-flash");
    expect(callsTo(CHAT_URL)[0].body.model).toBe("z-ai/glm-5.3-flash");
  });

  it("strips a provider prefix from the model before resolving the agent", async () => {
    installUpstream();
    const { response } = await executor.execute(makeExecuteArgs({ model: "cb/z-ai/glm-5.3-flash" }));
    expect(response.status).toBe(200);
    await drain(response);
    expect(agentRunCalls("START")[0].body.agentId).toBe("base3-free-glm-5-3-flash");
  });

  it("answers 401 without any upstream call when there is no token", async () => {
    installUpstream();
    const { response } = await executor.execute(makeExecuteArgs({ credentials: {} }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.type).toBe("authentication_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dashboard token probe
// ---------------------------------------------------------------------------

describe("probeFreebuffToken", () => {
  it("accepts a token the session endpoint answers to", async () => {
    fetchMock.mockResolvedValue(json({ status: "none" }));
    const result = await probeFreebuffToken("tok");
    expect(result).toMatchObject({ valid: true, error: null });
    const [call] = allCalls();
    expect(call.url).toBe(SESSION_URL);
    expect(call.method).toBe("GET");
    expect(call.headers.Authorization).toBe("Bearer tok");
    // the probe must not open a free session
    expect(callsTo(SESSION_ADMISSION_URL)).toHaveLength(0);
  });

  it("rejects an invalid token on 401", async () => {
    fetchMock.mockResolvedValue(json({ error: "unauthorized" }, { status: 401 }));
    expect(await probeFreebuffToken("bad")).toMatchObject({ valid: false, status: 401, error: "Token invalid or revoked" });
  });

  it("keeps the token valid but warns on country_blocked", async () => {
    fetchMock.mockResolvedValue(json({ status: "country_blocked" }, { status: 403 }));
    const result = await probeFreebuffToken("tok");
    expect(result.valid).toBe(true);
    expect(result.warning).toContain("country_blocked");
  });

  it("reports transport failures and missing tokens", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    expect(await probeFreebuffToken("tok")).toMatchObject({ valid: false, error: "ECONNRESET" });
    expect(await probeFreebuffToken("")).toMatchObject({ valid: false, error: "No token" });
  });

  it("goes out directly even when the connection uses a relay pool", async () => {
    fetchMock.mockResolvedValue(json({ status: "none" }));
    await probeFreebuffToken("tok", { vercelRelayUrl: "https://relay.example/x", connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:3128" });
    const [call] = allCalls();
    expect(call.opts.vercelRelayUrl).toBeUndefined();
    expect(call.opts.connectionProxyUrl).toBe("http://127.0.0.1:3128");
  });
});

// ---------------------------------------------------------------------------
// OAuth (device-code) provider
// ---------------------------------------------------------------------------

describe("freebuff oauth provider", () => {
  let freebuffOAuth;

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn());
    ({ default: freebuffOAuth } = await import("../../src/lib/oauth/providers/freebuff.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a device_code flow wired to the codebuff cli auth endpoints", () => {
    expect(freebuffOAuth.flowType).toBe("device_code");
    expect(freebuffOAuth.config.deviceCodeUrl).toBe("https://www.codebuff.com/api/auth/cli/code");
    expect(freebuffOAuth.config.tokenUrl).toBe("https://www.codebuff.com/api/auth/cli/status");
  });

  it("requests a login code and packs everything the status endpoint needs into device_code", async () => {
    fetch.mockResolvedValueOnce(
      json({
        loginUrl: "https://www.codebuff.com/login?auth_code=abc.123.def",
        fingerprintHash: "hash-1",
        expiresAt: "1790000000000",
        expiresInMs: 3_600_000,
      }),
    );
    const data = await freebuffOAuth.requestDeviceCode(freebuffOAuth.config);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://www.codebuff.com/api/auth/cli/code");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body);
    expect(sent.fingerprintId).toMatch(/^codebuff-cli-[A-Za-z0-9_-]{8}$/);

    expect(data.verification_uri).toBe("https://www.codebuff.com/login?auth_code=abc.123.def");
    expect(data.verification_uri_complete).toBe(data.verification_uri);
    expect(data.expires_in).toBe(3600);
    expect(data.interval).toBe(5);
    expect(data.user_code).toBe(sent.fingerprintId.replace("codebuff-cli-", ""));
    expect(JSON.parse(data.device_code)).toEqual({
      fingerprintId: sent.fingerprintId,
      fingerprintHash: "hash-1",
      expiresAt: "1790000000000",
    });
  });

  it("reports a failed code request with the status", async () => {
    fetch.mockResolvedValueOnce(json("nope", { status: 500 }));
    await expect(freebuffOAuth.requestDeviceCode(freebuffOAuth.config)).rejects.toThrow(/500/);
  });

  it("rejects an incomplete code response", async () => {
    fetch.mockResolvedValueOnce(json({ loginUrl: "https://x" }));
    await expect(freebuffOAuth.requestDeviceCode(freebuffOAuth.config)).rejects.toThrow(/missing/);
  });

  const deviceCode = JSON.stringify({ fingerprintId: "codebuff-cli-abcd1234", fingerprintHash: "hash-1", expiresAt: "1790000000000" });

  it("echoes fingerprintId, fingerprintHash and expiresAt back when polling", async () => {
    fetch.mockResolvedValueOnce(json({ error: "pending" }, { status: 401 }));
    await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode);
    const [url, init] = fetch.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.codebuff.com/api/auth/cli/status");
    expect(parsed.searchParams.get("fingerprintId")).toBe("codebuff-cli-abcd1234");
    expect(parsed.searchParams.get("fingerprintHash")).toBe("hash-1");
    expect(parsed.searchParams.get("expiresAt")).toBe("1790000000000");
    expect(init.method).toBe("GET");
  });

  it("treats 401 and an empty answer as pending", async () => {
    fetch.mockResolvedValueOnce(json({}, { status: 401 })).mockResolvedValueOnce(json({}));
    expect(await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode)).toEqual({ ok: false, data: { error: "authorization_pending" } });
    expect(await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode)).toEqual({ ok: false, data: { error: "authorization_pending" } });
  });

  it("reports other statuses as a poll failure", async () => {
    fetch.mockResolvedValueOnce(json("boom", { status: 500 }));
    const result = await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode);
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("poll_failed");
  });

  it("returns the auth token once the user approved the login", async () => {
    fetch.mockResolvedValueOnce(
      json({ user: { id: "u1", name: "Ada", email: "ada@example.test", authToken: "auth-token-xyz", fingerprintId: "codebuff-cli-abcd1234", fingerprintHash: "hash-1" } }),
    );
    const result = await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode);
    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("auth-token-xyz");

    expect(freebuffOAuth.mapTokens(result.data)).toEqual({
      accessToken: "auth-token-xyz",
      refreshToken: null,
      expiresIn: null,
      email: "ada@example.test",
      displayName: "Ada",
      name: "Ada",
      providerSpecificData: { userId: "u1", fingerprintId: "codebuff-cli-abcd1234", fingerprintHash: "hash-1" },
    });
  });

  it("still understands the older answer shapes", async () => {
    fetch.mockResolvedValueOnce(json({ default: { authToken: "legacy-token" } })).mockResolvedValueOnce(json({ authToken: "bare-token" }));
    expect((await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode)).data.access_token).toBe("legacy-token");
    expect((await freebuffOAuth.pollToken(freebuffOAuth.config, deviceCode)).data.access_token).toBe("bare-token");
  });

  it("accepts a bare fingerprint id as device code", async () => {
    fetch.mockResolvedValueOnce(json({}, { status: 401 }));
    await freebuffOAuth.pollToken(freebuffOAuth.config, "codebuff-cli-abcd1234");
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get("fingerprintId")).toBe("codebuff-cli-abcd1234");
  });

  it("falls back to a placeholder display name without profile data", () => {
    expect(freebuffOAuth.mapTokens({ access_token: "t" })).toMatchObject({ accessToken: "t", email: null, displayName: "Freebuff User" });
  });
});
