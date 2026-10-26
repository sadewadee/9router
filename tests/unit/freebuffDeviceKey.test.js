import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  FreebuffDeviceKeyManager,
  generateDeviceKeyRecord,
  signDeviceRequest,
  buildStringToSign,
  b64urlEncode,
  b64urlDecode,
  bodyToBytes,
  deviceKeyScope,
  isDeviceKeyError,
  DEVICE_KEY_HEADER,
  DEVICE_TS_HEADER,
  DEVICE_SIG_HEADER,
  SIGNATURE_VERSION,
} from "../../open-sse/utils/freebuffDeviceKey.js";

const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;
const encoder = new TextEncoder();

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function importVerifyKey(record) {
  return await subtle.importKey("raw", b64urlDecode(record.publicKey), { name: "Ed25519" }, false, ["verify"]);
}

describe("freebuff device key primitives", () => {
  it("builds the exact string-to-sign of the CLI (NOA)", () => {
    expect(
      buildStringToSign({ method: "post", path: "/api/v1/chat/completions", timestampMs: 1_723_456_789_012, bodySha256: "abc123", fetchId: "fetch-9" }),
    ).toBe(`freebuff-device-v1\nPOST\n/api/v1/chat/completions\n1723456789012\nabc123\nfetch-9`);
  });

  it("uses an empty fetchId field when there is no catalog", () => {
    expect(buildStringToSign({ method: "GET", path: "/api/v1/freebuff/models", timestampMs: 7, bodySha256: "x" })).toBe(
      `freebuff-device-v1\nGET\n/api/v1/freebuff/models\n7\nx\n`,
    );
  });

  it("hashes an absent body as the empty byte string", () => {
    expect(bodyToBytes(undefined)).toHaveLength(0);
    expect(bodyToBytes(null)).toHaveLength(0);
    expect(bodyToBytes("{}")).toEqual(encoder.encode("{}"));
  });

  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlEncode(bytes)).not.toMatch(/[+/=]/);
  });

  it("generates a record in the CLI storage shape", async () => {
    const record = await generateDeviceKeyRecord(subtle);
    expect(record.version).toBe(1);
    expect(b64urlDecode(record.publicKey)).toHaveLength(32); // raw Ed25519 public key
    expect(b64urlDecode(record.privateKey)).toHaveLength(48); // pkcs8 Ed25519 private key (DER)
  });

  it("signs so the raw public key verifies the exact string-to-sign (64-byte signature)", async () => {
    const record = await generateDeviceKeyRecord(subtle);
    const url = "https://www.codebuff.com/api/v1/chat/completions";
    const body = JSON.stringify({ model: "mimo/mimo-v2.5", messages: [] });
    const timestampMs = 1_723_456_789_999;
    const headers = await signDeviceRequest({ record, keyId: "key-1", method: "POST", url, body, fetchId: "fetch-1", timestampMs });

    expect(headers[DEVICE_KEY_HEADER]).toBe("key-1");
    expect(headers[DEVICE_TS_HEADER]).toBe(String(timestampMs));
    const sig = b64urlDecode(headers[DEVICE_SIG_HEADER]);
    expect(sig).toHaveLength(64);

    const stringToSign = buildStringToSign({
      method: "POST",
      path: new URL(url).pathname,
      timestampMs,
      bodySha256: sha256Hex(body),
      fetchId: "fetch-1",
    });
    const ok = await subtle.verify({ name: "Ed25519" }, await importVerifyKey(record), sig, encoder.encode(stringToSign));
    expect(ok).toBe(true);
  });

  it("signs a bodyless GET with the hash of zero bytes", async () => {
    const record = await generateDeviceKeyRecord(subtle);
    const url = "https://freebuff.com/api/v1/freebuff/models";
    const headers = await signDeviceRequest({ record, keyId: "k", method: "GET", url, body: undefined, fetchId: "", timestampMs: 5 });
    const stringToSign = buildStringToSign({
      method: "GET",
      path: "/api/v1/freebuff/models",
      timestampMs: 5,
      bodySha256: sha256Hex(""),
      fetchId: "",
    });
    const ok = await subtle.verify({ name: "Ed25519" }, await importVerifyKey(record), b64urlDecode(headers[DEVICE_SIG_HEADER]), encoder.encode(stringToSign));
    expect(ok).toBe(true);
  });

  it("scopes registrations per origin and account", async () => {
    await expect(deviceKeyScope({ apiHost: "https://freebuff.com", token: "tok", accountId: "u-1" })).resolves.toBe(
      "https://freebuff.com user:u-1",
    );
    const scope = await deviceKeyScope({ apiHost: "https://www.codebuff.com", token: "tok" });
    expect(scope).toBe(`https://www.codebuff.com token:${sha256Hex("tok").slice(0, 32)}`);
  });

  it("matches only device-key registration errors (aWA)", () => {
    expect(isDeviceKeyError("device_key unknown")).toBe(true);
    expect(isDeviceKeyError("Device-Key not_found")).toBe(true);
    expect(isDeviceKeyError("the devicekey is unregistered")).toBe(true);
    expect(isDeviceKeyError("device_key expired")).toBe(false);
    expect(isDeviceKeyError("unregistered model")).toBe(false);
    expect(isDeviceKeyError("rate limited")).toBe(false);
    expect(isDeviceKeyError("")).toBe(false);
    expect(isDeviceKeyError(undefined)).toBe(false);
  });
});

describe("FreebuffDeviceKeyManager", () => {
  const registerUrl = "https://freebuff.com/api/v1/freebuff/device-keys";
  const ctx = { token: "tok-1", accountId: null, apiHost: "https://freebuff.com" };

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  it("registers lazily, signs, and caches the keyId (one POST per scope)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyId: "key-A" }));
    const persisted = [];
    const manager = new FreebuffDeviceKeyManager({ fetchImpl, persist: (r) => persisted.push(r) });

    const headers = await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/api/v1/freebuff/models" });
    expect(headers[DEVICE_KEY_HEADER]).toBe("key-A");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(registerUrl);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(init.body)).toEqual({ publicKey: manager.record.publicKey, client: "cli" });

    await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/api/v1/freebuff/models" });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // keyId cached per scope

    // The record (with the registration) reached the persister, including the private key.
    const saved = persisted.at(-1);
    expect(saved.version).toBe(1);
    expect(saved.privateKey).toBeTruthy();
    expect(saved.registrations["https://freebuff.com token:" + sha256Hex("tok-1").slice(0, 32)]).toBe("key-A");
  });

  it("scopes by account id when one is known", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyId: "key-B" }));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    await manager.headers({ ...ctx, accountId: "u-9", method: "GET", url: "https://freebuff.com/x" });
    expect(manager.record.registrations["https://freebuff.com user:u-9"]).toBe("key-B");
  });

  it("reinstates a stored record without re-registering", async () => {
    const record = await generateDeviceKeyRecord(subtle);
    record.registrations = { [`https://freebuff.com token:${sha256Hex("tok-1").slice(0, 32)}`]: "key-stored" };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyId: "key-never" }));
    const manager = new FreebuffDeviceKeyManager({ record, fetchImpl });
    const headers = await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" });
    expect(headers[DEVICE_KEY_HEADER]).toBe("key-stored");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cools down after a 404 route miss for an hour, other failures for five minutes", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl, now: () => now });
    expect(await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cooled down

    now += 3_600_001;
    fetchImpl.mockResolvedValue(jsonResponse({ keyId: "key-late" }));
    const headers = await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" });
    expect(headers[DEVICE_KEY_HEADER]).toBe("key-late");

    // A 500 cools down for five minutes only.
    now += 3_600_001;
    const manager2 = new FreebuffDeviceKeyManager({ fetchImpl: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })), now: () => now });
    expect(await manager2.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(manager2.retryAfter.get(await deviceKeyScope(ctx))).toBe(now + 300_000);
  });

  it("single-flights concurrent registrations for the same scope", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const fetchImpl = vi.fn().mockImplementation(async () => {
      await gate;
      return jsonResponse({ keyId: "key-shared" });
    });
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    const first = manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/a" });
    const second = manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/b" });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let both reach the shared register
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a[DEVICE_KEY_HEADER]).toBe("key-shared");
    expect(b[DEVICE_KEY_HEADER]).toBe("key-shared");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a register timeout cools down instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("TimeoutError"));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    expect(await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a missing keyId answer counts as a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    expect(await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" })).toEqual({});
  });

  it("forgetRegistration drops the keyId so the next call re-registers", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockImplementation(async () => jsonResponse({ keyId: `key-${fetchImpl.mock.calls.length}` }));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    manager.forgetRegistration(ctx);
    // forget is async but serialized through saving; wait for it to settle.
    await manager.saving;
    const headers = await manager.headers({ ...ctx, method: "GET", url: "https://freebuff.com/x" });
    expect(headers[DEVICE_KEY_HEADER]).toBe("key-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("signs over the exact request body when one is passed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyId: "key-c" }));
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    const body = JSON.stringify({ hello: "world" });
    const headers = await manager.headers({ ...ctx, method: "POST", url: "https://www.codebuff.com/api/v1/chat/completions", body });
    const record = manager.record;
    const stringToSign = buildStringToSign({
      method: "POST",
      path: "/api/v1/chat/completions",
      timestampMs: Number(headers[DEVICE_TS_HEADER]),
      bodySha256: sha256Hex(body),
      fetchId: "",
    });
    const ok = await subtle.verify(
      { name: "Ed25519" },
      await importVerifyKey(record),
      b64urlDecode(headers[DEVICE_SIG_HEADER]),
      encoder.encode(stringToSign),
    );
    expect(ok).toBe(true);
  });

  it("never signs without a token", async () => {
    const fetchImpl = vi.fn();
    const manager = new FreebuffDeviceKeyManager({ fetchImpl });
    expect(await manager.headers({ method: "GET", url: "https://freebuff.com/x" })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("SIGNATURE_VERSION", () => {
  it("is the CLI wire value", () => {
    expect(SIGNATURE_VERSION).toBe("freebuff-device-v1");
  });
});
