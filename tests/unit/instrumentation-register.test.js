// src/instrumentation.js register() is the one hook that reliably runs at boot in
// the standalone/Docker server (initializeApp's heavy startup never fires there),
// so it must start the CodeBuddy check-in scheduler and must never throw.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/consoleLogBuffer", () => ({ initConsoleLogCapture: vi.fn() }));
vi.mock("open-sse/providers/catalogOverride.js", () => ({ installCatalogSource: vi.fn(async () => {}) }));
vi.mock("@/lib/modelCatalog/sync.js", () => ({ startModelCatalogSync: vi.fn() }));
vi.mock("@/sse/services/codebuddyCheckin.js", () => ({ startCodebuddyCheckin: startMock }));

let logSpy;
beforeEach(() => {
  startMock.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation register()", () => {
  it("starts the check-in scheduler on the nodejs runtime", async () => {
    const { register } = await import("../../src/instrumentation.js");
    await register();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("does not start it on other runtimes", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const { register } = await import("../../src/instrumentation.js");
    await register();
    expect(startMock).not.toHaveBeenCalled();
  });

  it("logs and swallows a scheduler start failure instead of throwing out of register()", async () => {
    startMock.mockImplementation(() => { throw new Error("boom"); });
    const { register } = await import("../../src/instrumentation.js");
    await expect(register()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith("[CodebuddyCheckin] scheduler start failed:", "boom");
  });

  it("logs and swallows a failure to even load the scheduler module", async () => {
    vi.resetModules();
    vi.doMock("@/sse/services/codebuddyCheckin.js", () => { throw new Error("import boom"); });
    try {
      const { register } = await import("../../src/instrumentation.js");
      await expect(register()).resolves.toBeUndefined();
      // vitest rewraps the factory error, so assert on the tag + that nothing was started
      expect(logSpy.mock.calls.some(([tag, msg]) => tag === "[CodebuddyCheckin] scheduler start failed:" && typeof msg === "string" && msg.length > 0)).toBe(true);
      expect(startMock).not.toHaveBeenCalled();
    } finally {
      vi.doMock("@/sse/services/codebuddyCheckin.js", () => ({ startCodebuddyCheckin: startMock }));
    }
  });
});
