import { describe, expect, it } from "vitest";
import { collectionConfiguration } from "../src/lib/config.js";
import { redeemInvitation, startTrial } from "../src/routes-participant.js";

const REAL_ASSETS = Object.freeze({
  ENVIRONMENT: "production",
  ASSIGNMENT_VERSION: "main-v4-real-assets",
  ASSET_VERSION: "main-assets-v1",
  ALLOW_PLACEHOLDER_ASSETS: "false",
  ADMIN_TOKEN: "production-admin-token-for-test-only",
  RANDOMIZATION_SECRET: "production-randomization-secret-for-test-only",
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

  it("does not require an identity secret for plaintext participant-name confirmation", () => {
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

  it("blocks redemption of a previously issued invitation while production gates are closed", async () => {
    const request = new Request("https://experiment.test/api/invitations/redeem", {
      method: "POST",
    });
    await expect(redeemInvitation(request, {
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
