// TLS-impersonating transport for opencode.ai's free tier.
//
// The free gate keys on the TLS ClientHello, not on headers: a request that passes
// from the OpenCode CLI is refused with 429 FreeUsageLimitError when the same
// body/headers ride Node's OpenSSL fingerprint, and passes again once the cipher
// list matches (decolua/9router ce060c79, measured 2026-10-26 on one process and
// one egress IP: node fetch/https/http2 all 429, Bun's BoringSSL fetch 200).
// JA4's cipher hash identifies the list (Bun: 5b57614c22b0), so the match is on
// the cipher-list hash and nothing else: reordering the same list still passes,
// dropping any entry fails.
//
// wreq-js carries that list natively and tunnels through plain HTTP(S)/SOCKS5
// proxies without touching the ClientHello. A relay pool (Cloudflare Worker,
// Vercel, Deno) cannot keep it: the platform opens its own TLS connection.
//
// wreq-js is an optional dependency resolved from the app's node_modules. When it
// is absent, disabled (OPENCODE_TLS_IMPERSONATE=0) or the proxy scheme is not
// supported, opencodeTlsFetch resolves to null and the caller keeps its native
// path, so the request goes out (and is subject to the gate) instead of failing.

import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "../utils/debugLog.js";

// BoringSSL/Chrome-family cipher list the upstream accepts, in the order Bun
// sends it. Only the list's hash is compared, so this must stay verbatim.
const OPENCODE_CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

// wreq-js `timeout` is a TOTAL deadline that also cuts a live SSE stream (verified:
// timeout=2000 errors the body at 2s), unlike undici's idle bodyTimeout. Keep it far
// above any real completion and let readTimeout (idle between reads) catch a stall.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const READ_TIMEOUT_MS = 5 * 60 * 1000;

const PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

let wreqLoader = () => import(/* webpackIgnore: true */ "wreq-js");
let wreqPromise = null;
// proxy URL (or "direct") -> Promise<Transport>. One pooled transport per egress;
// a transport keeps connections alive but, unlike a wreq session, no cookie jar,
// so requests stay as stateless as the CLI's own.
const transports = new Map();
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[OpenCodeTLS] ${message}`);
}

/** Kill switch: OPENCODE_TLS_IMPERSONATE=0|false|off|no routes the free lane over native fetch. */
export function isOpencodeTlsEnabled() {
  const raw = process.env.OPENCODE_TLS_IMPERSONATE?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function loadWreq() {
  // A failed import is cached too: the module cannot appear without a restart.
  if (!wreqPromise) wreqPromise = Promise.resolve().then(wreqLoader);
  return wreqPromise;
}

function getTransport(wreq, proxyUrl) {
  const key = proxyUrl || "direct";
  let entry = transports.get(key);
  if (entry) return entry;
  if (transports.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
    const oldestKey = transports.keys().next().value;
    const evicted = transports.get(oldestKey);
    transports.delete(oldestKey);
    // In-flight streams may still ride it; every request is over after the total deadline.
    setTimeout(() => evicted.then((t) => t.close?.()).catch(() => {}), REQUEST_TIMEOUT_MS).unref?.();
  }
  entry = Promise.resolve(wreq.createTransport({
    emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
    readTimeout: READ_TIMEOUT_MS,
    ...(proxyUrl ? { proxy: proxyUrl } : {}),
  }));
  transports.set(key, entry);
  entry.catch(() => {
    if (transports.get(key) === entry) transports.delete(key);
  });
  return entry;
}

/** Drop cached transports so the next call builds fresh ones (tests, config change). */
export function resetOpencodeTlsClient() {
  const pending = [...transports.values()];
  transports.clear();
  wreqPromise = null;
  warned.clear();
  for (const entry of pending) entry.then((t) => t.close?.()).catch(() => {});
}

// wreq's native errors can echo the proxy URL, which carries credentials.
function redactProxy(error, proxyUrl) {
  if (!proxyUrl || !(error instanceof Error)) return error;
  try {
    const parsed = new URL(proxyUrl);
    for (const secret of [proxyUrl, decodeURIComponent(parsed.password), parsed.password, decodeURIComponent(parsed.username), parsed.username]) {
      if (secret) error.message = error.message.split(secret).join("***");
    }
  } catch {
    // unparsable proxy URL: nothing sensible to scrub
  }
  return error;
}

// wreq only honours the AbortSignal until the response headers arrive, so a client
// disconnect (streamHandler aborts the signal) must be bridged onto the body: the
// consumer gets the abort as native fetch would deliver it.
//
// What wreq-js 3.2.0 cannot do is close the connection mid-response. Cancelling the
// body only stops reading: the socket stays ESTABLISHED, its receive queue fills to
// the buffer limit and the upstream blocks on backpressure for the whole request
// timeout (observed: still open after 135s, even after closing the transport). So
// after an abort or cancel the remainder is drained and discarded in the background,
// which lets the response complete and the connection be released as soon as the
// upstream ends it. The drain ends at EOF or at the request deadline.
function bridgeBody(stream, signal) {
  if (!stream) return stream;
  const reader = stream.getReader();
  let finished = false;
  let onAbort;
  const settle = () => {
    finished = true;
    signal?.removeEventListener("abort", onAbort);
  };
  const drain = async () => {
    try {
      while (!(await reader.read()).done);
    } catch {
      // stream ended abnormally or hit the request deadline: nothing left to release
    }
  };
  return new ReadableStream({
    start(controller) {
      onAbort = () => {
        if (finished) return;
        settle();
        controller.error(signal.reason);
        drain();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (finished) return;
        settle();
        controller.error(error);
      }
    },
    cancel() {
      if (finished) return;
      settle();
      drain();
    },
  });
}

/**
 * Fetch through the impersonated-TLS transport. Returns a native Response so the
 * downstream `.body` / `.text()` / `.json()` consumers keep working unchanged, with
 * the live ReadableStream handed over unbuffered, or null when this transport
 * declines the request (disabled, wreq-js absent, unsupported proxy scheme) and the
 * caller should use its native path.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string, signal?: AbortSignal}} [init]
 * @param {{proxyUrl?: string|null}} [egress] - plain HTTP(S)/SOCKS5 proxy to tunnel through
 */
export async function opencodeTlsFetch(url, init = {}, { proxyUrl = null } = {}) {
  if (!isOpencodeTlsEnabled()) return null;

  if (proxyUrl) {
    let protocol = "";
    try { protocol = new URL(proxyUrl).protocol; } catch { /* rejected below */ }
    if (!PROXY_PROTOCOLS.has(protocol)) {
      warnOnce(`proxy-scheme:${protocol}`, `proxy scheme ${protocol || "(invalid)"} is not supported by wreq-js, using native fetch (free-tier TLS gate applies)`);
      return null;
    }
  }

  let wreq;
  try {
    wreq = await loadWreq();
  } catch (error) {
    warnOnce("unavailable", `wreq-js unavailable (${error?.code || error?.message || "unknown"}), using native fetch: the OpenCode free tier answers 429 FreeUsageLimitError to Node's TLS fingerprint. Install the optional wreq-js dependency.`);
    return null;
  }

  try {
    const transport = await getTransport(wreq, proxyUrl);
    const res = await wreq.fetch(url, {
      method: init.method || "GET",
      headers: init.headers,
      ...(init.body !== undefined && init.body !== null ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      transport,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const headers = new Headers();
    res.headers?.forEach?.((value, key) => {
      // wreq already decoded the body, so the encoding and length headers would lie.
      const name = key.toLowerCase();
      if (name === "content-encoding" || name === "content-length") return;
      headers.append(key, value);
    });
    dbg("TLS", `opencode via wreq-js ${proxyUrl ? "proxy" : "direct"} | ${res.status}`);
    const body = NULL_BODY_STATUS.has(res.status) ? null : bridgeBody(res.body, init.signal);
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  } catch (error) {
    throw redactProxy(error, proxyUrl);
  }
}

export const __test__ = {
  OPENCODE_CIPHER_LIST,
  REQUEST_TIMEOUT_MS,
  setWreqLoader(loader) {
    wreqLoader = loader;
    resetOpencodeTlsClient();
  },
};
