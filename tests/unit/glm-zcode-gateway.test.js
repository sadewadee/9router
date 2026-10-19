import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getTargetFormat, resolveTransport } from "../../open-sse/services/provider.js";
import { ZCODE_APP_VERSION } from "../../open-sse/providers/shared.js";

// glm (Z.ai GLM Coding Plan) goes through the official ZCode gateway with ZCode client
// headers so usage is billed at the ZCode Coding Plan rate, for openai and claude clients alike.
const GATEWAY_URL = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API_KEY = "dummy-key-0123456789";

// Mirror of chatCore: sourceFormat-matched transport (if any) is attached to credentials,
// then the executor builds url + headers from it.
function build(provider, sourceFormat) {
  const credentials = { apiKey: API_KEY };
  const runtimeTransport = resolveTransport(provider, sourceFormat);
  if (runtimeTransport) credentials.runtimeTransport = runtimeTransport;
  const executor = new DefaultExecutor(provider);
  const targetFormat = runtimeTransport?.format || getTargetFormat(provider, credentials);
  const url = executor.buildUrl("glm-5.3", true, 0, credentials);
  const headers = () => executor.buildHeaders(credentials, true, url, "glm-5.3", {});
  return { runtimeTransport, targetFormat, url, headers };
}

describe("glm routes through the ZCode gateway", () => {
  it("has no openai transport, so openai clients are translated to claude", () => {
    expect(resolveTransport("glm", "openai")).toBeNull();
    expect((PROVIDERS.glm.transports || []).map((t) => t.format)).toEqual(["claude"]);
  });

  for (const sourceFormat of ["openai", "claude"]) {
    describe(`sourceFormat ${sourceFormat}`, () => {
      it("targets claude format on the gateway URL (no ?beta=true, not coding/paas/v4)", () => {
        const { targetFormat, url } = build("glm", sourceFormat);
        expect(targetFormat).toBe("claude");
        expect(url).toBe(GATEWAY_URL);
      });

      it("sends x-api-key and Bearer Authorization with the same key", () => {
        const h = build("glm", sourceFormat).headers();
        expect(h["x-api-key"]).toBe(API_KEY);
        expect(h["Authorization"]).toBe(`Bearer ${API_KEY}`);
        expect(h["Anthropic-Version"]).toBe("2023-06-01");
      });

      it("sends the ZCode static client headers", () => {
        const h = build("glm", sourceFormat).headers();
        expect(ZCODE_APP_VERSION).toBe("3.16.1");
        expect(h["User-Agent"]).toBe(`ZCode/${ZCODE_APP_VERSION}`);
        expect(h["X-ZCode-App-Version"]).toBe(ZCODE_APP_VERSION);
        expect(h["X-ZCode-Agent"]).toBe("glm");
        expect(h["X-Title"]).toBe("Z Code@electron");
        expect(h["HTTP-Referer"]).toBe("https://zcode.z.ai");
        expect(h["X-Release-Channel"]).toBe("production");
        for (const k of ["X-Client-Language", "X-Client-Timezone", "X-Platform", "X-Os-Category", "X-Os-Version"]) {
          expect(h[k]).toBeTruthy();
        }
      });

      it("mints fresh x-request-id / x-zcode-trace-id / x-session-id on every call", () => {
        const { headers } = build("glm", sourceFormat);
        const a = headers();
        const b = headers();
        for (const k of ["x-request-id", "x-zcode-trace-id", "x-session-id"]) {
          expect(a[k]).toMatch(UUID_V4);
          expect(b[k]).toMatch(UUID_V4);
          expect(a[k]).not.toBe(b[k]);
        }
        expect(a["x-zcode-session-type"]).toBe("main");
      });
    });
  }

  it("keeps the usage monitor API on api.z.ai", () => {
    expect(PROVIDERS.glm.usage.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
  });

  it("leaves glm-cn untouched (openai coding/paas, no ZCode headers)", () => {
    for (const sourceFormat of ["openai", "claude"]) {
      const { runtimeTransport, targetFormat, url, headers } = build("glm-cn", sourceFormat);
      expect(runtimeTransport).toBeNull();
      expect(targetFormat).toBe("openai");
      expect(url).toBe("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions");
      const h = headers();
      expect(h["Authorization"]).toBe(`Bearer ${API_KEY}`);
      expect(h["User-Agent"]).toBeUndefined();
      expect(h["x-request-id"]).toBeUndefined();
    }
  });
});
