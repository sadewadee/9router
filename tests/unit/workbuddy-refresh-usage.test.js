// WorkBuddy token refresh + billing usage + registry data.
//   refresh: POST /v2/plugin/auth/token/refresh, token in X-Refresh-Token, desktop-client
//            headers (single-segment WorkBuddy/<version> UA, no machine/session ids)
//   usage:   POST workbuddy.ai /billing/meter/get-user-resource (bare path first, /v2 on 404),
//            the only call that carries the per-account X-Machine-ID / X-Session-ID
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: proxyFetchMock };
});

import { refreshWorkbuddyToken, getAccessToken } from "../../open-sse/services/tokenRefresh.js";
import { getWorkBuddyUsage, getCodeBuddyIntlUsage } from "../../open-sse/services/usage/codebuddy-cn.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const BASE = "https://www.workbuddy.ai";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const BILLING_UA = "WorkBuddy/5.8.4";
const BROWSER_ACCEPT = "application/json, text/plain, */*";
const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

let seq = 0;
const freshRefreshToken = () => `rt-${++seq}-${Math.random().toString(36).slice(2)}`; // dedupRefresh caches by token

describe("refreshWorkbuddyToken", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () => json({ code: 0, data: { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 5184000, domain: "www.workbuddy.ai" } }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs an empty JSON body to /v2/plugin/auth/token/refresh with the token in X-Refresh-Token", async () => {
    const rt = freshRefreshToken();
    const out = await refreshWorkbuddyToken(rt, { providerSpecificData: { uid: "uid-111" }, connectionId: "c1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v2/plugin/auth/token/refresh`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers["X-Refresh-Token"]).toBe(rt);
    expect(init.headers["X-Auth-Refresh-Source"]).toBe("plugin");
    expect(init.headers["Authorization"]).toBeUndefined();
    expect(out).toEqual({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 5184000 });
  });

  it("sends the desktop's non-chat headers: billing UA, browser Accept, realm and account identity", async () => {
    await refreshWorkbuddyToken(freshRefreshToken(), { providerSpecificData: { uid: "uid-111" } });
    const h = fetchMock.mock.calls[0][1].headers;
    expect(h["User-Agent"]).toBe(BILLING_UA);
    expect(h["Accept"]).toBe(BROWSER_ACCEPT);
    expect(h["Origin"]).toBe(BASE);
    expect(h["Referer"]).toBe(`${BASE}/`);
    expect(h["X-Domain"]).toBe("www.workbuddy.ai");
    expect(h["X-CodeBuddy-Request"]).toBe("1");
    expect(h["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(h["Accept-Language"]).toBe("en-US");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-User-Id"]).toBe("uid-111");
  });

  it("carries no machine/session ids, no agent headers and no enterprise marker for a personal account", async () => {
    await refreshWorkbuddyToken(freshRefreshToken(), { providerSpecificData: { uid: "uid-111" } });
    const h = fetchMock.mock.calls[0][1].headers;
    for (const key of ["X-Machine-ID", "X-Session-ID", "X-Device-Token", "X-Product", "X-IDE-Version", "X-Enterprise-Id", "X-No-Enterprise-Id"]) {
      expect(h[key], key).toBeUndefined();
    }
  });

  it("uses the stored account domain, adds X-Enterprise-Id for an enterprise account, and takes the uid from the token when needed", async () => {
    await refreshWorkbuddyToken(freshRefreshToken(), { accessToken: jwt({ sub: "uid-jwt" }) });
    await refreshWorkbuddyToken(freshRefreshToken(), { providerSpecificData: { uid: "uid-e", domain: "ent.workbuddy.ai", enterpriseId: "ent-42" } });
    const [a, b] = fetchMock.mock.calls.map(([, init]) => init.headers);
    expect(a["X-User-Id"]).toBe("uid-jwt");
    expect(b["X-Domain"]).toBe("ent.workbuddy.ai");
    expect(b["X-Enterprise-Id"]).toBe("ent-42");
  });

  it("follows WORKBUDDY_CLIENT_VERSION for the UA, with no rebuild", async () => {
    const before = process.env.WORKBUDDY_CLIENT_VERSION;
    process.env.WORKBUDDY_CLIENT_VERSION = "5.9.1";
    try {
      await refreshWorkbuddyToken(freshRefreshToken(), { providerSpecificData: { uid: "uid-111" } });
    } finally {
      if (before === undefined) delete process.env.WORKBUDDY_CLIENT_VERSION;
      else process.env.WORKBUDDY_CLIENT_VERSION = before;
    }
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("WorkBuddy/5.9.1");
  });

  it("keeps the old refresh token when the response carries none", async () => {
    fetchMock.mockImplementation(async () => json({ code: 0, data: { accessToken: "new-access" } }));
    const rt = freshRefreshToken();
    expect(await refreshWorkbuddyToken(rt, {})).toEqual({ accessToken: "new-access", refreshToken: rt, expiresIn: undefined });
  });

  it("returns null on an HTTP error, a business error or an empty token", async () => {
    const log = { error: vi.fn(), info: vi.fn() };
    fetchMock.mockImplementationOnce(async () => new Response("expired", { status: 401 }));
    expect(await refreshWorkbuddyToken(freshRefreshToken(), {}, log)).toBeNull();
    fetchMock.mockImplementationOnce(async () => json({ code: 11003, msg: "invalid refresh token" }));
    expect(await refreshWorkbuddyToken(freshRefreshToken(), {}, log)).toBeNull();
    fetchMock.mockImplementationOnce(async () => json({ code: 0, data: {} }));
    expect(await refreshWorkbuddyToken(freshRefreshToken(), {}, log)).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(3);
  });

  it("does nothing without a refresh token", async () => {
    expect(await refreshWorkbuddyToken("", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is what the generic refresh dispatcher runs for the workbuddy provider", async () => {
    const out = await getAccessToken("workbuddy", { refreshToken: freshRefreshToken(), providerSpecificData: { uid: "uid-111" } });
    expect(out.accessToken).toBe("new-access");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v2/plugin/auth/token/refresh`);
    expect(fetchMock.mock.calls[0][1].headers["X-User-Id"]).toBe("uid-111");
  });
});

describe("getWorkBuddyUsage", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  const account = (extra) => ({
    PackageName: "Free Plan",
    CycleStartTime: "2026-10-01 00:00:00",
    CycleEndTime: "2026-11-01 00:00:00",
    DeductionEndTime: 1830000000000,
    CycleCapacitySize: 500,
    CycleCapacityUsed: 120.5,
    ...extra,
  });
  const billing = (accounts) => json({ code: 0, data: { Response: { Data: { Accounts: accounts } } } });
  const tokenArg = jwt({ sub: "uid-jwt" });

  it("POSTs the client's package filter to the bare billing path with the desktop's billing headers", async () => {
    proxyFetchMock.mockImplementation(async () => billing([account()]));
    await getWorkBuddyUsage(tokenArg, null, { uid: "uid-111" }, { strictProxy: false });

    expect(proxyFetchMock).toHaveBeenCalledTimes(1);
    const [url, init, proxyOptions] = proxyFetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/billing/meter/get-user-resource`);
    expect(init.method).toBe("POST");
    expect(proxyOptions).toEqual({ strictProxy: false });
    expect(init.headers["Authorization"]).toBe(`Bearer ${tokenArg}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Accept"]).toBe(BROWSER_ACCEPT);
    expect(init.headers["User-Agent"]).toBe(BILLING_UA);
    expect(init.headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(init.headers["Origin"]).toBe(BASE);
    expect(init.headers["Referer"]).toBe(`${BASE}/`);
    expect(init.headers["X-User-Id"]).toBe("uid-111");
    expect(init.headers["X-Domain"]).toBe("www.workbuddy.ai");
    expect(init.headers["X-CodeBuddy-Request"]).toBe("1");
    expect(init.headers["Accept-Language"]).toBe("en-US");
    expect(init.headers["X-Request-ID"]).toMatch(HEX32);
    expect(init.headers["X-No-Enterprise-Id"]).toBe("1");

    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3] });
    expect(body.PackageEndTimeRangeBegin).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(body.PackageEndTimeRangeEnd > body.PackageEndTimeRangeBegin).toBe(true);
  });

  it("sends a UUID-shaped X-Machine-ID / X-Session-ID, stable per account and different across accounts", async () => {
    proxyFetchMock.mockImplementation(async () => billing([account()]));
    await getWorkBuddyUsage(tokenArg, null, { uid: "uid-111" }, null);
    await getWorkBuddyUsage(tokenArg, null, { uid: "uid-111" }, null);
    await getWorkBuddyUsage(tokenArg, null, { uid: "uid-222" }, null);
    const [a1, a2, b] = proxyFetchMock.mock.calls.map(([, init]) => init.headers);
    expect(a1["X-Machine-ID"]).toMatch(UUID_V4);
    expect(a1["X-Session-ID"]).toMatch(UUID_V4);
    expect(a1["X-Machine-ID"]).not.toBe(a1["X-Session-ID"]);
    expect(a2["X-Machine-ID"]).toBe(a1["X-Machine-ID"]);
    expect(a2["X-Session-ID"]).toBe(a1["X-Session-ID"]);
    expect(b["X-Machine-ID"]).not.toBe(a1["X-Machine-ID"]);
    expect(b["X-Session-ID"]).not.toBe(a1["X-Session-ID"]);
    expect(a2["X-Request-ID"]).not.toBe(a1["X-Request-ID"]);
  });

  it("seeds the ids from the access token's sub when the uid was not stored", async () => {
    proxyFetchMock.mockImplementation(async () => billing([account()]));
    await getWorkBuddyUsage(tokenArg, null, {}, null);
    await getWorkBuddyUsage("opaque-token", null, {}, null);
    const [fromJwt, opaque] = proxyFetchMock.mock.calls.map(([, init]) => init.headers);
    expect(fromJwt["X-User-Id"]).toBe("uid-jwt");
    expect(fromJwt["X-Machine-ID"]).toMatch(UUID_V4);
    expect(opaque["X-User-Id"]).toBeUndefined();
    expect(opaque["X-Machine-ID"]).toBeUndefined();
    expect(opaque["X-Session-ID"]).toBeUndefined();
  });

  it("adds the enterprise headers instead of X-No-Enterprise-Id for an enterprise account, with the stored domain", async () => {
    proxyFetchMock.mockImplementation(async () => billing([account()]));
    await getWorkBuddyUsage(tokenArg, null, { uid: "uid-e", domain: "ent.workbuddy.ai", enterpriseId: "ent-42" }, null);
    const h = proxyFetchMock.mock.calls[0][1].headers;
    expect(h["X-Enterprise-Id"]).toBe("ent-42");
    expect(h["X-Tenant-Id"]).toBe("ent-42");
    expect(h["X-No-Enterprise-Id"]).toBeUndefined();
    expect(h["X-Domain"]).toBe("ent.workbuddy.ai");
  });

  it("follows WORKBUDDY_CLIENT_VERSION for the billing UA", async () => {
    proxyFetchMock.mockImplementation(async () => billing([account()]));
    const before = process.env.WORKBUDDY_CLIENT_VERSION;
    process.env.WORKBUDDY_CLIENT_VERSION = "5.9.1";
    try {
      await getWorkBuddyUsage(tokenArg, null, { uid: "uid-111" }, null);
    } finally {
      if (before === undefined) delete process.env.WORKBUDDY_CLIENT_VERSION;
      else process.env.WORKBUDDY_CLIENT_VERSION = before;
    }
    expect(proxyFetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("WorkBuddy/5.9.1");
  });

  it("falls back to the /v2 billing path when the bare one answers 404", async () => {
    proxyFetchMock
      .mockImplementationOnce(async () => new Response("not found", { status: 404 }))
      .mockImplementationOnce(async () => billing([account()]));
    const out = await getWorkBuddyUsage(tokenArg, null, {}, null);

    expect(proxyFetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/billing/meter/get-user-resource`,
      `${BASE}/v2/billing/meter/get-user-resource`,
    ]);
    expect(out.plan).toBe("Free Plan");
  });

  it("does not retry other failures and labels the messages WorkBuddy", async () => {
    proxyFetchMock.mockImplementationOnce(async () => new Response("no", { status: 401 }));
    expect(await getWorkBuddyUsage(tokenArg, null, {}, null)).toEqual({ message: "WorkBuddy credential invalid or expired." });
    proxyFetchMock.mockImplementationOnce(async () => new Response("boom", { status: 500 }));
    expect(await getWorkBuddyUsage(tokenArg, null, {}, null)).toEqual({ message: "WorkBuddy quota API error (500)." });
    proxyFetchMock.mockImplementationOnce(async () => json({ code: 14018, msg: "Credits exhausted" }));
    expect(await getWorkBuddyUsage(tokenArg, null, {}, null)).toEqual({ message: "WorkBuddy quota error: Credits exhausted" });
    proxyFetchMock.mockImplementationOnce(async () => billing([]));
    expect(await getWorkBuddyUsage(tokenArg, null, {}, null)).toEqual({ message: "WorkBuddy connected. No credit package found." });
    expect(proxyFetchMock).toHaveBeenCalledTimes(4);
    expect(await getWorkBuddyUsage("", null, {}, null)).toEqual({ message: "CodeBuddy (workbuddy) credential not available." });
  });

  it("reports refill and bonus packs with the shared CodeBuddy package logic", async () => {
    proxyFetchMock.mockImplementation(async () => billing([
      account(),
      account({ PackageName: "Bonus", CycleEndTime: "2026-10-30 00:00:00", DeductionEndTime: Date.parse("2026-10-30T00:00:00Z"), CapacitySize: 100, CapacityUsed: 10, CycleCapacitySize: 0 }),
    ]));
    const out = await getWorkBuddyUsage(tokenArg, null, {}, null);
    expect(out.plan).toBe("Free Plan");
    expect(out.quotas.Monthly).toMatchObject({ used: 120.5, total: 500, recurring: true });
    expect(out.quotas["Bonus Pack 1"]).toMatchObject({ used: 10, total: 100, recurring: false });
  });

  it("leaves the codebuddy-intl usage request untouched", async () => {
    proxyFetchMock
      .mockImplementationOnce(async () => billing([account()]))
      .mockImplementationOnce(async () => new Response("no", { status: 401 }));
    await getCodeBuddyIntlUsage("tok", null, {}, null);
    const [url, init] = proxyFetchMock.mock.calls[0];
    expect(url).toBe("https://www.codebuddy.ai/v2/billing/meter/get-user-resource");
    expect(init.body).toBe("{}");
    expect(init.headers["User-Agent"]).toBe("IDE/2.108.1 CodeBuddy/2.108.1");
    expect(await getCodeBuddyIntlUsage("tok", null, {}, null)).toEqual({ message: "CodeBuddy CN credential invalid or expired." });
  });
});

describe("workbuddy registry data", () => {
  const models = PROVIDER_MODELS.wb;

  it("registers the provider with alias wb, forced stream and the global chat endpoint", () => {
    expect(PROVIDERS.workbuddy.baseUrl).toBe(`${BASE}/v2/chat/completions`);
    expect(PROVIDERS.workbuddy.forceStream).toBe(true);
    expect(PROVIDERS.workbuddy.thinkingFormat).toBe("openai");
    expect(PROVIDER_OAUTH.workbuddy.refreshUrl).toBe(`${BASE}/v2/plugin/auth/token/refresh`);
  });

  it("lists the 22 live-verified global models, free default-model first, no duplicates", () => {
    const ids = models.map((m) => m.id);
    expect(ids).toHaveLength(22);
    expect(new Set(ids).size).toBe(22);
    expect(ids[0]).toBe("default-model");
    for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.3-codex", "deepseek-v4.1-flash", "glm-5.3", "kimi-k2.8-preview", "hy4-preview-f", "gemini-3.5-flash"]) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain("auto");
  });

  it("has capabilities for every listed model (limits from the global catalog)", () => {
    for (const { id } of models) {
      const caps = getCapabilitiesForModel("workbuddy", id);
      expect(caps.contextWindow, id).toBeGreaterThanOrEqual(176000);
      expect(caps.maxOutput, id).toBeGreaterThan(0);
      expect(caps.vision, id).toBe(true);
    }
    expect(getCapabilitiesForModel("workbuddy", "deep-model").reasoning).toBe(false);
    expect(getCapabilitiesForModel("workbuddy", "deepseek-v4.1-flash")).toMatchObject({ reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 });
  });

  it("offers only the effort levels the global gateway accepts", () => {
    expect(getThinkingLevels("workbuddy", "deepseek-v4.1-flash")).toEqual(["high"]);
    expect(getThinkingLevels("workbuddy", "gpt-5.3-codex")).toEqual(["medium"]);
    expect(getThinkingLevels("workbuddy", "gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("workbuddy", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("workbuddy", "hy3")).toEqual(["low", "high"]);
    expect(getThinkingLevels("workbuddy", "hy4-preview-f")).toEqual(["high"]);
    expect(getThinkingLevels("workbuddy", "deep-model")).toBeNull();
  });

  it("does not change the codebuddy providers' levels or capabilities", () => {
    expect(getThinkingLevels("codebuddy-cn", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getCapabilitiesForModel("codebuddy-intl", "deepseek-v4.1-flash").thinkingCanDisable).toBe(true);
  });
});
