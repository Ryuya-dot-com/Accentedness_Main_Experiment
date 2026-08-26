import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { sha256Hex } from "../src/lib/crypto.js";
import { normalizeParticipantName } from "../src/lib/participant-identity.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const REGISTERED_NAME = "　Ｑｕａｓａｒ　Ｉｄｅｎｔｉｔｙ　Ｍａｒｋｅｒ　";
const DIFFERENT_NAME = "Nebula Continuity Marker";
const CANONICAL_NAME = "Quasar Identity Marker";
const NAME_MARKERS = ["quasar identity marker", "nebula continuity marker"];

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

function expectParticipantNameAbsent(value) {
  const serialized = normalizedSearchText(value);
  for (const marker of NAME_MARKERS) expect(serialized).not.toContain(marker);
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

function expectParticipantNameFieldAbsent(value) {
  expect(nestedKeys(value)).not.toContain("participant_name");
  expectParticipantNameAbsent(value);
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
    participantName: await first(
      "SELECT * FROM participant_names WHERE participant_uuid = ?",
      participantUuid,
    ),
    sessions: await all(
      "SELECT * FROM sessions WHERE visit_uuid = ? ORDER BY epoch, session_uuid",
      visitUuid,
    ),
    audits: await participantAuditRows(participantUuid),
  };
}

async function createIdOnlyParticipant(participantId) {
  const created = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { participant_id: participantId },
  });
  expect(created.response.status).toBe(201);
  expectParticipantNameFieldAbsent(created.json);
  return created.json;
}

function invitationContext(created, {
  invitation = created.invitation,
  visitType = "pre",
  visitId = created.participant.pre_visit_id,
} = {}) {
  return {
    participant: created.participant,
    invitation,
    visitType,
    visitId,
  };
}

function invitationBody(context, participantId, overrides = {}) {
  return {
    token: invitationToken(context.invitation.invitation_url),
    participant_id: participantId,
    expected_visit_type: context.visitType,
    ...overrides,
  };
}

async function previewName(context, participantId, options = {}) {
  const body = invitationBody(context, participantId, {
    ...(options.expectedVisitType === undefined
      ? {}
      : { expected_visit_type: options.expectedVisitType }),
  });
  if (options.token !== undefined) body.token = options.token;
  return api("/api/invitations/name-preview", {
    method: "POST",
    body,
    runtimeEnv: options.runtimeEnv ?? null,
  });
}

async function redeem(context, participantId, options = {}) {
  const body = invitationBody(context, participantId, {
    client_instance_id: options.clientInstanceId ?? crypto.randomUUID(),
    name_action: options.nameAction ?? "register",
  });
  if (!options.omitConfirmation) {
    body.participant_name_confirmed = options.confirmed ?? true;
  }
  if (options.participantName !== undefined) {
    body.participant_name = options.participantName;
  }
  return api("/api/invitations/redeem", {
    method: "POST",
    body,
    runtimeEnv: options.runtimeEnv ?? null,
  });
}

async function issueInvitation(visitId) {
  const issued = await api(`/api/admin/visits/${visitId}/invitations`, {
    method: "POST",
    token: ADMIN_TOKEN,
    body: {},
  });
  expect(issued.response.status).toBe(201);
  return issued.json.invitation;
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

describe("participant-entered plaintext name confirmation", () => {
  it("keeps admin registration ID-only and enforces the minimal Pre-sourced name schema", async () => {
    const created = await createIdOnlyParticipant(991_001);
    const participant = created.participant;
    expect(await first(
      "SELECT * FROM participant_names WHERE participant_uuid = ?",
      participant.participant_uuid,
    )).toBeNull();

    const columns = await all("PRAGMA table_info(participant_names)");
    expect(columns.map((column) => column.name)).toEqual([
      "participant_uuid",
      "registered_visit_uuid",
      "participant_name",
      "registered_at_ms",
    ]);

    const beforeStaleAdminRequest = {
      participants: await first("SELECT COUNT(*) AS count FROM participants"),
      names: await first("SELECT COUNT(*) AS count FROM participant_names"),
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
      names: await first("SELECT COUNT(*) AS count FROM participant_names"),
      audits: await first("SELECT COUNT(*) AS count FROM audit_log"),
    }).toEqual(beforeStaleAdminRequest);

    await expect(env.DB.prepare(`
      INSERT INTO participant_names (
        participant_uuid, registered_visit_uuid, participant_name, registered_at_ms
      ) VALUES (?, ?, ?, ?)
    `).bind(
      participant.participant_uuid,
      participant.immediate_visit_id,
      "Must Not Register Outside Pre",
      Date.now(),
    ).run()).rejects.toThrow();
    expect(await first(
      "SELECT * FROM participant_names WHERE participant_uuid = ?",
      participant.participant_uuid,
    )).toBeNull();
  });

  it("previews registration without mutation and rejects invalid names or missing confirmation", async () => {
    const participantId = 991_101;
    const created = await createIdOnlyParticipant(participantId);
    const context = invitationContext(created);
    const participant = created.participant;
    const before = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );

    const preview = await previewName(context, participantId);
    expect(preview.response.status).toBe(200);
    expect(preview.response.headers.get("Cache-Control")).toContain("no-store");
    expect(preview.json).toMatchObject({ ok: true, name_action: "register" });
    expect(preview.json).not.toHaveProperty("participant_name");
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(before);

    for (const participantName of [
      undefined,
      "",
      "Invalid\nName",
      "a".repeat(81),
      "😀".repeat(65),
    ]) {
      const failed = await redeem(context, participantId, {
        participantName,
        nameAction: "register",
      });
      expect(failed.response.status).toBe(422);
      expectParticipantNameAbsent(failed.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        context.visitId,
        context.invitation.invite_id,
      )).toEqual(before);
    }

    for (const confirmationOptions of [
      { participantName: REGISTERED_NAME, confirmed: false },
      { participantName: REGISTERED_NAME, omitConfirmation: true },
    ]) {
      const failed = await redeem(context, participantId, confirmationOptions);
      expect(failed.response.status).toBe(422);
      expectParticipantNameFieldAbsent(failed.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        context.visitId,
        context.invitation.invite_id,
      )).toEqual(before);
    }

    const wrongAction = await redeem(context, participantId, {
      nameAction: "confirm",
    });
    expect(wrongAction.response.status).toBe(409);
    expectParticipantNameFieldAbsent(wrongAction.json);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(before);
  });

  it("atomically registers the canonical plaintext only in D1 and exposes it only through preview", async () => {
    const participantId = 991_201;
    const created = await createIdOnlyParticipant(participantId);
    const context = invitationContext(created);
    const participant = created.participant;
    const successLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let registered;
    let capturedLogs;
    try {
      registered = await redeem(context, participantId, {
        participantName: REGISTERED_NAME,
      });
      capturedLogs = [successLog.mock.calls, failureLog.mock.calls];
    } finally {
      successLog.mockRestore();
      failureLog.mockRestore();
    }
    expect(registered.response.status).toBe(200);
    expectParticipantNameFieldAbsent(registered.json);
    expectParticipantNameAbsent(capturedLogs);

    const after = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );
    expect(after.participantName).toEqual({
      participant_uuid: participant.participant_uuid,
      registered_visit_uuid: participant.pre_visit_id,
      participant_name: CANONICAL_NAME,
      registered_at_ms: expect.any(Number),
    });
    expect(after.visit.status).toBe("started");
    expect(after.visit.active_session_epoch).toBe(1);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions[0].status).toBe("active");
    expect(after.invitation.redeem_count).toBe(1);
    expect(actionCounts(after.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 1,
      participant_name_registered: 1,
      invitation_redeemed: 1,
    });
    expectParticipantNameAbsent(after.audits);
    expect(normalizeParticipantName(REGISTERED_NAME)).toBe(CANONICAL_NAME);

    const namePreview = await previewName(context, participantId);
    expect(namePreview.response.status).toBe(200);
    expect(namePreview.response.headers.get("Cache-Control")).toContain("no-store");
    expect(namePreview.json).toMatchObject({
      ok: true,
      name_action: "confirm",
      participant_name: CANONICAL_NAME,
    });

    const sessionState = await api("/api/session", {
      token: registered.json.session_token,
    });
    expect(sessionState.response.status).toBe(200);
    expectParticipantNameFieldAbsent(sessionState.json);

    const adminLookup = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: participantId, issue_pre_invitation: false },
    });
    expect(adminLookup.response.status).toBe(200);
    expectParticipantNameFieldAbsent(adminLookup.json);

    const adminSummary = await api("/api/admin/summary", { token: ADMIN_TOKEN });
    expect(adminSummary.response.status).toBe(200);
    expectParticipantNameFieldAbsent(adminSummary.json);

    const unavailableCopy = await api("/api/visit/results.zip", {
      token: registered.json.session_token,
    });
    expect(unavailableCopy.response.status).toBe(403);
    expectParticipantNameFieldAbsent(unavailableCopy.json);
  });

  it("never discloses an existing name for a wrong token, ID, route, unavailable time, or closed visit", async () => {
    const participantId = 991_301;
    const created = await createIdOnlyParticipant(participantId);
    const firstContext = invitationContext(created);
    expect((await redeem(firstContext, participantId, {
      participantName: REGISTERED_NAME,
    })).response.status).toBe(200);
    const freshInvitation = await issueInvitation(created.participant.pre_visit_id);
    const context = invitationContext(created, { invitation: freshInvitation });
    const participant = created.participant;

    async function expectFailedPreviewWithoutMutation(options, expectedStatus) {
      const before = await redemptionSnapshot(
        participant.participant_uuid,
        context.visitId,
        context.invitation.invite_id,
      );
      const failed = await previewName(
        context,
        options.participantId ?? participantId,
        options,
      );
      expect(failed.response.status).toBe(expectedStatus);
      expectParticipantNameFieldAbsent(failed.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        context.visitId,
        context.invitation.invite_id,
      )).toEqual(before);
    }

    await expectFailedPreviewWithoutMutation({ token: "A".repeat(43) }, 404);
    await expectFailedPreviewWithoutMutation({ participantId: participantId + 1 }, 409);
    await expectFailedPreviewWithoutMutation({ expectedVisitType: "immediate" }, 409);

    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = ? WHERE visit_uuid = ?
    `).bind(Date.now() + 86_400_000, context.visitId).run();
    await expectFailedPreviewWithoutMutation({}, 403);

    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = NULL, status = 'completed' WHERE visit_uuid = ?
    `).bind(context.visitId).run();
    await expectFailedPreviewWithoutMutation({}, 409);
  });

  it("blocks later invitation issuance and rejects a forged Immediate registration without a Pre name", async () => {
    const participantId = 991_401;
    const created = await createIdOnlyParticipant(participantId);
    const participant = created.participant;
    const nowMs = Date.now();
    await env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(nowMs, nowMs, nowMs, participant.pre_visit_id).run();
    const invitationCountBefore = await first(`
      SELECT COUNT(*) AS count FROM invitations WHERE visit_uuid = ?
    `, participant.immediate_visit_id);
    const refusedInvitation = await api(
      `/api/admin/visits/${participant.immediate_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    expect(refusedInvitation.response.status).toBe(409);
    expect(refusedInvitation.json.error.code).toBe("participant_name_not_registered");
    expectParticipantNameFieldAbsent(refusedInvitation.json);
    expect(await first(`
      SELECT COUNT(*) AS count FROM invitations WHERE visit_uuid = ?
    `, participant.immediate_visit_id)).toEqual(invitationCountBefore);

    const rawToken = "I".repeat(43);
    const inviteUuid = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO invitations (
          invite_uuid, visit_uuid, generation, token_hash, status, issued_at_ms
        ) VALUES (?, ?, 1, ?, 'active', ?)
      `).bind(
        inviteUuid,
        participant.immediate_visit_id,
        await sha256Hex(rawToken),
        nowMs,
      ),
      env.DB.prepare(`
        UPDATE visits SET status = 'invited', updated_at_ms = ? WHERE visit_uuid = ?
      `).bind(nowMs, participant.immediate_visit_id),
    ]);
    const immediateInvitation = {
      invite_id: inviteUuid,
      invitation_url: `${ORIGIN}/main-experiment/#t=${rawToken}`,
    };
    const context = invitationContext(created, {
      invitation: immediateInvitation,
      visitType: "immediate",
      visitId: participant.immediate_visit_id,
    });
    const before = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );

    const preview = await previewName(context, participantId);
    expect(preview.response.status).toBe(409);
    expectParticipantNameFieldAbsent(preview.json);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(before);

    const lateRegistration = await redeem(context, participantId, {
      nameAction: "register",
      participantName: REGISTERED_NAME,
    });
    expect(lateRegistration.response.status).toBe(409);
    expectParticipantNameFieldAbsent(lateRegistration.json);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(before);
  });

  it("confirms an immutable stored name on a fresh invitation and rejects stale or ambiguous payloads", async () => {
    const participantId = 991_501;
    const created = await createIdOnlyParticipant(participantId);
    const firstContext = invitationContext(created);
    expect((await redeem(firstContext, participantId, {
      participantName: REGISTERED_NAME,
    })).response.status).toBe(200);
    const freshInvitation = await issueInvitation(created.participant.pre_visit_id);
    const context = invitationContext(created, { invitation: freshInvitation });
    const participant = created.participant;
    const before = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );

    const preview = await previewName(context, participantId);
    expect(preview.response.status).toBe(200);
    expect(preview.json).toMatchObject({
      name_action: "confirm",
      participant_name: CANONICAL_NAME,
    });
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(before);

    const rejectedRequests = [
      { nameAction: "register", participantName: DIFFERENT_NAME, expectedStatus: 409 },
      { nameAction: "confirm", confirmed: false, expectedStatus: 422 },
      { nameAction: "confirm", omitConfirmation: true, expectedStatus: 422 },
      { nameAction: "confirm", participantName: DIFFERENT_NAME, expectedStatus: 422 },
    ];
    for (const { expectedStatus, ...options } of rejectedRequests) {
      const rejected = await redeem(context, participantId, options);
      expect(rejected.response.status).toBe(expectedStatus);
      expectParticipantNameAbsent(rejected.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        context.visitId,
        context.invitation.invite_id,
      )).toEqual(before);
    }

    const confirmed = await redeem(context, participantId, {
      nameAction: "confirm",
    });
    expect(confirmed.response.status).toBe(200);
    expectParticipantNameFieldAbsent(confirmed.json);
    const after = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );
    expect(after.participantName).toEqual(before.participantName);
    expect(after.invitation.redeem_count).toBe(1);
    expect(after.sessions.filter((row) => row.status === "active")).toHaveLength(1);
    expectParticipantNameAbsent(after.audits);
  });

  it("allows exactly one atomic winner when different Pre names race to register", async () => {
    const participantId = 991_601;
    const created = await createIdOnlyParticipant(participantId);
    const context = invitationContext(created);
    const claims = [REGISTERED_NAME, DIFFERENT_NAME];
    const raceEnv = envWithDatabase(databaseWithBatchBarrier(env.DB));
    const results = await Promise.all(claims.map((participantName, index) => redeem(
      context,
      participantId,
      {
        participantName,
        clientInstanceId: `99100601-0000-4000-8000-00000000000${index + 1}`,
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
      context.visitId,
      context.invitation.invite_id,
    );
    expect(afterRace.participantName.participant_name).toBe(
      normalizeParticipantName(claims[winnerIndex]),
    );
    expect(afterRace.sessions).toHaveLength(1);
    expect(afterRace.sessions[0].status).toBe("active");
    expect(afterRace.visit.active_session_epoch).toBe(1);
    expect(afterRace.invitation.redeem_count).toBe(1);
    expect(actionCounts(afterRace.audits)).toEqual({
      participant_created: 1,
      invitation_issued: 1,
      participant_name_registered: 1,
      invitation_redeemed: 1,
    });
    expectParticipantNameAbsent(afterRace.audits);

    const loserRetryBefore = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );
    const loserRetry = await redeem(context, participantId, {
      participantName: claims[loserIndex],
      nameAction: "register",
    });
    expect(loserRetry.response.status).toBe(409);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(loserRetryBefore);

    const rePreview = await previewName(context, participantId);
    expect(rePreview.json).toMatchObject({
      name_action: "confirm",
      participant_name: normalizeParticipantName(claims[winnerIndex]),
    });
  });

  it("rolls back first-name registration when a later session write in the batch fails", async () => {
    const participantId = 991_701;
    const created = await createIdOnlyParticipant(participantId);
    const context = invitationContext(created);
    const participant = created.participant;
    const beforeFailure = await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    );
    await env.DB.prepare(`
      CREATE TRIGGER test_reject_plaintext_name_session
      BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'test_session_rejected');
      END
    `).run();
    const failed = await redeem(context, participantId, {
      participantName: REGISTERED_NAME,
    });
    expect(failed.response.status).toBe(409);
    expect(failed.json.error.code).toBe("invitation_redeem_conflict");
    expectParticipantNameFieldAbsent(failed.json);
    expect(await redemptionSnapshot(
      participant.participant_uuid,
      context.visitId,
      context.invitation.invite_id,
    )).toEqual(beforeFailure);
    await env.DB.prepare("DROP TRIGGER test_reject_plaintext_name_session").run();

    const retry = await redeem(context, participantId, {
      participantName: REGISTERED_NAME,
    });
    expect(retry.response.status).toBe(200);
  });
});
