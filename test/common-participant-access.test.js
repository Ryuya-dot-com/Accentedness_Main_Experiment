import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function api(path, { method = "GET", token = null, body = null } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  }));
  const json = (response.headers.get("Content-Type") ?? "").includes("application/json")
    ? await response.json()
    : null;
  return { response, json };
}

async function count(table) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
  return Number(row.count);
}

function startBody(participantId, overrides = {}) {
  return {
    participant_id: participantId,
    expected_visit_type: "pre",
    client_instance_id: crypto.randomUUID(),
    participant_id_confirmed: true,
    ...overrides,
  };
}

describe("common participant task URLs", () => {
  it("creates the immutable participant design only after first Pre ID confirmation", async () => {
    const participantId = 701_001;
    const before = {
      participants: await count("participants"),
      names: await count("participant_names"),
      manifests: await count("trial_manifest"),
    };

    const started = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(started.response.status).toBe(200);
    expect(started.json).toMatchObject({
      ok: true,
      participant: { id: participantId },
      visit: { visit_type: "pre" },
    });
    expect(started.json.session_token).toEqual(expect.any(String));
    expect(await count("participant_names")).toBe(before.names);
    expect(started.json.participant).not.toHaveProperty("training_accent");
    expect(started.json.participant).not.toHaveProperty("counterbalance_cell");

    const participant = await env.DB.prepare(`
      SELECT * FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM trial_manifest tm
      JOIN visits v ON v.visit_uuid = tm.visit_uuid
      WHERE v.participant_uuid = ?
    `).bind(participant.participant_uuid).first()).toMatchObject({ count: 290 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM item_assignments WHERE participant_uuid = ?
    `).bind(participant.participant_uuid).first()).toMatchObject({ count: 24 });
    const creationAudit = await env.DB.prepare(`
      SELECT actor_type, details_json FROM audit_log
      WHERE participant_uuid = ? AND action = 'participant_created' LIMIT 1
    `).bind(participant.participant_uuid).first();
    expect(creationAudit.actor_type).toBe("participant");
    expect(JSON.parse(creationAudit.details_json).source).toBe("first_pre_common_entry");
  });

  it("resumes by ID without regenerating assignment", async () => {
    const participantId = 701_002;
    const first = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(first.response.status).toBe(200);
    const before = await env.DB.prepare(`
      SELECT participant_uuid, root_seed_hex, assignment_json
      FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();
    const manifestBefore = await env.DB.prepare(`
      SELECT visit_type, manifest_hash FROM visits
      WHERE participant_uuid = ? ORDER BY visit_type
    `).bind(before.participant_uuid).all();

    const resumed = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(resumed.response.status).toBe(200);
    expect(resumed.json.session.epoch).toBe(2);
    const after = await env.DB.prepare(`
      SELECT participant_uuid, root_seed_hex, assignment_json
      FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();
    const manifestAfter = await env.DB.prepare(`
      SELECT visit_type, manifest_hash FROM visits
      WHERE participant_uuid = ? ORDER BY visit_type
    `).bind(after.participant_uuid).all();
    expect(after).toEqual(before);
    expect(manifestAfter.results).toEqual(manifestBefore.results);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM participants WHERE numeric_id = ?
    `).bind(participantId).first()).toMatchObject({ count: 1 });
  });

  it("keeps one immutable design and one active session under a concurrent first start", async () => {
    const participantId = 701_010;
    const starts = await Promise.all([
      api("/api/participant-access/start", {
        method: "POST",
        body: startBody(participantId),
      }),
      api("/api/participant-access/start", {
        method: "POST",
        body: startBody(participantId),
      }),
    ]);
    expect(starts.some(({ response }) => response.status === 200)).toBe(true);
    expect(starts.every(({ response, json }) => (
      response.status === 200
      || (response.status === 409 && json.error.code === "participant_access_start_conflict")
    ))).toBe(true);
    const participant = await env.DB.prepare(`
      SELECT participant_uuid FROM participants WHERE numeric_id = ?
    `).bind(participantId).first();
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM participants WHERE numeric_id = ?
    `).bind(participantId).first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM visits WHERE participant_uuid = ?
    `).bind(participant.participant_uuid).first()).toMatchObject({ count: 3 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM trial_manifest tm
      JOIN visits v ON v.visit_uuid = tm.visit_uuid WHERE v.participant_uuid = ?
    `).bind(participant.participant_uuid).first()).toMatchObject({ count: 290 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM sessions s JOIN visits v ON v.visit_uuid = s.visit_uuid
      WHERE v.participant_uuid = ? AND s.status = 'active'
    `).bind(participant.participant_uuid).first()).toMatchObject({ count: 1 });
    expect(await count("participant_names")).toBe(0);
  });

  it("does not create a participant from a later common URL", async () => {
    const participantId = 701_003;
    const before = await count("participants");
    const start = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, { expected_visit_type: "immediate" }),
    });
    expect(start.response.status).toBe(404);
    expect(start.json.error.code).toBe("participant_not_registered");
    expect(await count("participants")).toBe(before);
  });

  it("rejects every participant-name field without changing state", async () => {
    const participantId = 701_004;
    const first = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(first.response.status).toBe(200);
    const invitationsBefore = await count("invitations");
    const overwrite = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, { participant_name: "別人 氏名" }),
    });
    expect(overwrite.response.status).toBe(422);
    expect(overwrite.json.error.code).toBe("participant_name_not_accepted");
    expect(await count("participant_names")).toBe(0);
    expect(await count("invitations")).toBe(invitationsBefore);
  });

  it("does not create a design when the first Pre start request is not startable", async () => {
    const participantId = 701_006;
    const before = {
      participants: await count("participants"),
      invitations: await count("invitations"),
    };
    const invalidClient = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, { client_instance_id: "not-a-uuid" }),
    });
    expect(invalidClient.response.status).toBe(400);
    expect(invalidClient.json.error.code).toBe("invalid_identifier");
    expect({
      participants: await count("participants"),
      invitations: await count("invitations"),
    }).toEqual(before);
  });

  it("enforces Pre order and the five-day delayed gate on common URLs", async () => {
    const participantId = 701_005;
    const pre = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(pre.response.status).toBe(200);
    const participant = await env.DB.prepare(`
      SELECT participant_uuid FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();

    const immediateBeforePre = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, {
        expected_visit_type: "immediate",
      }),
    });
    expect(immediateBeforePre.response.status).toBe(409);
    expect(immediateBeforePre.json.error.code).toBe("pre_not_completed");

    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = ?, updated_at_ms = ?
      WHERE participant_uuid = ? AND visit_type = 'pre'
    `).bind(Date.now(), Date.now(), participant.participant_uuid).run();
    const immediate = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, {
        expected_visit_type: "immediate",
      }),
    });
    expect(immediate.response.status).toBe(200);
    expect(immediate.json).toMatchObject({
      participant: { id: participantId },
      visit: { visit_type: "immediate" },
      next_route: "/main-experiment/",
    });

    const delayedBeforeImmediate = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, {
        expected_visit_type: "delayed",
      }),
    });
    expect(delayedBeforeImmediate.response.status).toBe(409);
    expect(delayedBeforeImmediate.json.error.code).toBe("immediate_not_completed");

    const future = Date.now() + 86_400_000;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'completed', finalized_at_ms = ?, updated_at_ms = ?
        WHERE participant_uuid = ? AND visit_type = 'immediate'
      `).bind(Date.now(), Date.now(), participant.participant_uuid),
      env.DB.prepare(`
        UPDATE visits SET target_at_ms = ?, available_at_ms = ?, updated_at_ms = ?
        WHERE participant_uuid = ? AND visit_type = 'delayed'
      `).bind(future, future, Date.now(), participant.participant_uuid),
    ]);
    const delayedEarly = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, {
        expected_visit_type: "delayed",
      }),
    });
    expect(delayedEarly.response.status).toBe(403);
    expect(delayedEarly.json.error).toMatchObject({
      code: "visit_not_available",
      details: { available_at_ms: future },
    });
  });

  it("keeps a pause intact after an invalid restart and resumes it atomically with a valid session", async () => {
    const participantId = 701_007;
    const first = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(first.response.status).toBe(200);
    const participant = await env.DB.prepare(`
      SELECT participant_uuid FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();
    const nowMs = Date.now();
    const interruptionUuid = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO participation_interruptions (
          interruption_uuid, request_uuid, participant_uuid, visit_uuid,
          requested_session_uuid, mode, state, requested_at_ms, finalized_at_ms,
          accepted_trial_count, next_ordinal
        ) VALUES (?, ?, ?, ?, ?, 'pause', 'paused', ?, ?, 0, 1)
      `).bind(
        interruptionUuid,
        crypto.randomUUID(),
        participant.participant_uuid,
        first.json.visit.visit_id,
        first.json.session.session_id,
        nowMs,
        nowMs,
      ),
      env.DB.prepare(`
        UPDATE sessions SET status = 'closed', closed_at_ms = ?
        WHERE session_uuid = ?
      `).bind(nowMs, first.json.session.session_id),
    ]);
    const sessionsBefore = await count("sessions");
    const auditsBefore = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE participant_uuid = ? AND action = 'participation_resumed'
    `).bind(participant.participant_uuid).first();

    const invalid = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId, { participant_id_confirmed: false }),
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.json.error.code).toBe("participant_id_confirmation_required");
    expect(await env.DB.prepare(`
      SELECT state, resumed_at_ms FROM participation_interruptions
      WHERE interruption_uuid = ?
    `).bind(interruptionUuid).first()).toMatchObject({
      state: "paused",
      resumed_at_ms: null,
    });
    expect(await count("sessions")).toBe(sessionsBefore);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE participant_uuid = ? AND action = 'participation_resumed'
    `).bind(participant.participant_uuid).first()).toEqual(auditsBefore);

    const resumed = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(resumed.response.status).toBe(200);
    expect(resumed.json.session.epoch).toBe(2);
    expect(await env.DB.prepare(`
      SELECT state, resumed_at_ms FROM participation_interruptions
      WHERE interruption_uuid = ?
    `).bind(interruptionUuid).first()).toMatchObject({
      state: "resumed",
      resumed_at_ms: expect.any(Number),
    });
    expect(await count("sessions")).toBe(sessionsBefore + 1);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE visit_uuid = ? AND status = 'active'
    `).bind(first.json.visit.visit_id).first()).toMatchObject({ count: 1 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_log
      WHERE participant_uuid = ? AND action = 'participation_resumed'
    `).bind(participant.participant_uuid).first()).toMatchObject({
      count: Number(auditsBefore.count) + 1,
    });
  });

  it("reopens the same visit to finish a requested interruption without enabling new trials", async () => {
    const participantId = 701_009;
    const first = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(first.response.status).toBe(200);
    const participant = await env.DB.prepare(`
      SELECT participant_uuid FROM participants WHERE numeric_id = ? LIMIT 1
    `).bind(participantId).first();
    const nowMs = Date.now();
    const interruptionUuid = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO participation_interruptions (
        interruption_uuid, request_uuid, participant_uuid, visit_uuid,
        requested_session_uuid, mode, state, requested_at_ms,
        accepted_trial_count, next_ordinal
      ) VALUES (?, ?, ?, ?, ?, 'terminate', 'requested', ?, 0, 1)
    `).bind(
      interruptionUuid,
      crypto.randomUUID(),
      participant.participant_uuid,
      first.json.visit.visit_id,
      first.json.session.session_id,
      nowMs,
    ).run();
    const invitationsBefore = await count("invitations");
    const sessionsBefore = await count("sessions");

    const recovered = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(recovered.response.status).toBe(200);
    expect(recovered.json.session.epoch).toBe(2);
    expect(recovered.json.participation_control).toMatchObject({
      trial_start_allowed: false,
      interruption: {
        interruption_id: interruptionUuid,
        mode: "terminate",
        state: "requested",
      },
    });
    expect(await count("invitations")).toBe(invitationsBefore);
    expect(await count("sessions")).toBe(sessionsBefore + 1);
    expect(await env.DB.prepare(`
      SELECT state, resumed_at_ms FROM participation_interruptions
      WHERE interruption_uuid = ?
    `).bind(interruptionUuid).first()).toMatchObject({
      state: "requested",
      resumed_at_ms: null,
    });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM sessions
      WHERE visit_uuid = ? AND status = 'active'
    `).bind(first.json.visit.visit_id).first()).toMatchObject({ count: 1 });
  });

  it("rejects prefixed, leading-zero, and reserved 999 IDs without persistence", async () => {
    const before = await count("participants");
    for (const participantId of ["P01", "sub01", "01", "999"]) {
      const start = await api("/api/participant-access/start", {
        method: "POST",
        body: startBody(participantId),
      });
      expect(start.response.status).toBe(400);
      expect(start.json.error.code).toBe(
        participantId === "999" ? "reserved_test_participant_id" : "invalid_participant_id",
      );
    }
    const admin999 = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 999 },
    });
    expect(admin999.response.status).toBe(404);
    expect(await count("participants")).toBe(before);
  });

  it("gives the operator a read-only, name-free status view for a started ID", async () => {
    const participantId = 701_008;
    const started = await api("/api/participant-access/start", {
      method: "POST",
      body: startBody(participantId),
    });
    expect(started.response.status).toBe(200);

    const unauthorized = await api(`/api/admin/participants/${participantId}`);
    expect(unauthorized.response.status).toBe(401);
    const status = await api(`/api/admin/participants/${participantId}`, {
      token: ADMIN_TOKEN,
    });
    expect(status.response.status).toBe(200);
    expect(status.json.participant).toMatchObject({
      participant_id: participantId,
      status: "active",
    });
    expect(status.json.participant).not.toHaveProperty("participant_name_registered");
    expect(status.json.visits).toHaveLength(3);
    expect(status.json.visits[0]).toMatchObject({
      visit_type: "pre",
      status: "started",
      accepted_trials: 0,
      pending_recordings: 0,
    });
    expect(await count("participant_names")).toBe(0);
    expect(status.json.participant).not.toHaveProperty("training_accent");

    const unknown = await api("/api/admin/participants/888888", {
      token: ADMIN_TOKEN,
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.json.error.code).toBe("participant_not_found");
  });
});
