// OpenCode's free gateway (opencode.ai/inference/v1) load-balances GLM across
// backends and some are strict decoders that reject the unknown field
// `thinking` ("[unknown_parameter] ... unknown field \"thinking\"", HTTP 400).
// The generic *glm-5.3* pattern resolves to the z.ai format (thinking +
// reasoning_effort), so the opencode provider pins GLM to the openai format
// (reasoning_effort only). Verified 2026-10-18.
import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const MODEL = "glm-5.3-flash-free";
const messages = [{ role: "user", content: "hi" }];

describe("opencode GLM thinking format", () => {
  it("resolves glm-5.3-flash-free to the openai thinking format", () => {
    expect(getCapabilitiesForModel("opencode", MODEL)).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 1000000,
      maxOutput: 32000,
    });
    // vendor-prefixed ids resolve through the same exact override
    expect(getCapabilitiesForModel("opencode", `oc/${MODEL}`).thinkingFormat).toBe("openai");
  });

  it("sends reasoning_effort only, never thinking/enable_thinking", () => {
    const body = { reasoning_effort: "high", messages };
    applyThinking("openai", MODEL, body, "opencode");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body.reasoning_effort).toBe("high");
  });

  it("drops a client-sent thinking block instead of forwarding it", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 4096 }, messages };
    applyThinking("openai", MODEL, body, "opencode");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("keeps the z.ai thinking field for GLM on other providers (regression guard)", () => {
    for (const provider of [null, "glm"]) {
      const body = { reasoning_effort: "high", messages };
      applyThinking("openai", MODEL, body, provider);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
    }
  });

  it("does not change other opencode models", () => {
    // deepseek-v4.1-flash-free is capped on purpose (capabilities.test.js), so it is not in this list.
    for (const model of ["big-pickle", "space-bunny-free", "glm-5.3"]) {
      expect(getCapabilitiesForModel("opencode", model)).toEqual(getCapabilitiesForModel(null, model));
    }
  });
});
