// CodeBuddy CN + INTL: the client's system prompt is desensitized (zero-width
// spaces inside filter keywords) instead of replaced/dropped. If the upstream
// still rejects the request as a content-filter violation, execute() re-sends
// it exactly once with the legacy transform.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../open-sse/utils/proxyFetch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, proxyAwareFetch: fetchMock };
});

import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor, buildIntlMessages } from "../../open-sse/executors/codebuddy-intl.js";
import {
  matchesContentFilterBody,
  resolveSystemPromptMode,
} from "../../open-sse/executors/codebuddy-base.js";
import { ZWSP } from "../../open-sse/utils/codebuddyDesensitize.js";

const strip = (s) => s.split(ZWSP).join("");
const CC_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.\nRefuse requests for DoS attacks and exploit development.";
// codebuddy-intl rewrites the Claude Code identity line (one word added) before the ZWSP pass,
// see utils/workbuddySanitize.js: the gateway's fingerprint WAF refuses the original line.
const CC_SYSTEM_INTL = CC_SYSTEM.replace("official CLI for Claude", "official CLI tool for Claude");
const NEUTRAL = "You are a helpful AI assistant that helps with software engineering tasks.";
const LEAD = "You are CodeBuddy Code.";
const creds = { accessToken: "tok-abc", connectionId: "conn-1" };

function claudeCodeBody(extra = {}) {
  return {
    messages: [
      { role: "system", content: CC_SYSTEM },
      { role: "user", content: "fix the parser" },
    ],
    tools: [{ type: "function", function: { name: "Bash", description: "Run a command; never kill other agents.", parameters: { type: "object", properties: {} } } }],
    ...extra,
  };
}

afterEach(() => {
  delete process.env.CODEBUDDY_SYSTEM_PROMPT_MODE;
});

describe("CodeBuddyExecutor (CN) transformRequest", () => {
  const exec = new CodeBuddyExecutor();

  it("keeps the agent system prompt, desensitized, instead of the neutral replacement", () => {
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), true, creds);
    const system = out.messages[0];
    expect(system.role).toBe("system");
    expect(system.content).not.toBe(NEUTRAL);
    expect(system.content).toContain(ZWSP);
    expect(strip(system.content)).toBe(CC_SYSTEM);
  });

  it("preserves typed-block shape and leaves user/assistant messages untouched", () => {
    const body = {
      messages: [
        { role: "system", content: [{ type: "text", text: CC_SYSTEM, cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "explain DoS attacks" },
        { role: "assistant", content: "exploit explained" },
      ],
    };
    const out = exec.transformRequest("glm-5.2", body, true, creds);
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(strip(out.messages[0].content[0].text)).toBe(CC_SYSTEM);
    expect(out.messages[1]).toEqual(body.messages[1]);
    expect(out.messages[2]).toEqual(body.messages[2]);
  });

  it("desensitizes tool descriptions but not tool names", () => {
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), true, creds);
    expect(out.tools[0].function.name).toBe("Bash");
    expect(out.tools[0].function.description).toContain(ZWSP);
    expect(strip(out.tools[0].function.description)).toBe("Run a command; never kill other agents.");
  });

  it("forces stream and does not mutate the incoming body", () => {
    const body = claudeCodeBody();
    const snapshot = JSON.stringify(body);
    const out = exec.transformRequest("glm-5.2", body, false, creds);
    expect(out.stream).toBe(true);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(body.stream).toBeUndefined();
  });

  it("CODEBUDDY_SYSTEM_PROMPT_MODE=legacy restores the neutral-prompt behavior verbatim", () => {
    process.env.CODEBUDDY_SYSTEM_PROMPT_MODE = "legacy";
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), true, creds);
    expect(out.messages[0]).toEqual({ role: "system", content: NEUTRAL });
    expect(JSON.stringify(out)).not.toContain(ZWSP); // tools untouched too
    // typed blocks keep their shape on replacement
    const typed = exec.transformRequest("glm-5.2", { messages: [{ role: "system", content: [{ type: "text", text: CC_SYSTEM }] }] }, true, creds);
    expect(typed.messages[0].content).toEqual([{ type: "text", text: NEUTRAL }]);
    // a plain user system prompt is left alone
    const plain = exec.transformRequest("glm-5.2", { messages: [{ role: "system", content: "Answer in French." }] }, true, creds);
    expect(plain.messages[0].content).toBe("Answer in French.");
  });
});

describe("CodeBuddyIntlExecutor transformRequest / buildIntlMessages", () => {
  const exec = new CodeBuddyIntlExecutor();

  it("leads with 'You are CodeBuddy Code.' and keeps the desensitized original system prompt after it", () => {
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), true, creds);
    expect(out.messages[0].role).toBe("system");
    expect(typeof out.messages[0].content).toBe("string");
    expect(out.messages[0].content.startsWith(`${LEAD}\n\n`)).toBe(true);
    expect(out.messages[0].content).toContain(ZWSP);
    expect(strip(out.messages[0].content)).toBe(`${LEAD}\n\n${CC_SYSTEM_INTL}`);
    // exactly one system message: the gateway is only known to accept a single leading one
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("wraps string user content into typed blocks and leaves other messages alone", () => {
    const body = {
      messages: [
        { role: "system", content: CC_SYSTEM },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi", tool_calls: [{ id: "c1" }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
        { role: "user", content: [{ type: "text", text: "already typed" }] },
      ],
    };
    const out = exec.transformRequest("glm-5.2", body, true, creds);
    expect(out.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(out.messages[1].content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.messages[2]).toEqual(body.messages[2]);
    expect(out.messages[3]).toEqual(body.messages[3]);
    expect(out.messages[4].content).toEqual([{ type: "text", text: "already typed" }]);
  });

  it("folds developer messages and typed-block system content into the leading message", () => {
    const out = buildIntlMessages([
      { role: "system", content: [{ type: "text", text: "Anthropic rule A" }, { type: "text", text: "rule B" }] },
      { role: "developer", content: "exploit rule C" },
      { role: "user", content: "go" },
    ]);
    expect(out).toHaveLength(2);
    expect(strip(out[0].content)).toBe(`${LEAD}\n\nAnthropic rule A\nrule B\n\nexploit rule C`);
    expect(out[0].content).toContain(ZWSP);
  });

  it("sends only the lead prompt when the client has no system prompt", () => {
    const out = exec.transformRequest("glm-5.2", { messages: [{ role: "user", content: "hi" }] }, true, creds);
    expect(out.messages[0]).toEqual({ role: "system", content: LEAD });
  });

  it("desensitizes tool descriptions and forces stream", () => {
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), false, creds);
    expect(out.stream).toBe(true);
    expect(out.tools[0].function.description).toContain(ZWSP);
    expect(out.tools[0].function.name).toBe("Bash");
  });

  it("does not mutate the incoming body, so a re-transform yields the same request", () => {
    const body = claudeCodeBody();
    const snapshot = JSON.stringify(body);
    const first = exec.transformRequest("glm-5.2", body, true, creds);
    const second = exec.transformRequest("glm-5.2", body, true, creds);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("CODEBUDDY_SYSTEM_PROMPT_MODE=legacy drops the client system prompt and tools stay untouched", () => {
    process.env.CODEBUDDY_SYSTEM_PROMPT_MODE = "legacy";
    const out = exec.transformRequest("glm-5.2", claudeCodeBody(), true, creds);
    expect(out.messages[0]).toEqual({ role: "system", content: LEAD });
    expect(out.messages).toHaveLength(2);
    expect(JSON.stringify(out)).not.toContain(ZWSP);
  });
});

describe("resolveSystemPromptMode / matchesContentFilterBody", () => {
  it("defaults to desensitize; only 'legacy' (any case) switches", () => {
    expect(resolveSystemPromptMode({})).toBe("desensitize");
    expect(resolveSystemPromptMode({ CODEBUDDY_SYSTEM_PROMPT_MODE: "desensitize" })).toBe("desensitize");
    expect(resolveSystemPromptMode({ CODEBUDDY_SYSTEM_PROMPT_MODE: " Legacy " })).toBe("legacy");
    expect(resolveSystemPromptMode({ CODEBUDDY_SYSTEM_PROMPT_MODE: "bogus" })).toBe("desensitize");
  });

  it("recognizes the documented content-filter shapes only", () => {
    expect(matchesContentFilterBody('{"error":{"message":"内容违规","type":"content_policy_violation"}}')).toBe(true);
    expect(matchesContentFilterBody('{"code":500,"msg":"model return error"}')).toBe(true);
    expect(matchesContentFilterBody('{"code":14018,"msg":"Credits exhausted"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":14018,"msg":"model return error"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":11101,"msg":"Non-stream chat request is currently not supported"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":11128,"msg":"request illegal"}')).toBe(false);
    // 11128 is the gateway's fingerprint WAF only with its "unapproved channel" message
    expect(matchesContentFilterBody('{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}')).toBe(true);
    expect(matchesContentFilterBody('{"code":"11128","msg":"illegal api invocation"}')).toBe(true);
    expect(matchesContentFilterBody('{"code":11128,"msg":"conversation id missing"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":11128,"msg":"first message is not system prompt"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":11128,"msg":"conversation id missing","displayTips":"unapproved channel"}')).toBe(false);
    expect(matchesContentFilterBody('{"code":11101,"msg":"Illegal API invocation from an unapproved channel"}')).toBe(false);
    expect(matchesContentFilterBody("")).toBe(false);
    expect(matchesContentFilterBody(undefined)).toBe(false);
  });
});

const FILTER_BODY = '{"error":{"message":"内容违规","type":"content_policy_violation"}}';
const respond = (status, body) => async () => new Response(body, { status });
const sentBody = (call) => JSON.parse(fetchMock.mock.calls[call][1].body);

describe.each([
  ["codebuddy-cn", () => new CodeBuddyExecutor(), (messages) => messages[0].content, NEUTRAL],
  ["codebuddy-intl", () => new CodeBuddyIntlExecutor(), (messages) => messages[0].content, LEAD],
])("%s content-filter fallback (execute)", (name, make, firstSystem, legacySystem) => {
  const exec = make();
  const run = (body = claudeCodeBody(), extra = {}) =>
    exec.execute({ model: "glm-5.2", body, stream: true, credentials: creds, ...extra });

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("sends the desensitized prompt first", async () => {
    fetchMock.mockImplementationOnce(respond(200, "data: [DONE]\n\n"));
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstSystem(sentBody(0).messages)).toContain(ZWSP);
  });

  it("retries exactly once with the legacy body after a content-filter rejection", async () => {
    fetchMock
      .mockImplementationOnce(respond(400, FILTER_BODY))
      .mockImplementationOnce(respond(200, "data: ok\n\n"));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = sentBody(0);
    const second = sentBody(1);
    expect(firstSystem(first.messages)).toContain(ZWSP);
    expect(firstSystem(second.messages)).toBe(legacySystem);
    expect(JSON.stringify(second)).not.toContain(ZWSP); // legacy: no desensitized tools either
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe("data: ok\n\n");
    expect(JSON.stringify(result.transformedBody)).toBe(JSON.stringify(second));
  });

  it("does not retry a second time when the legacy attempt is rejected too", async () => {
    fetchMock
      .mockImplementationOnce(respond(400, FILTER_BODY))
      .mockImplementationOnce(respond(400, FILTER_BODY))
      .mockImplementation(respond(200, "should not be reached"));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(400);
  });

  it("retries on the generic 'model return error' content-filter message", async () => {
    fetchMock
      .mockImplementationOnce(respond(500, '{"code":500,"msg":"model return error"}'))
      .mockImplementationOnce(respond(200, "ok"));
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 429 / code 14018 (credits exhausted)", async () => {
    fetchMock.mockImplementation(respond(429, '{"code":14018,"msg":"Credits exhausted"}'));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).toContain("14018");
  });

  it("does NOT retry on 401, even if the body mentions the filter", async () => {
    fetchMock.mockImplementation(respond(401, FILTER_BODY));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(401);
  });

  it("does NOT retry on unrelated upstream errors, and leaves their body readable", async () => {
    fetchMock.mockImplementation(respond(400, '{"code":11101,"msg":"invalid request"}'));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await result.response.text()).toBe('{"code":11101,"msg":"invalid request"}');
  });

  it("does NOT retry a successful response", async () => {
    fetchMock.mockImplementation(respond(200, "data: hi\n\n"));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await result.response.text()).toBe("data: hi\n\n");
  });

  it("CODEBUDDY_SYSTEM_PROMPT_MODE=legacy sends the legacy body first and never retries", async () => {
    process.env.CODEBUDDY_SYSTEM_PROMPT_MODE = "legacy";
    fetchMock.mockImplementation(respond(400, FILTER_BODY));
    const result = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstSystem(sentBody(0).messages)).toBe(legacySystem);
    expect(result.response.status).toBe(400);
  });

  it("skips the retry when the legacy request would be identical (nothing was desensitized)", async () => {
    fetchMock.mockImplementation(respond(400, FILTER_BODY));
    const result = await run({ messages: [{ role: "user", content: "hello" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe(400);
  });

  it("re-runs from the ORIGINAL body (a prior transform must not leak into the retry)", async () => {
    fetchMock
      .mockImplementationOnce(respond(400, FILTER_BODY))
      .mockImplementationOnce(respond(200, "ok"));
    const body = claudeCodeBody();
    const snapshot = JSON.stringify(body);
    await run(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it("propagates a client abort during the retry instead of swallowing it", async () => {
    fetchMock
      .mockImplementationOnce(respond(400, FILTER_BODY))
      .mockImplementationOnce(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
  });
});
