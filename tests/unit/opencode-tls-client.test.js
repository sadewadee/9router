import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The free gate keys on the TLS ClientHello: on one process and egress IP the same
// body/headers answered 429 over Node's OpenSSL fingerprint and 200 over the cipher
// list below (decolua/9router ce060c79; here also verified against opencode.ai from
// hachibi, direct and through the Webshare pool). These tests pin the wiring, not
// the upstream.
const { createTransportMock, wreqFetchMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  wreqFetchMock: vi.fn(),
}));

const URL_FREE = "https://opencode.ai/inference/openai/v1/chat/completions";

let client;
let loader;
let transportCount;

// Shape of a wreq-js Response: web ReadableStream body, forEach(value, key) headers.
function wreqResponse(chunks = ["data: ok\n\n"], headers = { "content-type": "text/event-stream" }) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    status: 200,
    statusText: "OK",
    headers: new Map(Object.entries(headers)),
    body: new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        else controller.close();
      },
    }),
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  delete process.env.OPENCODE_TLS_IMPERSONATE;
  transportCount = 0;
  createTransportMock.mockReset().mockImplementation(async (options) => ({ id: `t${++transportCount}`, options, close: vi.fn() }));
  wreqFetchMock.mockReset().mockImplementation(async () => wreqResponse());
  loader = vi.fn(async () => ({ createTransport: createTransportMock, fetch: wreqFetchMock }));
  client = await import("../../open-sse/services/opencodeTlsClient.js");
  client.__test__.setWreqLoader(loader);
});

afterEach(() => {
  delete process.env.OPENCODE_TLS_IMPERSONATE;
  vi.restoreAllMocks();
});

describe("opencodeTlsFetch", () => {
  it("builds the transport with the cipher list the upstream accepts", async () => {
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    const options = createTransportMock.mock.calls[0][0];
    expect(options.emulation.tlsOptions.cipherList).toBe(client.__test__.OPENCODE_CIPHER_LIST);
    expect(options.proxy).toBeUndefined();
    // BoringSSL family list: AES-128-GCM first plus the legacy CBC entries the upstream
    // fingerprints on. JA4 cipher hash 5b57614c22b0 (Bun); dropping any entry is refused.
    const ciphers = client.__test__.OPENCODE_CIPHER_LIST.split(":");
    expect(ciphers).toHaveLength(17);
    expect(ciphers[0]).toBe("TLS_AES_128_GCM_SHA256");
    expect(ciphers).toContain("AES256-SHA");

    expect(wreqFetchMock).toHaveBeenCalledWith(URL_FREE, expect.objectContaining({
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
      transport: expect.objectContaining({ id: "t1" }),
    }));
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toBe("data: ok\n\n");
  });

  it("gives wreq a total deadline far beyond a long stream", async () => {
    await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" });
    // wreq's default is 30s and the deadline is total (it cuts a live SSE stream).
    expect(wreqFetchMock.mock.calls[0][1].timeout).toBe(client.__test__.REQUEST_TIMEOUT_MS);
    expect(client.__test__.REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it("reuses one transport per egress and keeps proxies apart", async () => {
    await client.opencodeTlsFetch(URL_FREE, {}, {});
    await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: null });
    expect(createTransportMock).toHaveBeenCalledTimes(1);

    await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: "http://user:pw@proxy-a.example:8080" });
    await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: "http://user:pw@proxy-a.example:8080" });
    await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: "socks5://proxy-b.example:1080" });
    expect(createTransportMock).toHaveBeenCalledTimes(3);
    expect(createTransportMock.mock.calls[1][0].proxy).toBe("http://user:pw@proxy-a.example:8080");
    expect(createTransportMock.mock.calls[2][0].proxy).toBe("socks5://proxy-b.example:1080");
    // the proxied transports keep the same ClientHello
    for (const [options] of createTransportMock.mock.calls) {
      expect(options.emulation.tlsOptions.cipherList).toBe(client.__test__.OPENCODE_CIPHER_LIST);
    }
  });

  it("drops encoding and length headers wreq already decoded", async () => {
    wreqFetchMock.mockResolvedValueOnce(wreqResponse(["{}"], {
      "content-type": "application/json", "content-encoding": "zstd", "content-length": "99", "x-request-id": "r1",
    }));
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" });
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(result.headers.get("content-length")).toBeNull();
    expect(result.headers.get("x-request-id")).toBe("r1");
  });

  it("hands over the live stream without buffering it", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const encoder = new TextEncoder();
    wreqFetchMock.mockResolvedValueOnce({
      status: 200, statusText: "OK", headers: new Map(),
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          await gate;
          controller.enqueue(encoder.encode("data: second\n\n"));
          controller.close();
        },
      }),
    });
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" });
    const reader = result.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
    expect((await reader.read()).done).toBe(true);
  });

  it("does not hand a body to null-body statuses", async () => {
    wreqFetchMock.mockResolvedValueOnce({ status: 204, statusText: "No Content", headers: new Map(), body: new ReadableStream() });
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" }, { signal: new AbortController().signal });
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
  });
});

describe("opencodeTlsFetch declines instead of failing", () => {
  it("resolves null when OPENCODE_TLS_IMPERSONATE switches it off", async () => {
    for (const value of ["0", "false", "off", "no", " FALSE "]) {
      process.env.OPENCODE_TLS_IMPERSONATE = value;
      expect(await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" })).toBeNull();
    }
    expect(loader).not.toHaveBeenCalled();
    expect(wreqFetchMock).not.toHaveBeenCalled();
    for (const value of ["1", "true", ""]) {
      process.env.OPENCODE_TLS_IMPERSONATE = value;
      expect(client.isOpencodeTlsEnabled()).toBe(true);
    }
  });

  it("resolves null once, with one warning, when wreq-js is not installed", async () => {
    const missing = Object.assign(new Error("Cannot find package 'wreq-js'"), { code: "ERR_MODULE_NOT_FOUND" });
    loader.mockRejectedValue(missing);

    expect(await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" })).toBeNull();
    expect(await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" })).toBeNull();

    expect(loader).toHaveBeenCalledTimes(1);
    const warnings = console.warn.mock.calls.filter(([msg]) => String(msg).includes("wreq-js unavailable"));
    expect(warnings).toHaveLength(1);
  });

  it("resolves null for proxy schemes wreq-js cannot tunnel", async () => {
    expect(await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: "ftp://proxy.example:21" })).toBeNull();
    expect(await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl: "not a url" })).toBeNull();
    expect(wreqFetchMock).not.toHaveBeenCalled();
    for (const proxyUrl of ["http://p.example:1", "https://p.example:1", "socks5://p.example:1", "socks5h://p.example:1"]) {
      expect(await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl })).toBeInstanceOf(Response);
    }
  });
});

describe("opencodeTlsFetch errors and aborts", () => {
  it("lets request errors through so proxyAwareFetch can apply strictProxy or fall back", async () => {
    wreqFetchMock.mockRejectedValueOnce(new Error("request or response body error: operation timed out"));
    await expect(client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" })).rejects.toThrow("operation timed out");
  });

  it("scrubs proxy credentials from errors", async () => {
    const proxyUrl = "http://webuser-rotate:s3cretpw@p.webshare.example:80/";
    wreqFetchMock.mockRejectedValueOnce(new Error(`proxy connect error via ${proxyUrl}: 407 (user webuser-rotate, pass s3cretpw)`));
    const error = await client.opencodeTlsFetch(URL_FREE, {}, { proxyUrl }).catch((e) => e);
    expect(error.message).toContain("407");
    expect(error.message).not.toContain("s3cretpw");
    expect(error.message).not.toContain("webuser-rotate");
  });

  it("forwards the abort signal to the request", async () => {
    const controller = new AbortController();
    await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}", signal: controller.signal });
    expect(wreqFetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  // wreq only honours the signal until the response headers arrive, and (3.2.0) cannot
  // close a connection mid-response: cancelling its body leaves the socket ESTABLISHED
  // with the upstream blocked on backpressure for the whole request timeout. So the
  // bridge errors the consumer's stream like native fetch would, then drains the rest.
  function slowBody(chunks) {
    const state = { produced: 0, cancel: vi.fn() };
    const encoder = new TextEncoder();
    state.body = new ReadableStream({
      pull(controller) {
        if (state.produced < chunks) controller.enqueue(encoder.encode(`data: ${state.produced++}\n\n`));
        else controller.close();
      },
      cancel: state.cancel,
    });
    return state;
  }

  it("errors the consumer with AbortError when the signal aborts after the headers arrived", async () => {
    const upstream = slowBody(6);
    wreqFetchMock.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: new Map(), body: upstream.body });
    const controller = new AbortController();
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}", signal: controller.signal });
    const reader = result.body.getReader();
    expect((await reader.read()).done).toBe(false);

    controller.abort();
    await expect(reader.read()).rejects.toSatisfy((error) => error.name === "AbortError");
  });

  it("keeps draining the upstream after an abort so the connection is released, never cancelling it", async () => {
    const upstream = slowBody(6);
    wreqFetchMock.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: new Map(), body: upstream.body });
    const controller = new AbortController();
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}", signal: controller.signal });
    const reader = result.body.getReader();
    await reader.read();

    controller.abort();
    await reader.read().catch(() => {});
    await vi.waitFor(() => expect(upstream.produced).toBe(6));
    expect(upstream.cancel).not.toHaveBeenCalled();
  });

  it("drains rather than cancels when the consumer cancels", async () => {
    const upstream = slowBody(6);
    wreqFetchMock.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: new Map(), body: upstream.body });
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}", signal: new AbortController().signal });
    const reader = result.body.getReader();
    await reader.read();

    await reader.cancel("client gone");
    await vi.waitFor(() => expect(upstream.produced).toBe(6));
    expect(upstream.cancel).not.toHaveBeenCalled();
  });

  it("does not drain or error a stream that ends normally before any abort", async () => {
    const upstream = slowBody(2);
    wreqFetchMock.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: new Map(), body: upstream.body });
    const controller = new AbortController();
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}", signal: controller.signal });
    expect(await result.text()).toBe("data: 0\n\ndata: 1\n\n");
    controller.abort(); // after completion: a no-op
  });

  it("bridges the body even without a signal, so a consumer cancel still drains", async () => {
    const upstream = slowBody(4);
    wreqFetchMock.mockResolvedValueOnce({ status: 200, statusText: "OK", headers: new Map(), body: upstream.body });
    const result = await client.opencodeTlsFetch(URL_FREE, { method: "POST", body: "{}" });
    await result.body.cancel();
    await vi.waitFor(() => expect(upstream.produced).toBe(4));
    expect(upstream.cancel).not.toHaveBeenCalled();
  });
});
