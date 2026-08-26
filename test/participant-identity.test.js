import { describe, expect, it } from "vitest";
import {
  ParticipantNameError,
  normalizeParticipantName,
} from "../src/lib/participant-identity.js";

function expectInvalidName(participantName) {
  expect(() => normalizeParticipantName(participantName)).toThrowError(
    expect.objectContaining({
      name: "ParticipantNameError",
      code: "invalid_participant_name",
    }),
  );
}

describe("participant name storage normalization", () => {
  it("creates a readable NFKC display value while preserving Roman-letter case", () => {
    expect(normalizeParticipantName(
      "  Ｑｕａｓａｒ　Ｉｄｅｎｔｉｔｙ  ",
    )).toBe("Quasar Identity");
    expect(normalizeParticipantName("Yamada\u00a0\u2003Taro")).toBe("Yamada Taro");
    expect(normalizeParticipantName("ﾔﾏﾀﾞ　太郎")).toBe("ヤマダ 太郎");
    expect(normalizeParticipantName("Mixed CASE Name")).toBe("Mixed CASE Name");
  });

  it("rejects non-string, control, separator, surrogate, and bidi-control input", () => {
    for (const participantName of [
      null,
      undefined,
      123,
      "山田\n太郎",
      "山田\r太郎",
      "山田\t太郎",
      "山田\u0085太郎",
      "山田\u2028太郎",
      "山田\u2029太郎",
      "山田\u200f太郎",
      "山田\u202e太郎",
      "山田\u2066太郎",
      `山田${String.fromCharCode(0xd800)}太郎`,
    ]) {
      expectInvalidName(participantName);
    }
  });

  it("enforces the 80-code-point and 256-byte limits after normalization", () => {
    expect(normalizeParticipantName("a".repeat(80))).toBe("a".repeat(80));
    expectInvalidName("a".repeat(81));
    expect(normalizeParticipantName("😀".repeat(64))).toBe("😀".repeat(64));
    expectInvalidName("😀".repeat(65));
    expectInvalidName("   　\u00a0  ");
  });

  it("does not echo rejected plaintext through its validation error", () => {
    const rejectedName = "Distinctive Rejected\nParticipant Name";
    try {
      normalizeParticipantName(rejectedName);
      throw new Error("Expected participant name validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ParticipantNameError);
      expect(String(error.message)).not.toContain(rejectedName);
    }
  });
});
