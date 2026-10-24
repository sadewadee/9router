import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";

const MODEL = "muse-spark-1.3-contributor-free";

function makeSseResponse(status) {
  const body = status === 200
    ? 'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
    : JSON.stringify({ type: "error", error: { type: "error", message: "internal server error" } });
  return new Response(body, {
    status,
    headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
  });
}

function makeBody() {
  return {
    model: MODEL,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    max_tokens: 500,
    stream: true,
    store: false,
  };
}

function upstreamHeaders(call) {
  const options = fetchMock.mock.calls[call][1];
  return options.headers;
}

function upstreamSession(call) {
  return upstreamHeaders(call)["x-opencode-session"];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("OpenCode repeat-request self-heal (session rotation)", () => {
  it("a repeated (session, message) after upstream 500 rotates away from the failed session", async () => {
    const executor = getExecutor("opencode");

    // Request #1 fails upstream with 500 (router-level retries included).
    fetchMock.mockResolvedValue(makeSseResponse(500));
    await executor.execute({
      model: MODEL,
      body: makeBody(),
      stream: true,
      credentials: { connectionId: "conn_x", rawHeaders: {} },
      providerSessionId: "conversation-abc",
      clientTool: "claude",
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const ses1 = upstreamSession(0);
    expect(ses1).toMatch(/^ses_/);

    // Request #2: SAME conversation, SAME message text (a user retry after the
    // failure). It must rotate away from the failed session.
    await executor.execute({
      model: MODEL,
      body: makeBody(),
      stream: true,
      credentials: { connectionId: "conn_x", rawHeaders: {} },
      providerSessionId: "conversation-abc",
      clientTool: "claude",
    });

    const ses2 = upstreamSession(fetchMock.mock.calls.length - 2);
    expect(ses2).not.toBe(ses1);
    // each failed execute burns the executor's two 2.5s 500-retries, so allow for real timers
  }, 30000);

  it("two different conversations with the same text still get distinct sessions", async () => {
    fetchMock.mockResolvedValue(makeSseResponse(200));
    await executorSafeRun("conversation-aaa");
    await executorSafeRun("conversation-bbb");
    const a = upstreamSession(fetchMock.mock.calls.length - 2);
    const b = upstreamSession(fetchMock.mock.calls.length - 1);
    expect(a).toMatch(/^ses_/);
    expect(b).toMatch(/^ses_/);
    expect(a).not.toBe(b);
  });
});

async function executorSafeRun(seed) {
  const executor = getExecutor("opencode");
  await executor.execute({
    model: MODEL,
    body: makeBody(),
    stream: true,
    credentials: { connectionId: "conn_y", rawHeaders: {} },
    providerSessionId: seed,
    clientTool: "claude",
  });
}
