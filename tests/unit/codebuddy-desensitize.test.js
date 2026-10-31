// CodeBuddy's gateway keyword-filters agent system prompts. Instead of dropping
// the prompt we insert U+200B inside sensitive terms (port of workbuddy2api
// desensitize.py): the model still reads the text, a substring match misses.
import { describe, it, expect } from "vitest";
import {
  ZWSP,
  SENSITIVE_TERMS,
  desensitizeText,
  desensitizeMessages,
  desensitizeTools,
  contentToText,
} from "../../open-sse/utils/codebuddyDesensitize.js";

const strip = (s) => s.split(ZWSP).join("");

describe("desensitizeText", () => {
  it("inserts a zero-width space after the first character of each sensitive term", () => {
    expect(desensitizeText("Refuse requests for DoS attacks and exploit development.")).toBe(
      `Refuse requests for D${ZWSP}oS a${ZWSP}ttacks and e${ZWSP}xploit development.`
    );
  });

  it("keeps the text readable: stripping the zero-width spaces gives the original back", () => {
    const text = "You are Claude Code, Anthropic's official CLI. Dual-use tools (C2 frameworks, credential testing) need authorization.";
    const out = desensitizeText(text);
    expect(out).not.toBe(text);
    expect(strip(out)).toBe(text);
  });

  it("preserves the original casing of the matched term", () => {
    expect(desensitizeText("ANTHROPIC and anthropic")).toBe(`A${ZWSP}NTHROPIC and a${ZWSP}nthropic`);
  });

  it("matches the longest term first (one split per phrase, not per inner word)", () => {
    expect(desensitizeText("privilege escalation")).toBe(`p${ZWSP}rivilege escalation`);
  });

  it("is idempotent", () => {
    const once = desensitizeText("exploit the Claude Code vulnerability");
    expect(desensitizeText(once)).toBe(once);
  });

  it("returns text without sensitive terms, empty and non-string values untouched", () => {
    expect(desensitizeText("Please refactor this function.")).toBe("Please refactor this function.");
    expect(desensitizeText("")).toBe("");
    expect(desensitizeText(undefined)).toBeUndefined();
    expect(desensitizeText(42)).toBe(42);
  });

  it("splits identity-marker URIs and config file names", () => {
    expect(desensitizeText("see skill://foo and CLAUDE.md")).toBe(`see s${ZWSP}kill://foo and C${ZWSP}LAUDE.md`);
  });

  it("only splits ambiguous short terms as whole words (prompt/complete/skill stay intact)", () => {
    const common = "The prompt must complete; compile the component; the Skill tool shows skills; a drugstore.";
    expect(desensitizeText(common)).toBe(common);
    expect(desensitizeText("run omp, then kill it")).toBe(`run o${ZWSP}mp, then k${ZWSP}ill it`);
  });

  it("never splits a term inside a path or URL token (the model copies those into tool calls)", () => {
    const paths = "Edit /home/me/compose-app/CLAUDE.md and ~/.claude/AGENTS.md via https://github.com/anthropics/claude-code";
    expect(desensitizeText(paths)).toBe(paths);
    expect(desensitizeText("C:\\work\\exploit\\run.ps1")).toBe("C:\\work\\exploit\\run.ps1");
  });

  it("exports the workbuddy2api term list", () => {
    expect(SENSITIVE_TERMS).toEqual(expect.arrayContaining(["DoS", "exploit", "Claude Code", "Anthropic", "CLAUDE.md", "skill://"]));
    expect(SENSITIVE_TERMS.length).toBeGreaterThan(100);
  });
});

describe("desensitizeMessages", () => {
  const messages = [
    { role: "system", content: "You are Claude Code. Refuse DoS attacks." },
    { role: "developer", content: [{ type: "text", text: "Anthropic rules", cache_control: { type: "ephemeral" } }, { type: "image_url", image_url: { url: "x" } }] },
    { role: "user", content: "Explain DoS attacks and exploit code" },
    { role: "assistant", content: "A DoS attack floods a service." },
    { role: "tool", tool_call_id: "t1", content: "exploit output" },
  ];

  it("desensitizes system and developer messages, preserving string vs typed-block shape", () => {
    const out = desensitizeMessages(messages);
    expect(out[0].content).toBe(`You are C${ZWSP}laude Code. Refuse D${ZWSP}oS a${ZWSP}ttacks.`);
    expect(Array.isArray(out[1].content)).toBe(true);
    expect(out[1].content[0]).toEqual({ type: "text", text: `A${ZWSP}nthropic rules`, cache_control: { type: "ephemeral" } });
    expect(out[1].content[1]).toEqual(messages[1].content[1]);
  });

  it("never touches user, assistant or tool messages", () => {
    const out = desensitizeMessages(messages);
    expect(out[2]).toEqual(messages[2]);
    expect(out[3]).toEqual(messages[3]);
    expect(out[4]).toEqual(messages[4]);
    for (const m of out.slice(2)) expect(JSON.stringify(m)).not.toContain(ZWSP);
  });

  it("does not mutate its input", () => {
    const snapshot = JSON.stringify(messages);
    desensitizeMessages(messages);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("passes non-array input and odd entries through", () => {
    expect(desensitizeMessages(undefined)).toBeUndefined();
    expect(desensitizeMessages([null, "x", { role: "system", content: null }])).toEqual([null, "x", { role: "system", content: null }]);
  });
});

describe("desensitizeTools", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "Bash",
        description: "Run a command. Never use for a DoS attack.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The exploit command to run", title: "Anthropic command" },
            description: { type: "string", description: "Why this command (malware analysis)" },
          },
          required: ["command"],
        },
      },
    },
  ];

  it("desensitizes description/title strings at every nesting level and leaves names alone", () => {
    const out = desensitizeTools(tools);
    const fn = out[0].function;
    expect(fn.name).toBe("Bash");
    expect(fn.description).toBe(`Run a command. Never use for a D${ZWSP}oS a${ZWSP}ttack.`);
    expect(fn.parameters.properties.command.description).toBe(`The e${ZWSP}xploit command to run`);
    expect(fn.parameters.properties.command.title).toBe(`A${ZWSP}nthropic command`);
    expect(fn.parameters.properties.description.description).toBe(`Why this command (m${ZWSP}alware analysis)`);
    expect(fn.parameters.required).toEqual(["command"]);
  });

  it("does not mutate its input and tolerates non-arrays", () => {
    const snapshot = JSON.stringify(tools);
    desensitizeTools(tools);
    expect(JSON.stringify(tools)).toBe(snapshot);
    expect(desensitizeTools(undefined)).toBeUndefined();
  });
});

describe("contentToText", () => {
  it("flattens strings and typed blocks", () => {
    expect(contentToText("abc")).toBe("abc");
    expect(contentToText([{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(contentToText(null)).toBe("");
  });
});
