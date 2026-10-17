// CodeBuddy intl gateway answers 400 {"code":11128,"msg":"request illegal"}
// ("failed channel verification") unless every chat request carries fresh
// X-Conversation-* IDs, like the official client sends. Verified A/B against
// the live gateway: all three headers present -> 200, any subset -> 11128.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;

describe("CodeBuddyIntlExecutor conversation headers (#11128)", () => {
  const exec = new CodeBuddyIntlExecutor();
  const creds = { accessToken: "tok-abc" };

  it("adds X-Conversation-ID as a UUID v4", () => {
    const h = exec.buildHeaders(creds, true);
    expect(h["X-Conversation-ID"]).toMatch(UUID_V4);
  });

  it("adds X-Conversation-Request-ID and X-Conversation-Message-ID as 32 lowercase hex chars", () => {
    const h = exec.buildHeaders(creds, true);
    expect(h["X-Conversation-Request-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Message-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Request-ID"]).not.toBe(h["X-Conversation-Message-ID"]);
  });

  it("generates fresh values on every call", () => {
    const a = exec.buildHeaders(creds, true);
    const b = exec.buildHeaders(creds, true);
    for (const key of ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID"]) {
      expect(a[key]).toBeTruthy();
      expect(b[key]).toBeTruthy();
      expect(a[key]).not.toBe(b[key]);
    }
  });

  it("keeps the registry headers and bearer auth", () => {
    const h = exec.buildHeaders(creds, true);
    expect(h["x-codebuddy-request"]).toBe("1");
    expect(h["X-Product"]).toBe("SaaS");
    expect(h["Authorization"]).toBe("Bearer tok-abc");
    expect(h["Accept"]).toBe("text/event-stream");
  });

  it("prefers apiKey over accessToken for the bearer token", () => {
    const h = exec.buildHeaders({ apiKey: "key-xyz", accessToken: "tok-abc" }, true);
    expect(h["Authorization"]).toBe("Bearer key-xyz");
  });

  describe("on the real chat request path (execute)", () => {
    beforeEach(() => {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(new Response("data: [DONE]\n\n", { status: 200 }));
    });

    it("sends the conversation headers upstream, fresh per request", async () => {
      const args = {
        model: "glm-5.2",
        body: { messages: [{ role: "user", content: "hi" }] },
        stream: true,
        credentials: creds,
      };
      await exec.execute(args);
      await exec.execute(args);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [url1, opts1] = fetchMock.mock.calls[0];
      const [, opts2] = fetchMock.mock.calls[1];
      expect(url1).toBe("https://www.codebuddy.ai/v2/chat/completions");
      expect(opts1.headers["X-Conversation-ID"]).toMatch(UUID_V4);
      expect(opts1.headers["X-Conversation-Request-ID"]).toMatch(HEX32);
      expect(opts1.headers["X-Conversation-Message-ID"]).toMatch(HEX32);
      expect(opts2.headers["X-Conversation-ID"]).not.toBe(opts1.headers["X-Conversation-ID"]);
      expect(opts2.headers["X-Conversation-Request-ID"]).not.toBe(opts1.headers["X-Conversation-Request-ID"]);
    });
  });
});
