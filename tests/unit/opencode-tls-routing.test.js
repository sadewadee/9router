import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// proxyAwareFetch gives a caller-supplied transport (options.directFetch) first
// refusal on direct and plain-proxy egress, and never on relay pools: a relay opens
// its own TLS connection, so no ClientHello of ours can reach the upstream.
const URL_FREE = "https://opencode.ai/inference/openai/v1/chat/completions";
const PROXY = "http://proxy-user:proxy-pw@proxy.example:8080";

let nativeFetch;
let proxyAwareFetch;
let custom;

const ok = (tag) => new Response(tag, { status: 200 });

beforeEach(async () => {
  vi.resetModules();
  nativeFetch = vi.fn(async () => ok("native"));
  vi.stubGlobal("fetch", nativeFetch);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  custom = vi.fn(async () => ok("custom"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const init = () => ({ method: "POST", headers: { "x-test": "1" }, body: "{}" });

describe("proxyAwareFetch custom transport", () => {
  it("routes direct egress through it, with no proxy", async () => {
    const res = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, null);
    expect(await res.text()).toBe("custom");
    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledWith(URL_FREE, init(), { proxyUrl: null });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("routes connection-proxy egress through it with the proxy to tunnel through", async () => {
    const res = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
    });
    expect(await res.text()).toBe("custom");
    expect(custom).toHaveBeenCalledWith(URL_FREE, init(), { proxyUrl: PROXY });
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("falls through to the native path when the transport declines (null)", async () => {
    custom.mockResolvedValue(null);
    const direct = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, null);
    expect(await direct.text()).toBe("native");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBeUndefined();

    nativeFetch.mockClear();
    const proxied = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
    });
    expect(await proxied.text()).toBe("native");
    expect(nativeFetch.mock.calls[0][1].dispatcher).toBeDefined();
  });

  it("never leaks the hook into the native fetch options", async () => {
    custom.mockResolvedValue(null);
    await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, null);
    expect(nativeFetch.mock.calls[0][1]).not.toHaveProperty("directFetch");
  });

  it("falls back to a direct custom request when the proxied one fails (non-strict)", async () => {
    custom.mockRejectedValueOnce(new Error("proxy connect error")).mockResolvedValueOnce(ok("direct-custom"));
    const res = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
    });
    expect(await res.text()).toBe("direct-custom");
    expect(custom.mock.calls.map((call) => call[2].proxyUrl)).toEqual([PROXY, null]);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("honours strictProxy: a failed proxied request is not replayed direct", async () => {
    custom.mockRejectedValue(new Error("proxy connect error"));
    await expect(proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: PROXY,
      strictProxy: true,
    })).rejects.toThrow(/strictProxy=true/);
    expect(custom).toHaveBeenCalledTimes(1);
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("never offers relay pools to it: the relay makes its own TLS connection", async () => {
    const relay = "https://cloudflare-relay.example.workers.dev";
    const res = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, { vercelRelayUrl: relay });
    expect(await res.text()).toBe("native");
    expect(custom).not.toHaveBeenCalled();
    const [target, options] = nativeFetch.mock.calls[0];
    expect(target).toBe(relay);
    expect(options.headers["x-relay-target"]).toBe("https://opencode.ai");
    expect(options.headers["x-relay-path"]).toBe("/inference/openai/v1/chat/completions");
    expect(options).not.toHaveProperty("directFetch");
  });

  it("is a no-op for callers that pass no transport", async () => {
    const res = await proxyAwareFetch(URL_FREE, init(), null);
    expect(await res.text()).toBe("native");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  });

  it("skips it for hosts pinned by UPSTREAM_HOST_OVERRIDES (pinning is native-only)", async () => {
    vi.stubEnv("UPSTREAM_HOST_OVERRIDES", "opencode.ai=203.0.113.9");
    vi.resetModules();
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    const res = await proxyAwareFetch(URL_FREE, { ...init(), directFetch: custom }, null);
    expect(custom).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    vi.unstubAllEnvs();
  });
});
