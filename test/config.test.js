import { describe, expect, it } from "vitest";
import { collectionConfiguration } from "../src/lib/config.js";
import {
  startCommonParticipantVisit,
  startTrial,
} from "../src/routes-participant.js";

const REAL_ASSETS = Object.freeze({
  ENVIRONMENT: "production",
  ASSIGNMENT_VERSION: "main-v10-english-practice-real-assets",
  ASSET_VERSION: "main-assets-v2",
  ALLOW_PLACEHOLDER_ASSETS: "false",
  ADMIN_TOKEN: "production-admin-token-for-test-only",
  RANDOMIZATION_SECRET: "production-randomization-secret-for-test-only",
});

const DEVELOPMENT = Object.freeze({
  ENVIRONMENT: "development",
  ASSIGNMENT_VERSION: "main-v10-english-practice-placeholder",
  ASSET_VERSION: "placeholder-v2",
  ALLOW_PLACEHOLDER_ASSETS: "true",
  TEST_TOKEN_POLICY: "undecided",
  ADMIN_TOKEN: "development-admin-token-for-test-only",
  RANDOMIZATION_SECRET: "development-randomization-secret-for-test-only",
});

describe("development participant gate", () => {
  it("denies normal participant collection by default and permits an explicit pilot", () => {
    expect(collectionConfiguration(DEVELOPMENT)).toMatchObject({
      production: false,
      developmentParticipantsAllowed: false,
      collectionReady: false,
      blocked: true,
    });
    expect(collectionConfiguration({
      ...DEVELOPMENT,
      ALLOW_DEVELOPMENT_PARTICIPANTS: "true",
    })).toMatchObject({
      developmentParticipantsAllowed: true,
      collectionReady: false,
      blocked: false,
    });
  });

  it("denies normal participant entry before storage access", async () => {
    const participantRequest = () => new Request("https://experiment.test/api", { method: "POST" });
    const blocked = { status: 503, code: "development_participants_blocked" };
    const trialId = "00000000-0000-4000-8000-000000000001";
    await expect(startCommonParticipantVisit(participantRequest(), DEVELOPMENT)).rejects.toMatchObject(blocked);
    await expect(startTrial(participantRequest(), DEVELOPMENT, trialId)).rejects.toMatchObject(blocked);
  });
});

describe("production collection gates", () => {
  it("blocks production until the immediate/delayed test-token policy is explicit", () => {
    const configuration = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "undecided",
    });
    expect(configuration).toMatchObject({
      production: true,
      tokenPolicyReady: false,
      collectionReady: false,
      blocked: true,
    });
  });

  it("allows the currently implemented exact-same-WAV policy once assets are real", () => {
    const configuration = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "same_token",
    });
    expect(configuration).toMatchObject({
      testTokenPolicy: "same_token",
      tokenPolicyReady: true,
      collectionReady: true,
      blocked: false,
    });
  });

  it("does not require an identity secret because participant names are not collected", () => {
    const configuration = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "same_token",
    });
    expect(configuration).not.toHaveProperty("identityVerificationReady");
    expect(configuration).toMatchObject({ collectionReady: true, blocked: false });
  });

  it("fails closed when any production secrets are missing or reused", () => {
    const missingAdmin = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "same_token",
      ADMIN_TOKEN: undefined,
    });
    expect(missingAdmin).toMatchObject({
      adminAuthenticationReady: false,
      secretsIndependent: false,
      collectionReady: false,
      blocked: true,
    });

    const missingRandomization = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "same_token",
      RANDOMIZATION_SECRET: undefined,
    });
    expect(missingRandomization).toMatchObject({
      randomizationReady: false,
      secretsIndependent: false,
      collectionReady: false,
      blocked: true,
    });

    const reusedOperationalSecret = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "same_token",
      ADMIN_TOKEN: REAL_ASSETS.RANDOMIZATION_SECRET,
    });
    expect(reusedOperationalSecret).toMatchObject({
      adminAuthenticationReady: true,
      randomizationReady: true,
      secretsIndependent: false,
      collectionReady: false,
      blocked: true,
    });
  });

  it("does not silently accept an unimplemented timepoint-specific take policy", () => {
    const configuration = collectionConfiguration({
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "timepoint_take",
    });
    expect(configuration).toMatchObject({
      tokenPolicyReady: false,
      collectionReady: false,
      blocked: true,
    });
  });

  it("blocks participant entry while production gates are closed", async () => {
    const request = new Request("https://experiment.test/api/participant-access/start", {
      method: "POST",
    });
    await expect(startCommonParticipantVisit(request, {
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "undecided",
    })).rejects.toMatchObject({
      status: 503,
      code: "production_collection_blocked",
    });
  });

  it("blocks the next trial in an already-active session", async () => {
    const request = new Request("https://experiment.test/api/trials/00000000-0000-4000-8000-000000000001/start", {
      method: "POST",
    });
    await expect(startTrial(request, {
      ...REAL_ASSETS,
      TEST_TOKEN_POLICY: "undecided",
    }, "00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({
      status: 503,
      code: "production_collection_blocked",
    });
  });
});
