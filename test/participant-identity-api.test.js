import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import {
  createParticipantIdentityBinding,
  verifyParticipantIdentityBinding,
} from "../src/lib/participant-identity.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const REGISTERED_NAME = "\u3000\uff31\uff55\uff41\uff53\uff41\uff52\u3000\uff29\uff44\uff45\uff4e\uff54\uff49\uff54\uff59\u3000\uff2d\uff41\uff52\uff4b\uff45\uff52\u3000";
const EQUIVALENT_NAME = "QUASAR   IDENTITY MARKER";
const DIFFERENT_NAME = "Nebula Continuity Marker";
const PLAINTEXT_MARKER = "quasar";

async function api(
  path,
  { method = "GET", token = null, body = null, runtimeEnv = null } = {},
) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  });
  const response = runtimeEnv
    ? await worker.fetch(request, runtimeEnv)
    : await exports.default.fetch(request);
  const json = (response.headers.get("Content-Type") ?? "").includes("application/json")
    ? await response.json()
    : null;
  return { response, json };
}

function invitationToken(invitationUrl) {
  return new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get("t");
}

function normalizedSearchText(value) {
  return JSON.stringify(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function expectPlaintextNameAbsent(value) {
  expect(normalizedSearchText(value)).not.toContain(PLAINTEXT_MARKER);
}

function nestedKeys(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry) => nestedKeys(entry, output));
    return output;
  }
  Object.entries(value).forEach(([key, entry]) => {
    output.push(key);
    nestedKeys(entry, output);
  });
  return output;
}

function expectNoIdentityInternalsInApi(value) {
  const forbidden = new Set([
    "participant_name",
    "name",
    "verifier_hex",
    "identity_verifier_hex",
    "normalization_version",
    "verifier_version",
  ]);
  expect(nestedKeys(value).filter((key) => forbidden.has(key))).toEqual([]);
  expectPlaintextNameAbsent(value);
}

async function all(sql, ...bindings) {
  return (await env.DB.prepare(sql).bind(...bindings).all()).results;
}

async function first(sql, ...bindings) {
  return env.DB.prepare(sql).bind(...bindings).first();
}

async function participantAuditRows(participantUuid) {
  return all(`
    SELECT * FROM audit_log
    WHERE participant_uuid = ?
    ORDER BY server_at_ms, audit_uuid
  `, participantUuid);
}

function actionCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.action] = (counts[row.action] ?? 0) + 1;
    return counts;
  }, {});
}

async function redemptionSnapshot(participantUuid, visitUuid, inviteUuid) {
  return {
    visit: await first("SELECT * FROM visits WHERE visit_uuid = ?", visitUuid),
    invitation: await first("SELECT * FROM invitations WHERE invite_uuid = ?", inviteUuid),
    identity: await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      participantUuid,
    ),
    sessions: await all(
      "SELECT * FROM sessions WHERE visit_uuid = ? ORDER BY epoch, session_uuid",
      visitUuid,
    ),
    audits: await participantAuditRows(participantUuid),
  };
}

async function createIdOnlyParticipant(participantId, runtimeEnv = null) {
  const created = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { participant_id: participantId },
    runtimeEnv,
  });
  expect(created.response.status).toBe(201);
  expect(created.json.participant.identity_registered).toBe(false);
  expectNoIdentityInternalsInApi(created.json);
  return created.json;
}

function redemptionBody(
  created,
  participantId,
  participantName,
  clientInstanceId = crypto.randomUUID(),
) {
  return {
    token: invitationToken(created.invitation.invitation_url),
    participant_id: participantId,
    participant_name: participantName,
    client_instance_id: clientInstanceId,
    expected_visit_type: "pre",
  };
}

async function redeem(created, participantId, participantName, options = {}) {
  return api("/api/invitations/redeem", {
    method: "POST",
    body: redemptionBody(
      created,
      participantId,
      participantName,
      options.clientInstanceId,
    ),
    runtimeEnv: options.runtimeEnv ?? null,
  });
}

function databaseWithBatchBarrier(database, parties = 2) {
  let arrivals = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements) => {
          arrivals += 1;
          if (arrivals === parties) release();
          await barrier;
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function envWithDatabase(database) {
  return new Proxy(env, {
    get(target, property) {
      return property === "DB" ? database : Reflect.get(target, property, target);
    },
  });
}

describe("participant-entered identity continuity", () => {
  it("keeps admin registration ID-only and defers the name HMAC until redemption", async () => {
    const participantId = 991_001;
    const created = await createIdOnlyParticipant(participantId);
    expect(await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      created.participant.participant_uuid,
    )).toBeNull();

    const beforeStaleAdminRequest = {
      participants: await first("SELECT COUNT(*) AS count FROM participants"),
      bindings: await first("SELECT COUNT(*) AS count FROM participant_identity_bindings"),
      audits: await first("SELECT COUNT(*) AS count FROM audit_log"),
    };
    const staleAdminRequest = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        participant_id: 991_002,
        participant_name: "Administrator Must Not Enter This",
      },
    });
    expect(staleAdminRequest.response.status).toBe(422);
    expect(staleAdminRequest.json.error.code).toBe("participant_name_not_accepted");
    expect({
      participants: await first("SELECT COUNT(*) AS count FROM participants"),
      bindings: await first("SELECT COUNT(*) AS count FROM participant_identity_bindings"),
      audits: await first("SELECT COUNT(*) AS count FROM audit_log"),
    }).toEqual(beforeStaleAdminRequest);

    const envWithoutIdentitySecret = new Proxy(env, {
      get(target, property) {
        if (property === "IDENTITY_SECRET") return undefined;
        return target[property];
      },
    });
    const noSecret = await createIdOnlyParticipant(991_003, envWithoutIdentitySecret);
    const beforeRedeem = await redemptionSnapshot(
      noSecret.participant.participant_uuid,
      noSecret.participant.pre_visit_id,
      noSecret.invitation.invite_id,
    );
    const blockedRedeem = await redeem(
      noSecret,
      991_003,
      "Secret Required At Redemption",
      { runtimeEnv: envWithoutIdentitySecret },
    );
    expect(blockedRedeem.response.status).toBe(503);
    expect(blockedRedeem.json.error.code).toBe("identity_verification_unconfigured");
    expect(await redemptionSnapshot(
      noSecret.participant.participant_uuid,
      noSecret.participant.pre_visit_id,
      noSecret.invitation.invite_id,
    )).toEqual(beforeRedeem);
  });

  it("rejects incomplete or wrong-ID first claims without mutation, then binds the first valid name atomically", async () => {
    const participantId = 991_101;
    const created = await createIdOnlyParticipant(participantId);
    const participant = created.participant;
    const beforeFailures = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    const valid = redemptionBody(created, participantId, REGISTERED_NAME);
    const invalidBodies = [
      { ...valid, participant_id: undefined },
      { ...valid, participant_id: participantId + 1 },
      { ...valid, participant_name: undefined },
      { ...valid, participant_name: "" },
    ];
    for (const invalidBody of invalidBodies) {
      const failed = await api("/api/invitations/redeem", {
        method: "POST",
        body: { ...invalidBody, client_instance_id: crypto.randomUUID() },
      });
      expect(failed.response.status).toBe(409);
      expect(failed.json.error.code).toBe("participant_binding_mismatch");
      expectNoIdentityInternalsInApi(failed.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        participant.pre_visit_id,
        created.invitation.invite_id,
      )).toEqual(beforeFailures);
    }

    const successLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let redeemed;
    let capturedLogs;
    try {
      redeemed = await redeem(created, participantId, REGISTERED_NAME, { runtimeEnv: env });
      capturedLogs = [successLog.mock.calls, failureLog.mock.calls];
    } finally {
      successLog.mockRestore();
      failureLog.mockRestore();
    }
    expect(redeemed.response.status).toBe(200);
    expectNoIdentityInternalsInApi(redeemed.json);
    expectPlaintextNameAbsent(capturedLogs);

    const afterRedeem = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    expect(afterRedeem.visit.status).toBe("started");
    expect(afterRedeem.visit.active_session_epoch).toBe(1);
    expect(afterRedeem.sessions).toHaveLength(1);
    expect(afterRedeem.sessions[0].status).toBe("active");
    expect(afterRedeem.invitation.redeem_count).toBe(1);
    expect(afterRedeem.identity).toMatchObject({
      participant_uuid: participant.participant_uuid,
      normalization_version: "nfkc-whitespace-lower-v1",
      verifier_version: "hmac-sha256-v1",
      confirmation_count: 1,
    });
    expect(afterRedeem.identity.verifier_hex).toMatch(/^[0-9a-f]{64}$/u);
    expect(afterRedeem.identity.last_confirmed_at_ms).not.toBeNull();
    expect(actionCounts(afterRedeem.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 1,
      participant_identity_registered: 1,
      invitation_redeemed: 1,
    });
    expect(afterRedeem.audits.find(
      (row) => row.action === "participant_identity_registered",
    )?.actor_type).toBe("participant");
    expectPlaintextNameAbsent(afterRedeem);

    const identityColumns = await all("PRAGMA table_info(participant_identity_bindings)");
    expect(identityColumns.map((column) => column.name)).not.toContain("participant_name");
  });

  it("accepts a normalized-equivalent entry on a fresh invitation and rejects a different name with zero mutation", async () => {
    const participantId = 991_201;
    const created = await createIdOnlyParticipant(participantId);
    const firstRedeem = await redeem(created, participantId, REGISTERED_NAME);
    expect(firstRedeem.response.status).toBe(200);
    const participant = created.participant;
    const freshInvitation = await api(
      `/api/admin/visits/${participant.pre_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    expect(freshInvitation.response.status).toBe(201);
    const freshCreated = {
      ...created,
      invitation: freshInvitation.json.invitation,
    };

    const beforeMismatch = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      freshCreated.invitation.invite_id,
    );
    expect(beforeMismatch.invitation.redeem_count).toBe(0);
    const mismatch = await redeem(freshCreated, participantId, DIFFERENT_NAME);
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.json.error.code).toBe("participant_binding_mismatch");
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      freshCreated.invitation.invite_id,
    )).toEqual(beforeMismatch);

    const equivalent = await redeem(freshCreated, participantId, EQUIVALENT_NAME);
    expect(equivalent.response.status).toBe(200);
    const afterEquivalent = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      freshCreated.invitation.invite_id,
    );
    expect(afterEquivalent.identity).toMatchObject({
      verifier_hex: beforeMismatch.identity.verifier_hex,
      normalization_version: beforeMismatch.identity.normalization_version,
      verifier_version: beforeMismatch.identity.verifier_version,
      created_at_ms: beforeMismatch.identity.created_at_ms,
      confirmation_count: 2,
    });
    expect(afterEquivalent.sessions).toHaveLength(2);
    expect(afterEquivalent.sessions.filter((row) => row.status === "active")).toHaveLength(1);
    expect(afterEquivalent.sessions.filter((row) => row.status === "superseded")).toHaveLength(1);
    expect(afterEquivalent.visit.active_session_epoch).toBe(3);
    expect(afterEquivalent.invitation.redeem_count).toBe(1);
    expect(beforeMismatch.invitation.first_redeemed_at_ms).toBeNull();
    expect(afterEquivalent.invitation.first_redeemed_at_ms).not.toBeNull();
    expect(actionCounts(afterEquivalent.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 2,
      participant_identity_registered: 1,
      invitation_redeemed: 2,
    });
  });

  it("allows exactly one atomic winner when different names race to claim an unbound invitation", async () => {
    const participantId = 991_301;
    const created = await createIdOnlyParticipant(participantId);
    const claims = [REGISTERED_NAME, DIFFERENT_NAME];
    const raceEnv = envWithDatabase(databaseWithBatchBarrier(env.DB));
    const results = await Promise.all(claims.map((name, index) => redeem(
      created,
      participantId,
      name,
      {
        clientInstanceId: `99100301-0000-4000-8000-00000000000${index + 1}`,
        runtimeEnv: raceEnv,
      },
    )));
    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    const winnerIndex = results.findIndex(({ response }) => response.status === 200);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    expect(results[loserIndex].json.session_token).toBeUndefined();
    expect(results[loserIndex].json.error.code).toBe("invitation_redeem_conflict");

    const participant = created.participant;
    const afterRace = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    const expectedWinnerBinding = await createParticipantIdentityBinding({
      identitySecret: env.IDENTITY_SECRET,
      participantUuid: participant.participant_uuid,
      participantId,
      participantName: claims[winnerIndex],
    });
    expect(afterRace.identity.verifier_hex).toBe(expectedWinnerBinding.verifier_hex);
    expect(afterRace.identity.confirmation_count).toBe(1);
    expect(afterRace.sessions).toHaveLength(1);
    expect(afterRace.sessions[0].status).toBe("active");
    expect(afterRace.visit.active_session_epoch).toBe(1);
    expect(afterRace.invitation.redeem_count).toBe(1);
    expect(actionCounts(afterRace.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 1,
      participant_identity_registered: 1,
      invitation_redeemed: 1,
    });

    const loserRetryBefore = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    const loserRetry = await redeem(created, participantId, claims[loserIndex]);
    expect(loserRetry.response.status).toBe(409);
    expect(loserRetry.json.error.code).toBe("participant_binding_mismatch");
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    )).toEqual(loserRetryBefore);
  });

  it("preserves a pre-existing binding and never lets participant input overwrite it", async () => {
    const participantId = 991_401;
    const created = await createIdOnlyParticipant(participantId);
    const participant = created.participant;
    const binding = await createParticipantIdentityBinding({
      identitySecret: env.IDENTITY_SECRET,
      participantUuid: participant.participant_uuid,
      participantId,
      participantName: REGISTERED_NAME,
    });
    await env.DB.prepare(`
      INSERT INTO participant_identity_bindings (
        participant_uuid, verifier_hex, normalization_version, verifier_version,
        created_at_ms
      ) VALUES (?, ?, ?, ?, 123)
    `).bind(
      participant.participant_uuid,
      binding.verifier_hex,
      binding.normalization_version,
      binding.verifier_version,
    ).run();

    const beforeMismatch = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    const mismatch = await redeem(created, participantId, DIFFERENT_NAME);
    expect(mismatch.response.status).toBe(409);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    )).toEqual(beforeMismatch);

    const accepted = await redeem(created, participantId, EQUIVALENT_NAME);
    expect(accepted.response.status).toBe(200);
    const afterAccepted = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    expect(afterAccepted.identity).toMatchObject({
      verifier_hex: binding.verifier_hex,
      created_at_ms: 123,
      confirmation_count: 1,
    });
    expect(actionCounts(afterAccepted.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 1,
      invitation_redeemed: 1,
    });
    expect(await verifyParticipantIdentityBinding({
      identitySecret: env.IDENTITY_SECRET,
      participantUuid: participant.participant_uuid,
      participantId,
      participantName: REGISTERED_NAME,
      binding: afterAccepted.identity,
    })).toBe(true);
  });

  it("rolls back a first name binding if a later session write in the same batch fails", async () => {
    const participantId = 991_501;
    const created = await createIdOnlyParticipant(participantId);
    const participant = created.participant;
    const beforeFailure = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    );
    await env.DB.prepare(`
      CREATE TRIGGER test_reject_identity_session
      BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'test_session_rejected');
      END
    `).run();
    const failed = await redeem(created, participantId, REGISTERED_NAME);
    expect(failed.response.status).toBe(409);
    expect(failed.json.error.code).toBe("invitation_redeem_conflict");
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      created.invitation.invite_id,
    )).toEqual(beforeFailure);
    await env.DB.prepare("DROP TRIGGER test_reject_identity_session").run();

    const retry = await redeem(created, participantId, REGISTERED_NAME);
    expect(retry.response.status).toBe(200);
  });
});
