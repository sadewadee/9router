// WorkBuddy International OAuth: no-PKCE browser polling flow on www.workbuddy.ai.
//   POST /v2/plugin/auth/state?platform=CLI  -> { state, authUrl }
//   GET  /v2/plugin/auth/token?state=        -> code 11217 while pending, code 0 + tokens when done
//   GET  /v2/plugin/login/account?state=     -> uid / nickname (Bearer; only answers after login)
//   GET  /auth/realms/copilot/overseas/user/register?userId=  -> idempotent account activation
// Activation must never block saving the connection; "region required" is surfaced on it.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";

import workbuddy from "../../src/lib/oauth/providers/workbuddy.js";
import { getProvider, pollForToken, requestDeviceCode } from "../../src/lib/oauth/providers/index.js";
import { selectCheckinConnections } from "../../src/sse/services/codebuddyCheckin.js";

const BASE = "https://www.workbuddy.ai";
const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const ACCESS = jwt({ sub: "uid-jwt" });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const tokenOk = { code: 0, data: { accessToken: ACCESS, refreshToken: "rt-1", expiresIn: 5184000, domain: "www.workbuddy.ai", tokenType: "Bearer" } };

// Routes by path; each value is a handler(url, init) -> Response (or throws).
function stubFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), path: u.pathname, search: u.search, init });
    const handler = routes[u.pathname];
    if (!handler) throw new Error(`unexpected request ${u.pathname}`);
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls, last: (p) => [...calls].reverse().find((c) => c.path === p) };
}

const headerValue = (init, name) => Object.entries(init.headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

afterEach(() => vi.unstubAllGlobals());

describe("workbuddy oauth config", () => {
  it("points at the workbuddy.ai realm", () => {
    expect(workbuddy.flowType).toBe("device_code");
    expect(workbuddy.config).toMatchObject({
      stateUrl: `${BASE}/v2/plugin/auth/state`,
      tokenUrl: `${BASE}/v2/plugin/auth/token`,
      accountUrl: `${BASE}/v2/plugin/login/account`,
      refreshUrl: `${BASE}/v2/plugin/auth/token/refresh`,
      registerUrl: `${BASE}/auth/realms/copilot/overseas/user/register`,
      platform: "CLI",
    });
    expect(getProvider("workbuddy")).toBe(workbuddy);
  });
});

describe("requestDeviceCode (auth/state)", () => {
  it("POSTs an empty JSON body to /v2/plugin/auth/state?platform=CLI with the client headers and no auth", async () => {
    const net = stubFetch({ "/v2/plugin/auth/state": () => json({ code: 0, data: { state: "st-1", authUrl: "https://www.workbuddy.ai/login?state=st-1" } }) });
    const out = await requestDeviceCode("workbuddy");

    expect(net.calls).toHaveLength(1);
    const { url, init } = net.calls[0];
    expect(url).toBe(`${BASE}/v2/plugin/auth/state?platform=CLI`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(headerValue(init, "Origin")).toBe(BASE);
    expect(headerValue(init, "Referer")).toBe(`${BASE}/`);
    expect(headerValue(init, "User-Agent")).toBe("WorkBuddy/5.5.4");
    expect(headerValue(init, "X-Requested-With")).toBe("XMLHttpRequest");
    expect(headerValue(init, "Content-Type")).toBe("application/json");
    expect(headerValue(init, "Authorization")).toBeUndefined();
    expect(out).toMatchObject({ device_code: "st-1", verification_uri: "https://www.workbuddy.ai/login?state=st-1", interval: 5 });
  });

  it("does not use PKCE (no code challenge in the request)", async () => {
    const net = stubFetch({ "/v2/plugin/auth/state": () => json({ code: 0, data: { state: "s", authUrl: "u" } }) });
    await requestDeviceCode("workbuddy", "challenge-should-be-ignored");
    expect(net.calls[0].url).not.toContain("challenge");
    expect(net.calls[0].init.body).toBe("{}");
  });

  it("throws on an HTTP error and on a business error", async () => {
    stubFetch({ "/v2/plugin/auth/state": () => new Response("denied", { status: 403 }) });
    await expect(requestDeviceCode("workbuddy")).rejects.toThrow(/WorkBuddy state request failed: denied/);
    stubFetch({ "/v2/plugin/auth/state": () => json({ code: 11140, msg: "request illegal" }) });
    await expect(requestDeviceCode("workbuddy")).rejects.toThrow(/request illegal/);
  });
});

describe("pollToken (auth/token + login/account)", () => {
  const account = { code: 0, data: { uid: "uid-acct", nickname: "Wen", enterpriseId: "" } };

  it("GETs /v2/plugin/auth/token with the url-encoded state and the client headers", async () => {
    const net = stubFetch({ "/v2/plugin/auth/token": () => json({ code: 11217, msg: "login ing" }) });
    await workbuddy.pollToken(workbuddy.config, "a b&c");
    const { url, init } = net.calls[0];
    expect(url).toBe(`${BASE}/v2/plugin/auth/token?state=a%20b%26c`);
    expect(init.method).toBe("GET");
    expect(headerValue(init, "Origin")).toBe(BASE);
    expect(headerValue(init, "User-Agent")).toBe("WorkBuddy/5.5.4");
    expect(headerValue(init, "Authorization")).toBeUndefined();
  });

  it("reports code 11217 as authorization_pending and anything else as an error", async () => {
    stubFetch({ "/v2/plugin/auth/token": () => json({ code: 11217, msg: "login ing" }) });
    expect(await workbuddy.pollToken(workbuddy.config, "s")).toEqual({ ok: true, data: { error: "authorization_pending" } });
    stubFetch({ "/v2/plugin/auth/token": () => json({ code: 12000, msg: "state expired" }) });
    expect(await workbuddy.pollToken(workbuddy.config, "s")).toEqual({ ok: false, data: { error: "state expired" } });
    stubFetch({ "/v2/plugin/auth/token": () => new Response("x", { status: 502 }) });
    expect(await workbuddy.pollToken(workbuddy.config, "s")).toEqual({ ok: false, data: { error: "request_failed" } });
  });

  it("fetches login/account with the new Bearer once the token arrives", async () => {
    const net = stubFetch({
      "/v2/plugin/auth/token": () => json(tokenOk),
      "/v2/plugin/login/account": () => json(account),
    });
    const out = await workbuddy.pollToken(workbuddy.config, "st-9");

    const acct = net.last("/v2/plugin/login/account");
    expect(acct.url).toBe(`${BASE}/v2/plugin/login/account?state=st-9`);
    expect(headerValue(acct.init, "Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({
      access_token: ACCESS,
      refresh_token: "rt-1",
      expires_in: 5184000,
      domain: "www.workbuddy.ai",
      uid: "uid-acct",
      nickname: "Wen",
    });
  });

  it("still logs in when login/account fails: the uid falls back to the token's sub", async () => {
    stubFetch({
      "/v2/plugin/auth/token": () => json(tokenOk),
      "/v2/plugin/login/account": () => new Response("nope", { status: 401 }),
    });
    const out = await workbuddy.pollToken(workbuddy.config, "st-9");
    expect(out.ok).toBe(true);
    expect(out.data.uid).toBe("uid-jwt");
    expect(out.data.nickname).toBe("");
  });
});

describe("account activation (overseas register)", () => {
  const tokens = { access_token: ACCESS, uid: "uid-1" };
  const register = (body, status = 200) => ({ "/auth/realms/copilot/overseas/user/register": () => json(body, status) });

  it("GETs register?userId=<uid> with the Bearer token and X-User-Id", async () => {
    const net = stubFetch(register({ code: 200, msg: "register success" }));
    const out = await workbuddy.postExchange(tokens);

    expect(out).toEqual({ status: "ok" });
    const { url, init } = net.calls[0];
    expect(url).toBe(`${BASE}/auth/realms/copilot/overseas/user/register?userId=uid-1`);
    expect(init.method).toBe("GET");
    expect(headerValue(init, "Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headerValue(init, "X-User-Id")).toBe("uid-1");
    expect(headerValue(init, "Origin")).toBe(BASE);
  });

  it("reports a region requirement (code 500 / 'region required')", async () => {
    stubFetch(register({ code: 500, msg: "region required" }));
    expect(await workbuddy.postExchange(tokens)).toEqual({ status: "region_required", message: "region required" });
    stubFetch(register({ code: 1, msg: "User Region Required for this account" }));
    expect((await workbuddy.postExchange(tokens)).status).toBe("region_required");
  });

  it("never throws: network errors, HTTP errors and odd codes are 'failed'", async () => {
    stubFetch({ "/auth/realms/copilot/overseas/user/register": () => { throw new Error("socket hang up"); } });
    expect(await workbuddy.postExchange(tokens)).toEqual({ status: "failed", message: "socket hang up" });
    stubFetch(register({}, 503));
    expect(await workbuddy.postExchange(tokens)).toEqual({ status: "failed", message: "HTTP 503" });
    stubFetch(register({ code: 42, msg: "weird" }));
    expect(await workbuddy.postExchange(tokens)).toEqual({ status: "failed", message: "weird" });
  });

  it("skips the call when no uid could be determined", async () => {
    const net = stubFetch({});
    expect(await workbuddy.postExchange({ access_token: "opaque", uid: "" })).toEqual({ status: "skipped" });
    expect(net.fn).not.toHaveBeenCalled();
  });
});

describe("mapTokens", () => {
  const tokens = { access_token: ACCESS, refresh_token: "rt-1", expires_in: 5184000, domain: "www.workbuddy.ai", uid: "uid-1", nickname: "Wen", enterprise_id: "" };

  it("stores the uid and activation status on the connection", () => {
    expect(workbuddy.mapTokens(tokens, { status: "ok" })).toEqual({
      accessToken: ACCESS,
      refreshToken: "rt-1",
      expiresIn: 5184000,
      name: "Wen",
      displayName: "Wen",
      providerSpecificData: { uid: "uid-1", domain: "www.workbuddy.ai", registerStatus: "ok" },
    });
  });

  it("surfaces 'region required' as a clear lastError on the connection", () => {
    const out = workbuddy.mapTokens(tokens, { status: "region_required", message: "region required" });
    expect(out.lastError).toMatch(/no region yet/i);
    expect(out.lastError).toContain("https://www.workbuddy.ai");
    expect(out.lastErrorAt).toBeTruthy();
    expect(out.providerSpecificData.registerStatus).toBe("region_required");
  });

  it("surfaces a failed activation without losing the login", () => {
    const out = workbuddy.mapTokens(tokens, { status: "failed", message: "HTTP 503" });
    expect(out.accessToken).toBe(ACCESS);
    expect(out.lastError).toMatch(/activation failed \(HTTP 503\)/);
  });

  it("sets no lastError for an ok or skipped activation, and defaults the expiry", () => {
    expect(workbuddy.mapTokens(tokens, { status: "ok" }).lastError).toBeUndefined();
    const skipped = workbuddy.mapTokens({ ...tokens, uid: "", nickname: "", expires_in: undefined }, { status: "skipped" });
    expect(skipped.lastError).toBeUndefined();
    expect(skipped.expiresIn).toBe(86400);
    expect(skipped.name).toBeUndefined();
    expect(skipped.providerSpecificData.uid).toBeUndefined();
  });
});

describe("pollForToken end to end", () => {
  it("runs activation after the token exchange and hands the mapped tokens to the route", async () => {
    const net = stubFetch({
      "/v2/plugin/auth/token": () => json(tokenOk),
      "/v2/plugin/login/account": () => json({ code: 0, data: { uid: "uid-acct", nickname: "Wen" } }),
      "/auth/realms/copilot/overseas/user/register": () => json({ code: 500, msg: "region required" }),
    });
    const result = await pollForToken("workbuddy", "st-1", null, undefined);

    expect(result.success).toBe(true);
    expect(net.calls.map((c) => c.path)).toEqual([
      "/v2/plugin/auth/token",
      "/v2/plugin/login/account",
      "/auth/realms/copilot/overseas/user/register",
    ]);
    expect(net.last("/auth/realms/copilot/overseas/user/register").search).toBe("?userId=uid-acct");
    expect(result.tokens.providerSpecificData).toMatchObject({ uid: "uid-acct", registerStatus: "region_required" });
    expect(result.tokens.lastError).toMatch(/no region yet/i);
  });

  it("stays pending while the user has not finished the browser login", async () => {
    stubFetch({ "/v2/plugin/auth/token": () => json({ code: 11217, msg: "login ing" }) });
    const result = await pollForToken("workbuddy", "st-1", null, undefined);
    expect(result).toMatchObject({ success: false, pending: true, error: "authorization_pending" });
  });
});

describe("wiring", () => {
  const read = (rel) => fs.readFileSync(path.resolve("..", rel), "utf-8");

  it("is a device-code, no-PKCE provider in the OAuth route and the modal", () => {
    const route = read("src/app/api/oauth/[provider]/[action]/route.js");
    expect(route).toMatch(/noPkceDeviceProviders = \[[^\]]*"workbuddy"/);
    expect(route).toMatch(/noPkceProviders = \[[^\]]*"workbuddy"/);
    expect(read("src/shared/components/OAuthModal.js")).toMatch(/deviceCodeProviders = \[[^\]]*"workbuddy"/);
  });

  it("has a connection test config (token present)", () => {
    expect(read("src/app/api/providers/[id]/test/testUtils.js")).toMatch(/workbuddy\s*:\s*\{\s*tokenExists\s*:\s*true\s*\}/);
  });

  it("is not enrolled in the daily CodeBuddy check-in (CN-only programme)", () => {
    const conn = { provider: "workbuddy", authType: "oauth", accessToken: "t", refreshToken: "r" };
    expect(selectCheckinConnections([conn])).toEqual([]);
    expect(selectCheckinConnections([{ ...conn, provider: "codebuddy-intl" }])).toHaveLength(1);
  });
});
