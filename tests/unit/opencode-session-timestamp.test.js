import { describe, it, expect } from "vitest";
import { OPENCODE_SESSION_RE, translateSessionId, generateSessionId } from "../../open-sse/executors/opencode.js";

// Gate 2 of the free tier (decolua/9router ce060c79): the 48-bit session prefix is a
// descending timestamp that must fall inside the free-tier window, so a digest-derived
// time field (uniform over 2^36 ms) was refused 9 times out of 10. The id is minted
// from Date.now() and memoized per conversation.
// The prefix holds 36 bits of milliseconds above a 12-bit counter, so the decoded
// time is Date.now() modulo 2^36.
const TIME_MODULUS = 2 ** 36;
const timeField = (ms) => ms % TIME_MODULUS;

function decodeSessionMs(id) {
  const value = BigInt(`0x${id.slice(4, 16)}`);
  return Number((~value & ((1n << 48n) - 1n)) >> 12n);
}

describe("opencode session timestamp", () => {
  it("mints translated sessions from the current time", () => {
    for (let i = 0; i < 10; i++) {
      const before = Date.now();
      const id = translateSessionId(`conversation-ts-${i}-${Math.random()}`, "claude");
      const after = Date.now();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      const ms = decodeSessionMs(id);
      expect(ms).toBeGreaterThanOrEqual(timeField(before));
      expect(ms).toBeLessThanOrEqual(timeField(after));
    }
  });

  it("keeps one stable session per conversation", () => {
    const first = translateSessionId("conversation-stable", "codex");
    expect(translateSessionId("conversation-stable", "codex")).toBe(first);
    expect(translateSessionId("conversation-other", "codex")).not.toBe(first);
  });

  it("generated sessions carry the current time too", () => {
    const before = Date.now();
    const ms = decodeSessionMs(generateSessionId());
    expect(ms).toBeGreaterThanOrEqual(timeField(before));
    expect(ms).toBeLessThanOrEqual(timeField(Date.now()));
  });
});
