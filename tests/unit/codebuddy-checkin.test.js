// Daily check-in scheduler for CodeBuddy OAuth connections. Upstream shape
// (verified against the live intl gateway): POST /v2/billing/meter/checkin-status
// -> {code:0,data:{active,today_checked_in,daily_credit,...}}; only when
// active && !today_checked_in do we POST /v2/billing/meter/daily-checkin.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const repoMock = vi.hoisted(() => ({ getProviderConnections: vi.fn() }));
vi.mock("../../src/lib/db/repos/connectionsRepo.js", () => repoMock);

import {
  checkinConnection,
  isCheckinEnabled,
  runCodebuddyCheckinTick,
  selectCheckinConnections,
  startCodebuddyCheckin,
  stopCodebuddyCheckin,
} from "../../src/sse/services/codebuddyCheckin.js";

const STATUS = "/v2/billing/meter/checkin-status";
const CHECKIN = "/v2/billing/meter/daily-checkin";

const conn = (overrides = {}) => ({
  id: "c1",
  provider: "codebuddy-intl",
  authType: "oauth",
  name: "acct-one",
  accessToken: "tok-old",
  refreshToken: "rt-1",
  isActive: false, // exhausted accounts are auto-deactivated; they must still check in
  providerSpecificData: {},
  ...overrides,
});

const statusBody = (data) => ({ code: 0, msg: "OK", data });
const ACTIVE_OPEN = statusBody({ active: true, today_checked_in: false, daily_credit: 20 });

// Scripted upstream: routes[path] is a list of { status?, body } consumed in order (last one repeats).
function makeUpstream(routes) {
  const queues = Object.fromEntries(Object.entries(routes).map(([path, list]) => [path, [...list]]));
  const calls = [];
  const fetchFn = vi.fn(async (url, init, proxyOptions) => {
    const path = new URL(url).pathname;
    calls.push({ url, path, init, proxyOptions });
    const queue = queues[path];
    const entry = queue.length > 1 ? queue.shift() : queue[0];
    if (entry.throws) throw new Error(entry.throws);
    const text = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
    return new Response(text, { status: entry.status ?? 200 });
  });
  return { fetchFn, calls, paths: () => calls.map((c) => c.path) };
}

const baseDeps = (upstream, extra = {}) => ({
  fetch: upstream.fetchFn,
  sleep: async () => {},
  resolveProxyOptions: async () => ({ connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "", vercelRelayUrl: "", strictProxy: false }),
  refreshAccessToken: vi.fn(async () => null),
  ...extra,
});

let logSpy;
let warnSpy;
beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  repoMock.getProviderConnections.mockReset();
  repoMock.getProviderConnections.mockResolvedValue([]);
});
afterEach(() => {
  stopCodebuddyCheckin();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const logLines = () => [...logSpy.mock.calls, ...warnSpy.mock.calls].map((args) => args.join(" "));

describe("selectCheckinConnections", () => {
  it("keeps every CodeBuddy OAuth connection, including inactive ones", () => {
    const list = [
      conn({ id: "a", isActive: false }),
      conn({ id: "b", provider: "codebuddy-cn", isActive: true }),
      conn({ id: "c", authType: "apikey" }),
      conn({ id: "d", provider: "claude" }),
      conn({ id: "e", accessToken: null, refreshToken: null }),
      conn({ id: "f", accessToken: null, refreshToken: "rt" }),
      null,
    ];
    expect(selectCheckinConnections(list).map((c) => c.id)).toEqual(["a", "b", "f"]);
    expect(selectCheckinConnections(undefined)).toEqual([]);
  });
});

describe("checkinConnection", () => {
  it("inactive campaign: status call only, no daily-checkin", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: false, today_checked_in: false, daily_credit: 0 }) }] });
    const out = await checkinConnection(conn(), baseDeps(up));
    expect(up.paths()).toEqual([STATUS]);
    expect(out).toMatchObject({ action: "inactive-campaign", code: 0 });
  });

  it("active and not checked in today: exactly one daily-checkin call", async () => {
    const up = makeUpstream({
      [STATUS]: [{ body: ACTIVE_OPEN }],
      [CHECKIN]: [{ body: { code: 0, msg: "OK", data: { credit: 20 } } }],
    });
    const out = await checkinConnection(conn(), baseDeps(up));
    expect(up.paths()).toEqual([STATUS, CHECKIN]);
    expect(out).toMatchObject({ action: "checked-in", code: 0, msg: "OK", credit: 20 });
  });

  it("falls back to the status daily_credit when the check-in response carries no amount", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: ACTIVE_OPEN }], [CHECKIN]: [{ body: { code: 0, msg: "OK", data: null } }] });
    expect((await checkinConnection(conn(), baseDeps(up))).credit).toBe(20);
  });

  it("already checked in today: no daily-checkin call", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: true, today_checked_in: true }) }] });
    const out = await checkinConnection(conn(), baseDeps(up));
    expect(up.paths()).toEqual([STATUS]);
    expect(out.action).toBe("already-checked-in");
  });

  it("does not check in when the status flags are missing or unknown", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: true }) }] });
    expect((await checkinConnection(conn(), baseDeps(up))).action).toBe("not-eligible");
    expect(up.paths()).toEqual([STATUS]);
  });

  it("reports a non-zero daily-checkin code without retrying it", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: ACTIVE_OPEN }], [CHECKIN]: [{ body: { code: 10001, msg: "already checked in", data: null } }] });
    const out = await checkinConnection(conn(), baseDeps(up));
    expect(up.paths()).toEqual([STATUS, CHECKIN]);
    expect(out).toMatchObject({ action: "checkin-error", code: 10001, msg: "already checked in", credit: null });
  });

  it("reports status errors (HTTP error, business error, non-JSON) and never checks in", async () => {
    for (const entry of [{ status: 500, body: "boom" }, { body: { code: 11148, msg: "upstream error" } }, { body: "<html>" }]) {
      const up = makeUpstream({ [STATUS]: [entry] });
      const out = await checkinConnection(conn(), baseDeps(up));
      expect(out.action).toBe("status-error");
      expect(up.paths()).toEqual([STATUS]);
    }
  });

  it("401: refreshes once, retries the call once with the new token, then continues", async () => {
    const up = makeUpstream({
      [STATUS]: [{ status: 401, body: { code: 401, msg: "expired" } }, { body: ACTIVE_OPEN }],
      [CHECKIN]: [{ body: { code: 0, msg: "OK", data: {} } }],
    });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => "tok-new") });
    const out = await checkinConnection(conn(), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.paths()).toEqual([STATUS, STATUS, CHECKIN]);
    expect(up.calls.map((c) => c.init.headers.Authorization)).toEqual(["Bearer tok-old", "Bearer tok-new", "Bearer tok-new"]);
    expect(out.action).toBe("checked-in");
  });

  it("401 that survives the refresh: one refresh, one retry, no loop, no check-in", async () => {
    const up = makeUpstream({ [STATUS]: [{ status: 401, body: { code: 401, msg: "expired" } }] });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => "tok-new") });
    const out = await checkinConnection(conn(), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.paths()).toEqual([STATUS, STATUS]);
    expect(out.action).toBe("auth-failed");
  });

  it("401 with a failed refresh: no retry", async () => {
    const up = makeUpstream({ [STATUS]: [{ status: 401, body: {} }] });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => null) });
    const out = await checkinConnection(conn(), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.paths()).toEqual([STATUS]);
    expect(out.action).toBe("auth-failed");
  });

  it("spends at most one refresh per connection: a later 401 after the refresh is not refreshed again", async () => {
    const up = makeUpstream({
      [STATUS]: [{ status: 401, body: {} }, { body: ACTIVE_OPEN }],
      [CHECKIN]: [{ status: 401, body: {} }],
    });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => "tok-new") });
    const out = await checkinConnection(conn(), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.paths()).toEqual([STATUS, STATUS, CHECKIN]);
    expect(out.action).toBe("auth-failed");
  });

  it("401 on daily-checkin itself: refresh once, retry once with the new token", async () => {
    const up = makeUpstream({
      [STATUS]: [{ body: ACTIVE_OPEN }],
      [CHECKIN]: [{ status: 401, body: {} }, { body: { code: 0, msg: "OK", data: {} } }],
    });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => "tok-new") });
    const out = await checkinConnection(conn(), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.paths()).toEqual([STATUS, CHECKIN, CHECKIN]);
    expect(up.calls[2].init.headers.Authorization).toBe("Bearer tok-new");
    expect(out.action).toBe("checked-in");
  });

  it("mints an access token first when the connection only has a refresh token", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: false }) }] });
    const deps = baseDeps(up, { refreshAccessToken: vi.fn(async () => "tok-minted") });
    await checkinConnection(conn({ accessToken: null }), deps);
    expect(deps.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(up.calls[0].init.headers.Authorization).toBe("Bearer tok-minted");
  });

  it.each([
    ["codebuddy-cn", "https://copilot.tencent.com", "copilot.tencent.com", "CLI"],
    ["codebuddy-intl", "https://www.codebuddy.ai", "www.codebuddy.ai", "IDE"],
  ])("%s: POSTs an empty JSON body to the provider's billing host with registry headers + X-Domain", async (provider, base, domain, ideType) => {
    const up = makeUpstream({ [STATUS]: [{ body: ACTIVE_OPEN }], [CHECKIN]: [{ body: { code: 0, data: {} } }] });
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local:3128", connectionNoProxy: "", vercelRelayUrl: "", strictProxy: false };
    await checkinConnection(conn({ provider }), baseDeps(up, { resolveProxyOptions: async () => proxy }));
    expect(up.calls.map((c) => c.url)).toEqual([`${base}${STATUS}`, `${base}${CHECKIN}`]);
    for (const call of up.calls) {
      expect(call.init.method).toBe("POST");
      expect(call.init.body).toBe("{}");
      expect(call.init.headers).toMatchObject({
        Authorization: "Bearer tok-old",
        "Content-Type": "application/json",
        "X-Domain": domain,
        "X-Product": "SaaS",
        "X-IDE-Type": ideType,
        "x-codebuddy-request": "1",
      });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(call.proxyOptions).toEqual(proxy); // routed through the connection's proxy, like the usage service
    }
  });
});

describe("runCodebuddyCheckinTick", () => {
  it("logs one concise line per connection and never logs tokens", async () => {
    const up = makeUpstream({
      [STATUS]: [{ body: ACTIVE_OPEN }],
      [CHECKIN]: [{ body: { code: 0, msg: "OK", data: { credit: 20 } } }],
    });
    await runCodebuddyCheckinTick(baseDeps(up, { loadConnections: async () => [conn({ accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH" })] }));
    const lines = logLines().filter((l) => l.includes("CODEBUDDY_CHECKIN"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("conn=acct-one");
    expect(lines[0]).toContain("provider=codebuddy-intl");
    expect(lines[0]).toContain("action=checked-in");
    expect(lines[0]).toContain("credit=20");
    expect(lines[0]).toContain("code=0");
    expect(lines[0]).toContain('msg="OK"');
    expect(logLines().join("\n")).not.toMatch(/SECRET-ACCESS|SECRET-REFRESH/);
  });

  it("includes inactive connections and skips apikey / other providers", async () => {
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: false }) }] });
    const results = await runCodebuddyCheckinTick(baseDeps(up, {
      loadConnections: async () => [
        conn({ id: "inactive", isActive: false }),
        conn({ id: "cn", provider: "codebuddy-cn", isActive: true }),
        conn({ id: "key", authType: "apikey" }),
        conn({ id: "other", provider: "claude" }),
      ],
    }));
    expect(results.map((r) => r.id)).toEqual(["inactive", "cn"]);
    expect(up.calls).toHaveLength(2);
  });

  it("one connection throwing (network error) does not stop the others or the tick", async () => {
    const calls = [];
    const fetchFn = vi.fn(async (url, init) => {
      calls.push(init.headers.Authorization);
      if (init.headers.Authorization === "Bearer boom") throw new Error("socket hang up");
      return new Response(JSON.stringify(ACTIVE_OPEN), { status: 200 });
    });
    const checkinCalls = [];
    const wrapped = vi.fn(async (url, init, proxy) => {
      if (url.endsWith(CHECKIN)) {
        checkinCalls.push(init.headers.Authorization);
        return new Response(JSON.stringify({ code: 0, msg: "OK", data: {} }), { status: 200 });
      }
      return fetchFn(url, init, proxy);
    });
    const results = await runCodebuddyCheckinTick({
      fetch: wrapped,
      sleep: async () => {},
      resolveProxyOptions: async () => ({}),
      loadConnections: async () => [
        conn({ id: "a", accessToken: "boom", name: "bad" }),
        conn({ id: "b", accessToken: "fine", name: "good" }),
      ],
    });
    expect(results.map((r) => [r.id, r.outcome.action])).toEqual([["a", "error"], ["b", "checked-in"]]);
    expect(checkinCalls).toEqual(["Bearer fine"]);
    expect(logLines().some((l) => l.includes("conn=bad") && l.includes("action=error") && l.includes("socket hang up"))).toBe(true);
  });

  it("swallows a failing connection loader and still resolves", async () => {
    const results = await runCodebuddyCheckinTick({ loadConnections: async () => { throw new Error("db down"); } });
    expect(results).toEqual([]);
    expect(logLines().some((l) => l.includes("Tick failed") && l.includes("db down"))).toBe(true);
  });

  it("never runs when CODEBUDDY_AUTO_CHECKIN=false", async () => {
    const loadConnections = vi.fn(async () => [conn()]);
    const up = makeUpstream({ [STATUS]: [{ body: ACTIVE_OPEN }] });
    for (const value of ["false", "0", "no", "off", "FALSE"]) {
      expect(await runCodebuddyCheckinTick(baseDeps(up, { loadConnections, env: { CODEBUDDY_AUTO_CHECKIN: value } }))).toBeNull();
    }
    expect(loadConnections).not.toHaveBeenCalled();
    expect(up.calls).toHaveLength(0);
  });

  it("ticks never overlap", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const up = makeUpstream({ [STATUS]: [{ body: statusBody({ active: false }) }] });
    const slowFetch = vi.fn(async (...args) => { await gate; return up.fetchFn(...args); });
    const first = runCodebuddyCheckinTick(baseDeps(up, { fetch: slowFetch, loadConnections: async () => [conn()] }));
    await vi.waitFor(() => expect(slowFetch).toHaveBeenCalledTimes(1));
    const second = await runCodebuddyCheckinTick(baseDeps(up, { loadConnections: async () => [conn()] }));
    expect(second).toBeNull();
    release();
    expect(await first).toHaveLength(1);
    // the guard is released afterwards
    expect(await runCodebuddyCheckinTick(baseDeps(up, { loadConnections: async () => [] }))).toEqual([]);
  });
});

describe("scheduler (startCodebuddyCheckin)", () => {
  it("isCheckinEnabled: enabled by default, disabled by false/0/no/off", () => {
    expect(isCheckinEnabled({})).toBe(true);
    expect(isCheckinEnabled({ CODEBUDDY_AUTO_CHECKIN: "true" })).toBe(true);
    expect(isCheckinEnabled({ CODEBUDDY_AUTO_CHECKIN: "false" })).toBe(false);
    expect(isCheckinEnabled({ CODEBUDDY_AUTO_CHECKIN: " Off " })).toBe(false);
  });

  it("does not start (no timers at all) when disabled via env", () => {
    vi.useFakeTimers();
    vi.stubEnv("CODEBUDDY_AUTO_CHECKIN", "false");
    expect(startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 10 })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(repoMock.getProviderConnections).not.toHaveBeenCalled();
  });

  it("runs a first tick shortly after start, then every interval; start is idempotent", async () => {
    vi.useFakeTimers();
    expect(startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 })).toBe(true);
    expect(startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 })).toBe(false);
    const ticks = () => repoMock.getProviderConnections.mock.calls.length / 2; // one query per CodeBuddy provider
    expect(ticks()).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(ticks()).toBe(1);
    await vi.advanceTimersByTimeAsync(950);
    expect(ticks()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks()).toBe(3);
    const providers = repoMock.getProviderConnections.mock.calls.map(([filter]) => filter.provider);
    expect(new Set(providers)).toEqual(new Set(["codebuddy-cn", "codebuddy-intl"]));
    // no isActive filter: exhausted (auto-deactivated) accounts are loaded too
    expect(repoMock.getProviderConnections.mock.calls.every(([filter]) => !("isActive" in filter))).toBe(true);
    stopCodebuddyCheckin();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs one line with the interval and first delay when it actually starts", () => {
    vi.useFakeTimers();
    expect(startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 })).toBe(true);
    startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 }); // no-op, no second line
    const started = logLines().filter((l) => l.includes("Scheduler started"));
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("CODEBUDDY_CHECKIN");
    expect(started[0]).toContain("first tick in 50ms");
    expect(started[0]).toContain("every 1000ms");
  });

  it("logs the default interval (6h) and first delay (30s) when started without options", () => {
    vi.useFakeTimers();
    startCodebuddyCheckin();
    expect(logLines().some((l) => l.includes("first tick in 30000ms, then every 21600000ms"))).toBe(true);
  });

  it("does not log a start line when disabled", () => {
    vi.stubEnv("CODEBUDDY_AUTO_CHECKIN", "false");
    startCodebuddyCheckin();
    expect(logLines().some((l) => l.includes("Scheduler started"))).toBe(false);
  });

  it("is idempotent across separate module instances (instrumentation + initializeApp both start it)", async () => {
    vi.useFakeTimers();
    expect(startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 })).toBe(true);

    vi.resetModules(); // a fresh copy of the module, as a second bundle would load it
    const second = await import("../../src/sse/services/codebuddyCheckin.js");
    expect(second.startCodebuddyCheckin).not.toBe(startCodebuddyCheckin);
    expect(second.startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 50 })).toBe(false);

    expect(vi.getTimerCount()).toBe(2); // one initial timeout + one interval, not four
    expect(logLines().filter((l) => l.includes("Scheduler started"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(repoMock.getProviderConnections.mock.calls.length).toBe(2); // exactly one tick (one query per provider)

    second.stopCodebuddyCheckin(); // state is shared, so either instance can stop it
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejecting tick never kills the interval", async () => {
    vi.useFakeTimers();
    repoMock.getProviderConnections.mockRejectedValue(new Error("db down"));
    startCodebuddyCheckin({ intervalMs: 1000, initialDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repoMock.getProviderConnections.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
