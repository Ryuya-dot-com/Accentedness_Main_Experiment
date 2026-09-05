import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

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

async function adminApi(path, options = {}) {
  return api(path, { ...options, token: ADMIN_TOKEN });
}

async function createParticipant(participantId) {
  const started = await api("/api/participant-access/start", {
    method: "POST",
    body: {
      participant_id: participantId,
      participant_id_confirmed: true,
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: "pre",
    },
  });
  expect(started.response.status).toBe(200);
  const rows = await env.DB.prepare(`
    SELECT p.participant_uuid, v.visit_uuid, v.visit_type
    FROM participants p JOIN visits v ON v.participant_uuid = p.participant_uuid
    WHERE p.numeric_id = ?
  `).bind(participantId).all();
  const participant = { participant_id: participantId, participant_uuid: rows.results[0].participant_uuid };
  for (const visit of rows.results) participant[`${visit.visit_type}_visit_id`] = visit.visit_uuid;
  return { participant, start: started.json };
}

async function listParticipants() {
  const result = await adminApi("/api/admin/participants");
  expect(result.response.status).toBe(200);
  return result.json;
}

function participantFrom(payload, participantId) {
  return payload.participants.find((participant) => participant.participant_id === participantId);
}

function visitFrom(participant, visitType) {
  return participant.visits.find((visit) => visit.visit_type === visitType);
}

async function markVisitComplete(visitId, completedAtMs) {
  const acceptedTrial = await env.DB.prepare(`
    SELECT trial_uuid FROM trial_manifest
    WHERE visit_uuid = ? AND expects_recording = 0
    ORDER BY ordinal LIMIT 1
  `).bind(visitId).first();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE trial_manifest SET canonical_attempt_uuid = ? WHERE trial_uuid = ?
    `).bind(crypto.randomUUID(), acceptedTrial.trial_uuid),
    env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', expected_trial_count = 1, expected_recording_count = 0,
          behavioral_completed_at_ms = ?, finalized_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(completedAtMs, completedAtMs, completedAtMs, visitId),
  ]);
}

async function majorTableCounts() {
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM participants) AS participants,
      (SELECT COUNT(*) FROM participant_names) AS participant_names,
      (SELECT COUNT(*) FROM visits) AS visits,
      (SELECT COUNT(*) FROM item_assignments) AS item_assignments,
      (SELECT COUNT(*) FROM segments) AS segments,
      (SELECT COUNT(*) FROM trial_manifest) AS trial_manifest,
      (SELECT COUNT(*) FROM trial_attempts) AS trial_attempts,
      (SELECT COUNT(*) FROM recordings) AS recordings,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM invitations) AS invitations,
      (SELECT COUNT(*) FROM participation_interruptions) AS participation_interruptions,
      (SELECT COUNT(*) FROM audit_log) AS audit_log
  `).first();
  return Object.fromEntries(
    Object.entries(counts).map(([tableName, count]) => [tableName, Number(count)]),
  );
}

describe("admin participant list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires admin authentication and returns only safe operational fields", async () => {
    const unauthorized = await api("/api/admin/participants");
    expect(unauthorized.response.status).toBe(401);

    const empty = await listParticipants();
    expect(empty).toMatchObject({ ok: true, participants: [] });
    expect(Number.isSafeInteger(empty.server_now_ms)).toBe(true);

    const created = await createParticipant(71);
    expect(created.participant.participant_id).toBe(71);

    const countsBeforeList = await majorTableCounts();
    const payload = await listParticipants();
    expect(await majorTableCounts()).toEqual(countsBeforeList);
    expect(payload.participants).toHaveLength(1);
    const participant = payload.participants[0];
    expect(participant).toMatchObject({
      participant_id: 71,
      status: "active",
      open_interruption: null,
      next_action: {
        code: "resume_pre",
        category: "in_progress",
        visit_type: "pre",
        path: "/pre-picture-naming/",
        reason: "in_progress",
        available_at_ms: null,
      },
    });
    expect(participant.visits.map((visit) => visit.visit_type)).toEqual([
      "pre",
      "immediate",
      "delayed",
    ]);
    expect(participant.visits.map((visit) => visit.expected_recordings)).toEqual([24, 54, 54]);
    expect(participant.visits.every((visit) => (
      visit.accepted_trials === 0
      && visit.accepted_recording_trials === 0
      && visit.uploaded_recordings === 0
      && visit.pending_recordings === 0
      && visit.missing_recordings === 0
      && visit.abandoned_recordings === 0
    ))).toBe(true);
    expect(participant.visits.map((visit) => visit.current_segment)).toEqual([
      "picture_naming",
      null,
      null,
    ]);
    expect(participant.visits.map((visit) => (
      visit.segments.map((segment) => [
        segment.segment,
        segment.status,
        segment.accepted_trials,
        segment.expected_trials,
      ])
    ))).toEqual([
      [["picture_naming", "pending", 0, 26]],
      [
        ["learning", "pending", 0, 146],
        ["picture_naming", "pending", 0, 26],
        ["l2_to_l1", "pending", 0, 33],
      ],
      [
        ["picture_naming", "pending", 0, 26],
        ["l2_to_l1", "pending", 0, 33],
      ],
    ]);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/participant_uuid|visit_uuid|interruption_uuid|r2_key|sha256|hash/iu);
    expect(serialized).not.toMatch(/training_accent|counterbalance|list_cell|order_cell|talker_cell/iu);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);
  });

  it("derives visit and segment progression, the delayed gate, completion, and withdrawal", async () => {
    const nowMs = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    const created = await createParticipant(72);
    const { pre_visit_id: preId, immediate_visit_id: immediateId, delayed_visit_id: delayedId }
      = created.participant;

    let participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "resume_pre",
      category: "in_progress",
      path: "/pre-picture-naming/",
    });
    expect(visitFrom(participant, "pre").current_segment).toBe("picture_naming");

    await markVisitComplete(preId, nowMs - 20);
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "start_immediate",
      category: "ready",
      visit_type: "immediate",
      path: "/main-experiment/",
      reason: "not_started",
    });

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'started', first_started_at_ms = ?, last_seen_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(nowMs - 10, nowMs - 5, immediateId),
      env.DB.prepare(`
        UPDATE segments SET status = 'started', started_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'learning'
      `).bind(nowMs - 10, immediateId),
    ]);
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "resume_immediate",
      category: "in_progress",
      path: "/main-experiment/",
    });
    expect(visitFrom(participant, "immediate").current_segment).toBe("learning");

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE segments
        SET status = 'completed', completed_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'learning'
      `).bind(nowMs - 4, immediateId),
      env.DB.prepare(`
        UPDATE segments SET status = 'started', started_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'picture_naming'
      `).bind(nowMs - 3, immediateId),
    ]);
    participant = participantFrom(await listParticipants(), 72);
    expect(visitFrom(participant, "immediate").current_segment).toBe("picture_naming");

    await markVisitComplete(immediateId, nowMs - 3);
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET available_at_ms = ?, target_at_ms = ?, updated_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(nowMs + 1, nowMs + 1, nowMs - 3, delayedId),
    ]);
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toEqual({
      code: "wait_delayed",
      category: "waiting",
      visit_type: "delayed",
      path: null,
      reason: "delayed_not_available",
      available_at_ms: nowMs + 1,
    });

    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = ?, target_at_ms = ? WHERE visit_uuid = ?
    `).bind(nowMs, nowMs, delayedId).run();
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "start_delayed",
      category: "ready",
      path: "/delayed-picture-naming/",
    });

    await env.DB.prepare(`
      UPDATE visits SET status = 'started', first_started_at_ms = ? WHERE visit_uuid = ?
    `).bind(nowMs, delayedId).run();
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "resume_delayed",
      category: "in_progress",
      path: "/delayed-picture-naming/",
    });
    expect(visitFrom(participant, "delayed").current_segment).toBe("picture_naming");

    await markVisitComplete(delayedId, nowMs);
    await env.DB.prepare(`UPDATE participants SET status = 'completed' WHERE numeric_id = 72`).run();
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "complete",
      category: "completed",
      visit_type: null,
      path: null,
      reason: "completed",
    });

    await env.DB.prepare(`UPDATE participants SET status = 'withdrawn' WHERE numeric_id = 72`).run();
    participant = participantFrom(await listParticipants(), 72);
    expect(participant.next_action).toMatchObject({
      code: "participation_ended",
      category: "ended",
      path: null,
      reason: "withdrawn",
    });
  });

  it("reports canonical recording integrity without treating future or practice trials as missing", async () => {
    const created = await createParticipant(73);
    const redeemed = created.start;
    const preId = created.participant.pre_visit_id;
    const recordedTrial = await env.DB.prepare(`
      SELECT trial_uuid FROM trial_manifest
      WHERE visit_uuid = ? AND expects_recording = 1
      ORDER BY ordinal LIMIT 1
    `).bind(preId).first();
    const attemptId = crypto.randomUUID();
    const nowMs = Date.now();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO trial_attempts (
          attempt_uuid, trial_uuid, attempt_no, session_uuid, start_key, response_key,
          state, server_started_at_ms, server_received_at_ms, payload_hash, payload_json
        ) VALUES (?, ?, 1, ?, ?, ?, 'response_saved', ?, ?, ?, ?)
      `).bind(
        attemptId,
        recordedTrial.trial_uuid,
        redeemed.session.session_id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        nowMs - 2,
        nowMs - 1,
        "a".repeat(64),
        "{}",
      ),
      env.DB.prepare(`
        UPDATE trial_manifest SET canonical_attempt_uuid = ? WHERE trial_uuid = ?
      `).bind(attemptId, recordedTrial.trial_uuid),
    ]);

    let participant = participantFrom(await listParticipants(), 73);
    let pre = visitFrom(participant, "pre");
    expect(pre).toMatchObject({
      accepted_trials: 1,
      accepted_recording_trials: 1,
      pending_recordings: 0,
      uploaded_recordings: 0,
      missing_recordings: 1,
      abandoned_recordings: 0,
      expected_recordings: 24,
    });
    expect(participant.next_action).toMatchObject({
      code: "review_state",
      category: "attention",
      reason: "canonical_recording_missing",
      path: null,
    });

    await env.DB.prepare(`
      INSERT INTO recordings (attempt_uuid, r2_key, state, updated_at_ms)
      VALUES (?, ?, 'pending', ?)
    `).bind(attemptId, `recordings/list-test/${attemptId}.wav`, nowMs).run();
    participant = participantFrom(await listParticipants(), 73);
    pre = visitFrom(participant, "pre");
    expect(pre).toMatchObject({ missing_recordings: 0, pending_recordings: 1 });
    expect(participant.next_action).toMatchObject({
      code: "wait_pre_recording_upload",
      category: "waiting",
      reason: "recording_upload_in_progress",
      path: null,
    });

    await env.DB.prepare(`
      UPDATE visits
      SET status = 'awaiting_uploads', behavioral_completed_at_ms = ?,
          expected_trial_count = 1, expected_recording_count = 1
      WHERE visit_uuid = ?
    `).bind(nowMs, preId).run();
    participant = participantFrom(await listParticipants(), 73);
    expect(participant.next_action).toMatchObject({
      code: "retry_pre_uploads",
      category: "attention",
      reason: "recordings_pending",
      path: null,
    });

    await env.DB.prepare(`
      UPDATE recordings SET state = 'uploaded', uploaded_at_ms = ?, updated_at_ms = ?
      WHERE attempt_uuid = ?
    `).bind(nowMs, nowMs, attemptId).run();
    participant = participantFrom(await listParticipants(), 73);
    pre = visitFrom(participant, "pre");
    expect(pre).toMatchObject({
      accepted_recording_trials: 1,
      pending_recordings: 0,
      uploaded_recordings: 1,
      missing_recordings: 0,
      abandoned_recordings: 0,
    });
    expect(participant.next_action).toMatchObject({
      code: "finalize_pre",
      category: "attention",
      reason: "finalization_pending",
      path: null,
    });

    await env.DB.prepare(`
      UPDATE recordings SET abandoned_at_ms = ?, abandon_reason = 'participant_terminated'
      WHERE attempt_uuid = ?
    `).bind(nowMs, attemptId).run();
    participant = participantFrom(await listParticipants(), 73);
    pre = visitFrom(participant, "pre");
    expect(pre).toMatchObject({
      pending_recordings: 0,
      uploaded_recordings: 0,
      missing_recordings: 0,
      abandoned_recordings: 1,
    });
    expect(participant.next_action).toMatchObject({
      code: "review_state",
      category: "attention",
      reason: "canonical_recording_abandoned",
      path: null,
    });
  });

  it("prioritizes an open interruption and distinguishes requested recovery from a paused visit", async () => {
    const created = await createParticipant(74);
    const redeemed = created.start;
    const requestId = crypto.randomUUID();
    const requested = await api("/api/participation/interruptions", {
      method: "POST",
      token: redeemed.session_token,
      body: { request_id: requestId, mode: "pause" },
    });
    expect(requested.response.status).toBe(202);

    let participant = participantFrom(await listParticipants(), 74);
    expect(participant.open_interruption).toMatchObject({
      visit_type: "pre",
      mode: "pause",
      state: "requested",
    });
    expect(participant.open_interruption).not.toHaveProperty("interruption_id");
    expect(participant.next_action).toMatchObject({
      code: "finish_interruption",
      category: "attention",
      visit_type: "pre",
      path: null,
      reason: "interruption_requested",
    });

    const finalized = await api(
      `/api/participation/interruptions/${requested.json.interruption.interruption_id}/finalize`,
      {
        method: "POST",
        token: redeemed.session_token,
        body: { request_id: requestId },
      },
    );
    expect(finalized.response.status).toBe(200);
    expect(finalized.json.interruption.state).toBe("paused");

    participant = participantFrom(await listParticipants(), 74);
    expect(participant.open_interruption).toMatchObject({
      visit_type: "pre",
      mode: "pause",
      state: "paused",
    });
    expect(participant.next_action).toMatchObject({
      code: "resume_paused_visit",
      category: "attention",
      visit_type: "pre",
      path: null,
      reason: "paused",
    });
  });

  it("flags impossible prerequisite states instead of offering an invalid participant link", async () => {
    const created = await createParticipant(75);
    const nowMs = Date.now();
    await markVisitComplete(created.participant.pre_visit_id, nowMs);
    await markVisitComplete(created.participant.immediate_visit_id, nowMs);

    let participant = participantFrom(await listParticipants(), 75);
    expect(participant.next_action).toMatchObject({
      code: "review_state",
      category: "attention",
      reason: "delayed_not_scheduled",
      path: null,
    });
  });

  it("blocks downstream actions for an incomplete completed visit or participant mismatch", async () => {
    const created = await createParticipant(76);
    const nowMs = Date.now();
    await env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(nowMs, nowMs, created.participant.pre_visit_id).run();

    let participant = participantFrom(await listParticipants(), 76);
    expect(participant.next_action).toEqual({
      code: "review_state",
      category: "attention",
      visit_type: null,
      path: null,
      reason: "pre_completed_trial_count_mismatch",
      available_at_ms: null,
    });

    await markVisitComplete(created.participant.pre_visit_id, nowMs);
    await markVisitComplete(created.participant.immediate_visit_id, nowMs);
    await markVisitComplete(created.participant.delayed_visit_id, nowMs);
    participant = participantFrom(await listParticipants(), 76);
    expect(participant.next_action).toMatchObject({
      code: "review_state",
      category: "attention",
      reason: "delayed_completed_participant_not_completed",
      path: null,
    });
  });
});
