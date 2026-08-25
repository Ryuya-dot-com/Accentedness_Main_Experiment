import { describe, expect, it } from "vitest";
import {
  PARTICIPANT_IDENTITY_NORMALIZATION_VERSION,
  PARTICIPANT_IDENTITY_VERIFIER_VERSION,
  ParticipantIdentityError,
  createParticipantIdentityBinding,
  participantIdentityVerifierEqual,
  verifyParticipantIdentityBinding,
} from "../src/lib/participant-identity.js";

const IDENTITY_SECRET = "test-identity-secret-is-independent";
const PARTICIPANT_UUID = "12345678-1234-4123-8123-123456789abc";
const PARTICIPANT_ID = 17;

function binding(overrides = {}) {
  return createParticipantIdentityBinding({
    identitySecret: IDENTITY_SECRET,
    participantUuid: PARTICIPANT_UUID,
    participantId: PARTICIPANT_ID,
    participantName: "山田 太郎",
    ...overrides,
  });
}

async function expectInvalidName(participantName) {
  await expect(binding({ participantName })).rejects.toMatchObject({
    name: "ParticipantIdentityError",
    code: "invalid_participant_name",
  });
}

describe("participant identity binding", () => {
  it("normalizes NFKC, Unicode whitespace, and Roman letter case server-side", async () => {
    const variants = await Promise.all([
      binding({ participantName: "  ＹＡＭＡＤＡ　ＴＡＲＯ  " }),
      binding({ participantName: "yamada\u00a0\u2003taro" }),
      binding({ participantName: "Yamada Taro" }),
    ]);
    expect(new Set(variants.map((value) => value.verifier_hex)).size).toBe(1);

    const kanaVariants = await Promise.all([
      binding({ participantName: "ﾔﾏﾀﾞ　太郎" }),
      binding({ participantName: "ヤマダ 太郎" }),
    ]);
    expect(kanaVariants[0].verifier_hex).toBe(kanaVariants[1].verifier_hex);
  });

  it("rejects control, newline, separator, surrogate, and bidi-control characters", async () => {
    for (const participantName of [
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
      await expectInvalidName(participantName);
    }
  });

  it("enforces the 80-code-point and 256-byte limits after normalization", async () => {
    await expect(binding({ participantName: "a".repeat(80) })).resolves.toBeDefined();
    await expectInvalidName("a".repeat(81));
    await expect(binding({ participantName: "😀".repeat(64) })).resolves.toBeDefined();
    await expectInvalidName("😀".repeat(65));
    await expectInvalidName("  　\u00a0  ");
  });

  it("requires a distinct identity secret containing at least 24 code points", async () => {
    await expect(binding({ identitySecret: "x".repeat(23) })).rejects.toMatchObject({
      name: "ParticipantIdentityError",
      code: "identity_secret_unconfigured",
    });
    await expect(binding({ identitySecret: "x".repeat(24) })).resolves.toBeDefined();
  });

  it("domain-separates the verifier by version, participant UUID, and participant ID", async () => {
    const original = await binding();
    const differentUuid = await binding({
      participantUuid: "22345678-1234-4123-8123-123456789abc",
    });
    const differentId = await binding({ participantId: PARTICIPANT_ID + 1 });

    expect(original).toMatchObject({
      normalization_version: PARTICIPANT_IDENTITY_NORMALIZATION_VERSION,
      verifier_version: PARTICIPANT_IDENTITY_VERIFIER_VERSION,
      verifier_hex: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(differentUuid.verifier_hex).not.toBe(original.verifier_hex);
    expect(differentId.verifier_hex).not.toBe(original.verifier_hex);
  });

  it("does not return or expose the plaintext name", async () => {
    const participantName = "Distinctive Test Name 山田";
    const created = await binding({ participantName });
    expect(JSON.stringify(created)).not.toContain(participantName);
    expect(Object.keys(created).sort()).toEqual([
      "normalization_version",
      "verifier_hex",
      "verifier_version",
    ]);

    const rejectedName = "Do Not Echo\nThis Name";
    try {
      await binding({ participantName: rejectedName });
      throw new Error("Expected participant name validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ParticipantIdentityError);
      expect(String(error.message)).not.toContain(rejectedName);
    }
  });

  it("compares verifier values in constant-time through the shared crypto helper", async () => {
    const original = await binding();
    const other = await binding({ participantName: "山田 花子" });
    await expect(participantIdentityVerifierEqual(
      original.verifier_hex,
      original.verifier_hex,
    )).resolves.toBe(true);
    await expect(participantIdentityVerifierEqual(
      original.verifier_hex,
      other.verifier_hex,
    )).resolves.toBe(false);
    await expect(participantIdentityVerifierEqual(
      original.verifier_hex,
      "not-a-verifier",
    )).resolves.toBe(false);
  });

  it("verifies only a matching name, context, and version tuple", async () => {
    const stored = await binding();
    await expect(verifyParticipantIdentityBinding({
      identitySecret: IDENTITY_SECRET,
      participantUuid: PARTICIPANT_UUID,
      participantId: PARTICIPANT_ID,
      participantName: "山田　太郎",
      binding: stored,
    })).resolves.toBe(true);
    await expect(verifyParticipantIdentityBinding({
      identitySecret: IDENTITY_SECRET,
      participantUuid: PARTICIPANT_UUID,
      participantId: PARTICIPANT_ID,
      participantName: "山田 花子",
      binding: stored,
    })).resolves.toBe(false);
    await expect(verifyParticipantIdentityBinding({
      identitySecret: IDENTITY_SECRET,
      participantUuid: PARTICIPANT_UUID,
      participantId: PARTICIPANT_ID,
      participantName: "山田 太郎",
      binding: { ...stored, verifier_version: "future-version" },
    })).resolves.toBe(false);
  });

  it("uses canonical participant identifiers without echoing invalid values", async () => {
    await expect(binding({ participantId: "0017" })).rejects.toMatchObject({
      code: "invalid_participant_id",
    });
    await expect(binding({ participantUuid: "not-a-uuid" })).rejects.toMatchObject({
      code: "invalid_participant_uuid",
    });
    const numeric = await binding({ participantId: 17 });
    const canonicalText = await binding({ participantId: "17" });
    expect(numeric.verifier_hex).toBe(canonicalText.verifier_hex);
  });
});
