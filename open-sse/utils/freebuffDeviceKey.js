// Freebuff device-key attestation (protocol of the official CLI 0.2.34).
//
// The CLI generates one Ed25519 keypair (WebCrypto {name:"Ed25519"}), registers the raw public
// key at POST https://freebuff.com/api/v1/freebuff/device-keys {publicKey, client:"cli"}
// (Bearer auth, 10s timeout) and signs every chat / session / catalog call:
//   string-to-sign = "freebuff-device-v1\n<METHOD>\n<pathname>\n<timestampMs>\n<sha256(body)hex>\n<fetchId|\"\">"
//   headers      = x-freebuff-device-key: <keyId>, x-freebuff-device-ts: <ms>, x-freebuff-device-sig: <base64url>
// Registration is scoped per origin + account ("<origin> user:<id>" or
// "<origin> token:<sha256(token)hex[0:32]>") and the keyId is cached per scope.
// A failed registration cools down: 404/405 (no route) for 1h, everything else 5min.
// Signing never breaks the request: any failure yields {} and the call goes out unsigned.
//
// Output is byte-compatible with the CLI: standard Ed25519 (64-byte signature, 32-byte raw
// public key), base64url without padding.

import { webcrypto } from "node:crypto";

const ED25519 = { name: "Ed25519" };
const SIGN_TIMEOUT_MS = 3000; // DCL — CLI gives prepare+sign 3s, else goes unsigned
const REGISTER_TIMEOUT_MS = 10_000; // ICL — device-keys POST budget
const COOLDOWN_NO_ROUTE_MS = 3_600_000; // ECL — 404/405 from the register endpoint
const COOLDOWN_OTHER_MS = 300_000; // QpH — every other register failure

export const DEVICE_KEY_HEADER = "x-freebuff-device-key";
export const DEVICE_TS_HEADER = "x-freebuff-device-ts";
export const DEVICE_SIG_HEADER = "x-freebuff-device-sig";
export const SIGNATURE_VERSION = "freebuff-device-v1";

const encoder = new TextEncoder();

export function b64urlEncode(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new Uint8Array(binary.length).map((_, i) => binary.charCodeAt(i));
}

// The CLI matches /device[_-]?key/i + unknown|not[_-]?found|invalid|unregistered on upstream
// error text before dropping a registration and re-registering (aWA).
export function isDeviceKeyError(message) {
  return (
    !!message &&
    /device[_-]?key/i.test(message) &&
    /unknown|not[_-]?found|invalid|unregistered/i.test(message)
  );
}

// UCL: null/undefined body hashes as the empty byte string; strings encode as UTF-8.
export function bodyToBytes(body) {
  if (body === null || body === undefined) return new Uint8Array(0);
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  return encoder.encode(String(body));
}

export function buildStringToSign({ method, path, timestampMs, bodySha256, fetchId }) {
  return [SIGNATURE_VERSION, method.toUpperCase(), path, String(timestampMs), bodySha256, fetchId ?? ""].join("\n");
}

function subtleOf(injected) {
  if (injected) return injected;
  // Some embeddings (vitest workers on Node 18) do not expose the global crypto namespace.
  return globalThis.crypto?.subtle ?? webcrypto.subtle ?? null;
}

async function sha256Hex(bytes, subtle) {
  const digest = await subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// Fresh keypair in the CLI's storage shape: base64url raw public key + pkcs8 private key.
export async function generateDeviceKeyRecord(subtle = null) {
  const api = subtleOf(subtle);
  if (!api) throw new Error("WebCrypto subtle is unavailable");
  const pair = await api.generateKey(ED25519, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await api.exportKey("raw", pair.publicKey));
  const privateKey = new Uint8Array(await api.exportKey("pkcs8", pair.privateKey));
  return { version: 1, publicKey: b64urlEncode(publicKey), privateKey: b64urlEncode(privateKey) };
}

async function importPrivateKey(record, subtle) {
  if (!record?.privateKey) throw new Error("device key record has no private key");
  return await subtle.importKey("pkcs8", b64urlDecode(record.privateKey), ED25519, true, ["sign"]);
}

// Scope of a registration: the origin owns its keyIds, and so does each account on it.
export async function deviceKeyScope({ apiHost, token, accountId } = {}, subtle = null) {
  const api = subtleOf(subtle);
  const origin = String(apiHost || "").replace(/\/$/, "");
  if (accountId) return `${origin} user:${accountId}`;
  const hash = await sha256Hex(bodyToBytes(token), api);
  return `${origin} token:${hash.slice(0, 32)}`;
}

// Sign one request (XCL). Returns the three device headers; throws only on real crypto
// failures — callers catch and degrade to unsigned like the CLI does.
export async function signDeviceRequest({ record, keyId, method, url, body, fetchId, timestampMs, subtle = null }) {
  const api = subtleOf(subtle);
  if (!api) throw new Error("WebCrypto subtle is unavailable");
  const privateKey = await importPrivateKey(record, api);
  const stringToSign = buildStringToSign({
    method,
    path: new URL(url).pathname,
    timestampMs,
    bodySha256: await sha256Hex(bodyToBytes(body), api),
    fetchId,
  });
  const signature = new Uint8Array(await api.sign(ED25519, privateKey, encoder.encode(stringToSign)));
  return {
    [DEVICE_KEY_HEADER]: keyId,
    [DEVICE_TS_HEADER]: String(timestampMs),
    [DEVICE_SIG_HEADER]: b64urlEncode(signature),
  };
}

/**
 * One device keypair per token (9router stores it on the provider connection). The manager owns
 * the record, the per-scope keyId cache, registration single-flight and cooldowns. Persistence
 * is delegated to the `persist` callback so the executor can decide where the record lives.
 */
export class FreebuffDeviceKeyManager {
  constructor({
    record = null,
    persist = null,
    fetchImpl = null,
    now = Date.now,
    subtle = null,
    log = null,
    client = "cli",
    registerPath = "/api/v1/freebuff/device-keys",
  } = {}) {
    this.record = record;
    this.persistFn = persist;
    this.fetchImpl = fetchImpl || ((url, init) => fetch(url, init));
    this.now = now;
    this.subtle = subtleOf(subtle);
    this.log = log;
    this.client = client;
    this.registerPath = registerPath;
    this.registering = new Map(); // scope -> Promise<keyId|null>
    this.retryAfter = new Map(); // scope -> ms timestamp
    this.saving = Promise.resolve();
  }

  debug(message) {
    this.log?.debug?.("FREEBUFF", message);
  }

  async save(record) {
    this.record = record;
    if (!this.persistFn) return;
    this.saving = this.saving
      .then(() => this.persistFn(record))
      .catch(() => {});
    return this.saving;
  }

  // Single-flight key generation (the CLI's `loading` pattern): two concurrent signers must not
  // mint two keypairs — the slower save would clobber the first one's registration.
  ensureKey() {
    if (this.record) return Promise.resolve(this.record);
    if (!this.ensuring) {
      this.ensuring = (async () => {
        const record = await generateDeviceKeyRecord(this.subtle);
        await this.save(record);
        return record;
      })().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  hasRegistration({ token, accountId, apiHost } = {}) {
    if (!this.record) return false;
    // Synchronous check for the common single-scope case; the async scope lookup is only
    // needed when an accountId is absent and the token hash decides the scope.
    if (accountId) return Boolean(this.record.registrations?.[`${String(apiHost).replace(/\/$/, "")} user:${accountId}`]);
    return Object.keys(this.record.registrations || {}).length > 0;
  }

  async keyIdFor(scope, ctx) {
    const existing = this.record?.registrations?.[scope];
    if (existing) return existing;
    if ((this.retryAfter.get(scope) ?? 0) > this.now()) return null;
    let pending = this.registering.get(scope);
    if (!pending) {
      pending = this.register(scope, ctx).finally(() => this.registering.delete(scope));
      this.registering.set(scope, pending);
    }
    return pending;
  }

  async register(scope, { token, accountId, apiHost }) {
    const fail = (cooldownMs, why) => {
      this.retryAfter.set(scope, this.now() + cooldownMs);
      this.debug(`device key registration failed (${why})`);
      return null;
    };
    let response;
    try {
      await this.ensureKey();
      response = await this.fetchImpl(`${String(apiHost).replace(/\/$/, "")}${this.registerPath}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ publicKey: this.record.publicKey, client: this.client }),
        signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      });
    } catch (err) {
      return fail(COOLDOWN_OTHER_MS, err?.message || err);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return fail(response.status === 404 || response.status === 405 ? COOLDOWN_NO_ROUTE_MS : COOLDOWN_OTHER_MS, `HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => null);
    const keyId = typeof data?.keyId === "string" ? data.keyId : "";
    if (!keyId) return fail(COOLDOWN_OTHER_MS, "no keyId in the answer");
    const registrations = { ...(this.record?.registrations || {}), [scope]: keyId };
    await this.save({ ...this.record, version: 1, registrations });
    return keyId;
  }

  // Signing entry point (SpH.headers): never throws, {} on any failure.
  async headers({ token, accountId, apiHost, method, url, body, fetchId, register = true } = {}) {
    try {
      const api = this.subtle;
      if (!api || !token) return {};
      const scope = await deviceKeyScope({ apiHost, token, accountId }, api);
      let keyId;
      if (register) {
        const prepared = await this.prepareKeyWithTimeout();
        if (!prepared) return {};
        keyId = await this.keyIdFor(scope, { token, accountId, apiHost });
      } else {
        keyId = this.record?.registrations?.[scope] ?? null;
      }
      if (!keyId || !this.record) return {};
      return await signDeviceRequest({
        record: this.record,
        keyId,
        method,
        url,
        body,
        fetchId,
        timestampMs: this.now(),
        subtle: api,
      });
    } catch (err) {
      this.debug(`signing failed: ${err?.message || err}`);
      return {};
    }
  }

  // The CLI races prepare() against a 3s budget (TCL/DCL) and goes unsigned on timeout.
  async prepareKeyWithTimeout() {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), SIGN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.ensureKey(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Drop a scope's keyId so the next signed call re-registers (upstream said unknown key).
  forgetRegistration({ token, accountId, apiHost } = {}) {
    (async () => {
      if (!this.record) return;
      const scope = await deviceKeyScope({ apiHost, token, accountId }, this.subtle);
      this.retryAfter.delete(scope);
      if (!(scope in (this.record.registrations || {}))) return;
      const registrations = { ...this.record.registrations };
      delete registrations[scope];
      await this.save({ ...this.record, registrations });
    })().catch(() => {});
  }
}

export const __test__ = {
  SIGN_TIMEOUT_MS,
  REGISTER_TIMEOUT_MS,
  COOLDOWN_NO_ROUTE_MS,
  COOLDOWN_OTHER_MS,
};
