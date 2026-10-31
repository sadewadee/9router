import { describe, expect, it, vi } from "vitest";

// nonStreamingHandler.js pulls in `needsTranslation` from open-sse/translator/index.js,
// whose circular register()/import graph does not survive this vitest/Vite runtime
// (pre-existing, unrelated to the credentials bug — see report). Mocking it here keeps
// this file testing the real handler code under test while sidestepping that separately
// broken dependency; targetFormat === sourceFormat in every case below so the real
// needsTranslation would have returned false anyway.
vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));
vi.mock("../../open-sse/translator/index.js", () => ({
  needsTranslation: () => false,
  register: () => {},
  translateRequest: (a) => a,
  translateResponse: (t, s, chunk) => chunk,
  initState: () => ({}),
  initTranslators: () => {}
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

// Regression coverage for the 20260922 production 500: `handleNonStreamingResponse`
// read `credentials?._opencodeToolNameMap` without `credentials` being declared in its
// own destructured signature. Optional chaining does not guard an undeclared identifier
// — it throws `ReferenceError: credentials is not defined` AFTER the upstream provider
// already answered successfully, on every non-streaming request. See
// ~/build-9router-hotfix/baseline-worktree-20260922.diff and opencode-quartet-20260918.patch.

function claudeToolUseResponse(toolName) {
  return {
    id: "msg_test123",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "tool_use", id: "toolu_1", name: toolName, input: {} }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 }
  };
}

function baseArgs(overrides = {}) {
  const body = claudeToolUseResponse(overrides.toolName ?? "bash");
  return {
    providerResponse: new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    provider: "opencode",
    model: "muse-spark-1.3-contributor-free",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.CLAUDE,
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    apiKey: "test-key",
    clientRawRequest: { endpoint: "/v1/messages" },
    onRequestSuccess: null,
    reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn() },
    toolNameMap: null,
    customToolNames: null,
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    pxpipe: null,
    reqTag: "test",
    log: null,
    ...overrides
  };
}

describe("handleNonStreamingResponse — credentials crash regression (20260922)", () => {
  it("does not throw when chatCore's sharedCtx spread includes credentials (real call shape)", async () => {
    // Mirrors chatCore.js: `{ ...sharedCtx, providerResponse, sourceFormat, ... }` where
    // sharedCtx = { credentials, provider, model, body, stream, ... }.
    const credentials = { _opencodeToolNameMap: new Map([["bash", "Bash"]]) };
    const sharedCtx = { credentials, provider: "opencode", model: "m", body: {}, stream: false };
    const args = { ...sharedCtx, ...baseArgs({ toolName: "bash" }) };
    await expect(handleNonStreamingResponse(args)).resolves.toMatchObject({ success: true });
  });

  it("does not throw when credentials is entirely omitted from the call", async () => {
    const args = baseArgs({ toolName: "bash" }); // no `credentials` key at all
    await expect(handleNonStreamingResponse(args)).resolves.toMatchObject({ success: true });
  });

  it("does not throw when credentials is explicitly null", async () => {
    const args = baseArgs({ toolName: "bash", credentials: null });
    await expect(handleNonStreamingResponse(args)).resolves.toMatchObject({ success: true });
  });

  it("decloaks an opencode-cloaked lowercase tool name (bash) back to the caller's original (Bash)", async () => {
    const credentials = { _opencodeToolNameMap: new Map([["bash", "Bash"]]) };
    const args = baseArgs({ toolName: "bash", credentials });
    const result = await handleNonStreamingResponse(args);
    const json = await result.response.json();
    expect(json.content[0].type).toBe("tool_use");
    expect(json.content[0].name).toBe("Bash");
  });

  it("merges credentials._opencodeToolNameMap with an explicit toolNameMap (both applied)", async () => {
    const credentials = { _opencodeToolNameMap: new Map([["bash", "Bash"]]) };
    const toolNameMap = new Map([["grep_cc", "Grep"]]);
    const body = {
      id: "msg_test456",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
        { type: "tool_use", id: "toolu_2", name: "grep_cc", input: {} }
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    const args = baseArgs({ credentials, toolNameMap });
    args.providerResponse = new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const result = await handleNonStreamingResponse(args);
    const json = await result.response.json();
    expect(json.content[0].name).toBe("Bash");
    expect(json.content[1].name).toBe("Grep");
  });

  it("leaves tool names untouched when credentials carries no _opencodeToolNameMap", async () => {
    const args = baseArgs({ toolName: "bash", credentials: { connectionName: "acct-1" } });
    const result = await handleNonStreamingResponse(args);
    const json = await result.response.json();
    expect(json.content[0].name).toBe("bash"); // no map entry for "bash" -> left as-is
  });
});

// Case E from the production 500 repro (container ghcr.mcpke.dev/9router-hotfix:20260921a,
// 192.168.208.3:20128, 2026-09-22): a plain `ds/deepseek-v4-flash` chat-completions call
// with `"stream": false` EXPLICIT in the request body. Log line observed:
//   POST ds/deepseek-v4-flash -> deepseek/deepseek-v4-flash · FMT: openai->openai · JSON · 1 MSG · ACC:NAMED
//   ReferenceError: credentials is not defined
// Confirmed on the live container: an OMITTED `stream` field or `"stream": true` takes the
// forced-stream path (log "STREAM") and returns 200 — only explicit `stream:false` routes
// through chatCore's `if (!stream)` branch into handleNonStreamingResponse and crashes.
// No tools, no opencode provider, no _opencodeToolNameMap involved: this proves the crash
// is universal to the non-stream path, not specific to the opencode-quartet tool cloak.
describe("handleNonStreamingResponse — production repro (case E: ds/deepseek-v4-flash, stream:false)", () => {
  it("does not throw on a plain OpenAI-format non-streaming reply with ordinary (non-opencode) credentials", async () => {
    const openaiBody = {
      id: "chatcmpl-test789",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "hello from deepseek" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
    };
    const credentials = { connectionName: "deepseek-acct-1", accessToken: "tok_test" }; // no _opencodeToolNameMap
    const args = {
      providerResponse: new Response(JSON.stringify(openaiBody), { headers: { "content-type": "application/json" } }),
      provider: "deepseek",
      model: "deepseek/deepseek-v4-flash",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      // The literal client request body carries "stream": false, exactly as in the case E repro.
      body: { model: "ds/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false, // chatCore.js's `if (!stream)` gate — this is what routes into this handler
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      apiKey: "test-key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: null,
      reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn() },
      toolNameMap: null,
      customToolNames: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      pxpipe: null,
      reqTag: "test",
      log: null,
      credentials
    };
    const result = await handleNonStreamingResponse(args);
    expect(result.success).toBe(true);
    expect(result.response.status).toBe(200);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("hello from deepseek");
  });
});

describe("handleForcedSSEToJson — credentials crash regression (20260922)", () => {
  function sseArgs(overrides = {}) {
    const raw = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      ""
    ].join("\n\n");
    const encoder = new TextEncoder();
    return {
      providerResponse: new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(raw));
          controller.close();
        }
      }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", messages: [] },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "test-connection",
      apiKey: "test-key",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      onRequestSuccess: null,
      customToolNames: null,
      trackDone: vi.fn(),
      appendLog: vi.fn(),
      reqTag: "test",
      log: null,
      ...overrides
    };
  }

  it("does not throw when chatCore's sharedCtx spread includes credentials (real call shape)", async () => {
    const credentials = { _opencodeToolNameMap: new Map([["bash", "Bash"]]) };
    const sharedCtx = { credentials, provider: "opencode", model: "m", body: {}, stream: false };
    const args = { ...sharedCtx, ...sseArgs() };
    const result = await handleForcedSSEToJson(args);
    expect(result.success).toBe(true);
  });

  it("does not throw when credentials is entirely omitted from the call", async () => {
    const result = await handleForcedSSEToJson(sseArgs());
    expect(result.success).toBe(true);
  });

  // KNOWN GAP (out of scope for this fix, flagged in report): unlike
  // handleNonStreamingResponse, handleForcedSSEToJson accepts `credentials` but never
  // reads `credentials?._opencodeToolNameMap` anywhere in this file — tool names cloaked
  // by the opencode-quartet patch are not decloaked back to the caller on this path.
});
