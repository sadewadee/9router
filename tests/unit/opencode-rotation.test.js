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

function upstreamRequestId(call) {
  return upstreamHeaders(call)["x-opencode-request"];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("OpenCode repeat-request self-heal (session rotation + request-id freshness)", () => {
  it("a repeated (session, message) after upstream 500 gets a fresh request id, not the cached one", async () => {
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
    const id1 = upstreamRequestId(0);
    const ses1 = upstreamSession(0);
    expect(id1).toMatch(/^msg_/);
    expect(ses1).toMatch(/^ses_/);

    // Request #2: SAME conversation, SAME message text (a user retry after the
    // failure). It must NOT reuse the failed request id and must rotate away
    // from the failed session.
    await executor.execute({
      model: MODEL,
      body: makeBody(),
      stream: true,
      credentials: { connectionId: "conn_x", rawHeaders: {} },
      providerSessionId: "conversation-abc",
      clientTool: "claude",
    });

    const id2 = upstreamRequestId(fetchMock.mock.calls.length - 2);
    const ses2 = upstreamSession(fetchMock.mock.calls.length - 2);
    expect(id2).not.toBe(id1);
    expect(ses2).not.toBe(ses1);
  });

  it("two different conversations with the same text still get distinct request ids", async () => {
    fetchMock.mockResolvedValue(makeSseResponse(200));
    await executorSafeRun("conversation-aaa");
    await executorSafeRun("conversation-bbb");
    const a = upstreamRequestId(fetchMock.mock.calls.length - 2);
    const b = upstreamRequestId(fetchMock.mock.calls.length - 1);
    expect(a).toMatch(/^msg_/);
    expect(b).toMatch(/^msg_/);
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
