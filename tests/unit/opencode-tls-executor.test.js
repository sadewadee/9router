import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

const args = (overrides = {}) => ({
  model: "big-pickle",
  body: { model: "big-pickle", messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials: { connectionId: "noauth", rawHeaders: {} },
  ...overrides,
});

// Fresh module graph per test: the relay warning is once per process.
async function load() {
  vi.resetModules();
  const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
  const { opencodeTlsFetch } = await import("../../open-sse/services/opencodeTlsClient.js");
  return { executor: new OpenCodeExecutor(), opencodeTlsFetch };
}

const relayWarnings = () => console.warn.mock.calls.filter(([msg]) => String(msg).includes("bypasses TLS"));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenCodeExecutor transport", () => {
  it("hands proxyAwareFetch the TLS-impersonating transport for the free lane", async () => {
    const { executor, opencodeTlsFetch } = await load();
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.example:8080" };
    await executor.execute(args({ proxyOptions }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options, passedProxy] = fetchMock.mock.calls[0];
    expect(url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(options.directFetch).toBe(opencodeTlsFetch);
    expect(passedProxy).toBe(proxyOptions);
  });

  it("keeps the keyed opencode-go lane on native fetch", async () => {
    vi.resetModules();
    const { OpenCodeGoExecutor } = await import("../../open-sse/executors/opencode-go.js");
    await new OpenCodeGoExecutor().execute({
      model: "glm-5.3",
      body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "key", connectionId: "c1", rawHeaders: {} },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("directFetch");
  });

  it("warns once that a relay pool bypasses the TLS client, and still sends through it", async () => {
    const { executor } = await load();
    const relay = { vercelRelayUrl: "https://relay.example.workers.dev" };
    await executor.execute(args({ proxyOptions: relay }));
    await executor.execute(args({ proxyOptions: relay }));
    expect(relayWarnings()).toHaveLength(1);
    expect(fetchMock.mock.calls[0][2]).toBe(relay);
  });

  it("does not warn for plain proxies or direct egress", async () => {
    const { executor } = await load();
    await executor.execute(args({ proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "http://p.example:8080" } }));
    await executor.execute(args());
    expect(relayWarnings()).toHaveLength(0);
  });

  it("does not warn about a relay when the kill switch already routes natively", async () => {
    vi.stubEnv("OPENCODE_TLS_IMPERSONATE", "0");
    const { executor } = await load();
    await executor.execute(args({ proxyOptions: { vercelRelayUrl: "https://relay.example.workers.dev" } }));
    expect(relayWarnings()).toHaveLength(0);
  });
});
