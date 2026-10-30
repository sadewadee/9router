// WorkBuddy / CodeBuddy-intl gateway fingerprint WAF: exact-substring match over
// message text, plus a ban on the bare string "11128" (so one error echoed into the
// history poisons every later turn). Port of the workbuddy2api-hub sanitizer.
import { describe, it, expect } from "vitest";
import {
  sanitizeFingerprintText,
  sanitizeFingerprintMessages,
} from "../../open-sse/utils/workbuddySanitize.js";

const full = (text) => sanitizeFingerprintText(text);
const data = (text) => sanitizeFingerprintText(text, { identity: false });

describe("sanitizeFingerprintText: bare 11128", () => {
  it("rewrites 11128 to 11-128 in both modes, every occurrence", () => {
    expect(data("HTTP 400 code 11128, again 11128")).toBe("HTTP 400 code 11-128, again 11-128");
    expect(full("error 11128")).toBe("error 11-128");
  });

  it("rewrites it inside a longer digit run too (the gateway matches the substring)", () => {
    expect(data("id=111289")).toBe("id=11-1289");
  });
});

describe("sanitizeFingerprintText: billing header", () => {
  it("strips the x-anthropic-billing-header line and its cc_ pairs", () => {
    const text = "x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli;\nYou are helpful.";
    expect(data(text)).toBe("You are helpful.");
  });

  it("strips the header case-insensitively", () => {
    expect(data("X-Anthropic-Billing-Header: cc_entrypoint=cli; ok")).toBe("ok");
  });

  it("strips every cc_ key=value pair, however many follow", () => {
    expect(data("cc_entrypoint=cli; cc_version=1; cc_workload=agent; keep me")).toBe("keep me");
  });

  it("renames a bare mention of the header name", () => {
    expect(data("the x-anthropic-billing-header is internal")).toBe("the x-anthropic-billing-hdr is internal");
  });

  it("leaves the header-free remainder of the line intact", () => {
    expect(data("before x-anthropic-billing-header: cc_version=1;\nafter")).toBe("before after");
  });
});

describe("sanitizeFingerprintText: literal template lines", () => {
  it("rewrites the Claude Code identity line (one word added)", () => {
    expect(full("You are Claude Code, Anthropic's official CLI for Claude, helping.")).toBe(
      "You are Claude Code, Anthropic's official CLI tool for Claude, helping."
    );
  });

  it("rewrites the git status 'Main branch' line", () => {
    expect(full("Main branch (you will usually use this for PRs): main")).toBe(
      "Default branch (you will usually use this for PRs): main"
    );
  });

  it("rewrites the Codex CLI identity line and the feedback line", () => {
    expect(full("You are a coding agent running in the Codex CLI, a terminal-based coding assistant.")).toBe(
      "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."
    );
    expect(full("To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues")).toBe(
      "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"
    );
  });
});

describe("sanitizeFingerprintText: OmO junior", () => {
  it("drops the framework attribution, keeping the agent name", () => {
    expect(full("You are Sisyphus-Junior - Focused executor from OhMyOpenCode. Work.")).toBe(
      "You are Sisyphus-Junior - Focused executor. Work."
    );
  });

  it("matches case-insensitively and inside surrounding text", () => {
    expect(full("xx SISYPHUS-JUNIOR - focused executor from ohmyopencode yy")).toBe("xx Sisyphus-Junior - Focused executor yy");
  });

  it("does not touch either token alone", () => {
    expect(full("OhMyOpenCode is a plugin. Sisyphus-Junior is a role.")).toBe("OhMyOpenCode is a plugin. Sisyphus-Junior is a role.");
  });

  it("also runs without the identity rules", () => {
    expect(data("Sisyphus-Junior - Focused executor from OhMyOpenCode")).toBe("Sisyphus-Junior - Focused executor");
  });
});

describe("sanitizeFingerprintText: identity sentence", () => {
  it.each([
    "You are an AI agent powered by DeepSeek Harness.",
    "You are a coding agent powered by the deepseek-v4.1-flash model.",
    "You are an AI assistant built on DeepSeek.",
    "You are Acme Agent, built by Acme Corp.",
    "You are powered by something.",
    "You are an assistant created by X, developed by Y, made by Z.",
    "You are a model trained by someone.",
  ])("rewrites %j", (sentence) => {
    expect(full(`${sentence} Be brief.`)).toBe("You are a helpful AI assistant. Be brief.");
  });

  it("is case-insensitive and stops at the end of the line when there is no period", () => {
    expect(full("YOU ARE AN AI AGENT POWERED BY X\nNext line")).toBe("You are a helpful AI assistant.\nNext line");
  });

  it("keeps a bounded window: 'You are free to use tools built by X.' is NOT rewritten", () => {
    const text = "You are free to use tools built by X.";
    expect(full(text)).toBe(text);
    const longer = "You are welcome to use the tools built by third parties.";
    expect(full(longer)).toBe(longer);
  });

  it("does not rewrite the sentence in data mode", () => {
    expect(data("You are an AI agent powered by DeepSeek Harness.")).toBe("You are an AI agent powered by DeepSeek Harness.");
  });

  it("matches non-ASCII product names inside the window", () => {
    expect(full("You are Zürich Agent, built by Müller.")).toBe("You are a helpful AI assistant.");
  });

  it("does not backtrack catastrophically on a long blank run after 'You are'", () => {
    const text = `built by x. You are${" ".repeat(50000)}x`;
    const started = Date.now();
    expect(full(text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("sanitizeFingerprintText: DSH GUI / file reference / brand", () => {
  it("reorders the tail of the GUI sentence, dropping no word (the brand reduction then shortens the name)", () => {
    expect(full("You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.")).toBe(
      "You are interacting with the user through the DeepSeek Web GUI whose URL is named in the runtime context."
    );
  });

  it("DSH fileref gets 'that' added once and is idempotent", () => {
    const text = "Tokens prefixed with @ are paths the user explicitly referenced.";
    const once = full(text);
    expect(once).toBe("Tokens prefixed with @ are paths that the user explicitly referenced.");
    expect(full(once)).toBe(once);
  });

  it("reduces 'DeepSeek Harness' to 'DeepSeek' in prose, but leaves paths and identifiers", () => {
    expect(full("Built on the DeepSeek Harness project.")).toBe("Built on the DeepSeek project.");
    const ids = "see /opt/deepseek-harness/app and deepseek_harness and DeepSeek-Harness";
    expect(full(ids)).toBe(ids);
  });

  it("does not apply these in data mode", () => {
    const text = "Tokens prefixed with @ are paths the user explicitly referenced. DeepSeek Harness";
    expect(data(text)).toBe(text);
  });
});

describe("sanitizeFingerprintText: untouched text", () => {
  it("returns the very same string when nothing matches, whitespace included", () => {
    const text = "  \n  Please refactor this function.\n\n";
    expect(full(text)).toBe(text);
    expect(data(text)).toBe(text);
  });

  it("keeps surrounding whitespace when a prefilter literal matches but no rule rewrites it", () => {
    const text = "  See https://github.com/anthropics/claude-code for details.  ";
    expect(full(text)).toBe(text);
    const claude = "\nYou are Claude Code, a fine tool.\n";
    expect(full(claude)).toBe(claude);
  });

  it("trims only when something was rewritten", () => {
    expect(full("  \n code 11128 \n ")).toBe("code 11-128");
  });

  it("passes empty and non-string values through", () => {
    expect(full("")).toBe("");
    expect(full(undefined)).toBeUndefined();
    expect(full(null)).toBeNull();
    expect(full(42)).toBe(42);
  });
});

describe("sanitizeFingerprintMessages", () => {
  const IDENTITY = "You are an AI agent powered by DeepSeek Harness.";
  const REWRITTEN = "You are a helpful AI assistant.";

  it("converts the developer role to system", () => {
    const out = sanitizeFingerprintMessages([{ role: "developer", content: "Rule." }, { role: "user", content: "hi" }]);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[0].content).toBe("Rule.");
  });

  it("rewrites the identity sentence in system, developer and assistant messages, never in user", () => {
    const out = sanitizeFingerprintMessages([
      { role: "system", content: IDENTITY },
      { role: "developer", content: IDENTITY },
      { role: "assistant", content: IDENTITY },
      { role: "user", content: IDENTITY },
    ]);
    expect(out.map((m) => m.content)).toEqual([REWRITTEN, REWRITTEN, REWRITTEN, IDENTITY]);
  });

  it("applies the data rules to user and tool messages: 11128, billing header, cc_ pairs", () => {
    const out = sanitizeFingerprintMessages([
      { role: "user", content: "it failed with code 11128" },
      { role: "tool", tool_call_id: "t1", content: '{"code":11128,"msg":"x"}' },
      { role: "user", content: "x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli; hello" },
    ]);
    expect(out[0].content).toBe("it failed with code 11-128");
    expect(out[1].content).toBe('{"code":11-128,"msg":"x"}');
    expect(out[2].content).toBe("hello");
  });

  it("treats unknown roles like data (no identity rules)", () => {
    const out = sanitizeFingerprintMessages([{ role: "function", name: "f", content: `${IDENTITY} 11128` }]);
    expect(out[0].content).toBe(`${IDENTITY} 11-128`);
  });

  it("handles typed blocks: only text blocks change, other blocks and block fields survive", () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,11128" } };
    const out = sanitizeFingerprintMessages([
      {
        role: "user",
        content: [{ type: "text", text: "code 11128", cache_control: { type: "ephemeral" } }, image],
      },
      { role: "system", content: [{ type: "text", text: IDENTITY }, { type: "text", text: "plain" }] },
    ]);
    expect(out[0].content[0]).toEqual({ type: "text", text: "code 11-128", cache_control: { type: "ephemeral" } });
    expect(out[0].content[1]).toBe(image);
    expect(out[1].content.map((b) => b.text)).toEqual([REWRITTEN, "plain"]);
  });

  it("sanitizes tool_call arguments as data and normalizes non-string ones", () => {
    const out = sanitizeFingerprintMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "f", arguments: `{"q":"${IDENTITY} 11128"}` } },
          { id: "b", type: "function", function: { name: "f", arguments: { path: "/tmp/11128" } } },
          { id: "c", type: "function", function: { name: "f", arguments: null } },
          { id: "d", type: "function", function: { name: "f" } },
          { id: "e", type: "function", function: { name: "f", arguments: [1, 2] } },
        ],
      },
    ]);
    const calls = out[0].tool_calls;
    expect(out[0].content).toBeNull();
    expect(calls[0].function.arguments).toBe(`{"q":"${IDENTITY} 11-128"}`); // identity rules are not applied to data
    expect(calls[1].function.arguments).toBe('{"path":"/tmp/11-128"}'); // serialized, then sanitized as data
    expect(calls[2].function.arguments).toBe("{}");
    expect(calls[3].function.arguments).toBe("{}");
    expect(calls[4].function.arguments).toBe("[1,2]");
    expect(calls[0].function.name).toBe("f");
    expect(calls[0].id).toBe("a");
  });

  it("sanitizes reasoning_content as data", () => {
    const out = sanitizeFingerprintMessages([{ role: "assistant", content: "ok", reasoning_content: `${IDENTITY} 11128` }]);
    expect(out[0].reasoning_content).toBe(`${IDENTITY} 11-128`);
  });

  it("never mutates its input and returns new objects", () => {
    const input = [
      { role: "developer", content: IDENTITY },
      { role: "user", content: [{ type: "text", text: "11128" }] },
      { role: "assistant", content: "x", tool_calls: [{ id: "a", function: { name: "f", arguments: { a: 1 } } }] },
    ];
    const snapshot = JSON.stringify(input);
    const out = sanitizeFingerprintMessages(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    out.forEach((message, i) => expect(message).not.toBe(input[i]));
    expect(input[0].role).toBe("developer");
  });

  it("returns clean messages unchanged in value, and tolerates junk entries and non-arrays", () => {
    const clean = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    expect(sanitizeFingerprintMessages(clean)).toEqual(clean);
    expect(sanitizeFingerprintMessages([null, "str", { role: "user", content: "x" }])).toEqual([null, "str", { role: "user", content: "x" }]);
    expect(sanitizeFingerprintMessages(undefined)).toBeUndefined();
  });
});
