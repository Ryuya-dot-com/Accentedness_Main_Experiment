import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const DAY_MS = 86_400_000;

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

async function startVisit(participantId, expectedVisitType, clientInstanceId = crypto.randomUUID()) {
  return api("/api/participant-access/start", {
    method: "POST",
    body: {
      participant_id: participantId,
      participant_id_confirmed: true,
      expected_visit_type: expectedVisitType,
      client_instance_id: clientInstanceId,
    },
  });
}

async function createParticipant(participantId) {
  const result = await startVisit(participantId, "pre");
  expect(result.response.status).toBe(200);
  const visits = await env.DB.prepare(`
    SELECT p.participant_uuid, v.visit_uuid, v.visit_type
    FROM participants p JOIN visits v ON v.participant_uuid = p.participant_uuid
    WHERE p.numeric_id = ?
  `).bind(participantId).all();
  const participant = {
    participant_id: participantId,
    participant_uuid: visits.results[0].participant_uuid,
  };
  for (const visit of visits.results) participant[`${visit.visit_type}_visit_id`] = visit.visit_uuid;
  return { participant, start: result.json };
}

describe("no upper participation deadlines", () => {
  it("starts the immediate visit long after pre completion", async () => {
    const created = await createParticipant(820_001);
    const agedCompletionAt = Date.now() - 365 * DAY_MS;
    await env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      agedCompletionAt,
      agedCompletionAt + 60_000,
      created.participant.pre_visit_id,
    ).run();

    const started = await startVisit(820_001, "immediate");
    expect(started.response.status).toBe(200);
    expect(started.json.visit.visit_type).toBe("immediate");
  });

  it("starts a delayed visit long after the five-day minimum", async () => {
    const created = await createParticipant(820_003);
    const immediateCompletionAt = Date.now() - 400 * DAY_MS;
    const delayedTargetAt = immediateCompletionAt + 5 * DAY_MS;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits
        SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(
        immediateCompletionAt,
        immediateCompletionAt + 60_000,
        created.participant.immediate_visit_id,
      ),
      env.DB.prepare(`
        UPDATE visits SET status = 'scheduled', target_at_ms = ?, available_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(delayedTargetAt, delayedTargetAt, created.participant.delayed_visit_id),
    ]);

    const started = await startVisit(820_003, "delayed");
    expect(started.response.status).toBe(200);
    expect(started.json.visit.target_at_ms).toBe(delayedTargetAt);
  });

  it("lists a delayed visit as due only after the immediate data are finalized", async () => {
    const created = await createParticipant(820_005);
    const delayedTargetAt = Date.now() - DAY_MS;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits
        SET status = 'awaiting_uploads', behavioral_completed_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(
        delayedTargetAt - 5 * DAY_MS,
        created.participant.immediate_visit_id,
      ),
      env.DB.prepare(`
        UPDATE visits SET status = 'scheduled', target_at_ms = ?, available_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(delayedTargetAt, delayedTargetAt, created.participant.delayed_visit_id),
    ]);

    const beforeFinalization = await api("/api/admin/delayed/due", { token: ADMIN_TOKEN });
    expect(beforeFinalization.response.status).toBe(200);
    expect(beforeFinalization.json.visits.some(
      (visit) => Number(visit.numeric_id) === created.participant.participant_id,
    )).toBe(false);

    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = ? WHERE visit_uuid = ?
    `).bind(Date.now(), created.participant.immediate_visit_id).run();
    const afterFinalization = await api("/api/admin/delayed/due", { token: ADMIN_TOKEN });
    const dueVisit = afterFinalization.json.visits.find(
      (visit) => Number(visit.numeric_id) === created.participant.participant_id,
    );
    expect(dueVisit).toMatchObject({
      numeric_id: created.participant.participant_id,
      target_at_ms: delayedTargetAt,
      status: "scheduled",
    });
    expect(dueVisit).not.toHaveProperty("immediate_missing_recordings");
  });

  it("opens Delayed at exactly 120 hours only after Immediate is finalized, without rerandomizing", async () => {
    const { participant } = await createParticipant(820_006);
    const immediateCompletionAt = Date.now();
    const availableAt = immediateCompletionAt + 120 * 60 * 60 * 1000;
    const manifestQuery = env.DB.prepare(`
      SELECT visit_type, manifest_hash FROM visits
      WHERE participant_uuid = ? ORDER BY visit_type
    `).bind(participant.participant_uuid);
    const manifestBefore = await manifestQuery.all();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'awaiting_uploads', behavioral_completed_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(immediateCompletionAt, participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE visits SET target_at_ms = ?, available_at_ms = ? WHERE visit_uuid = ?
      `).bind(availableAt, availableAt, participant.delayed_visit_id),
    ]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(availableAt + 1);
    try {
      const pendingUploads = await startVisit(820_006, "delayed");
      expect(pendingUploads.response.status).toBe(409);
      expect(pendingUploads.json.error.code).toBe("immediate_not_completed");

      await env.DB.prepare(`
        UPDATE visits SET status = 'completed', finalized_at_ms = ? WHERE visit_uuid = ?
      `).bind(immediateCompletionAt + 60_000, participant.immediate_visit_id).run();
      clock.mockReturnValue(availableAt - 1);
      const tooEarly = await startVisit(820_006, "delayed");
      expect(tooEarly.response.status).toBe(403);
      expect(tooEarly.json.error).toMatchObject({
        code: "visit_not_available",
        details: { available_at_ms: availableAt, server_now_ms: availableAt - 1 },
      });
      expect(await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM sessions WHERE visit_uuid = ?
      `).bind(participant.delayed_visit_id).first()).toEqual({ count: 0 });

      clock.mockReturnValue(availableAt);
      const onTime = await startVisit(820_006, "delayed");
      expect(onTime.response.status).toBe(200);
      expect(onTime.json.visit).toMatchObject({ visit_type: "delayed", target_at_ms: availableAt });
      expect((await manifestQuery.all()).results).toEqual(manifestBefore.results);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects an expired session but resumes the same unfinished trial by ID", async () => {
    const created = await createParticipant(820_004);
    const firstRedemption = { response: { status: 200 }, json: created.start };
    const unfinishedTrialId = firstRedemption.json.next_trial_id;

    const started = await api(`/api/trials/${unfinishedTrialId}/start`, {
      method: "POST",
      token: firstRedemption.json.session_token,
      body: {
        start_key: "82000004-0000-4000-8000-000000000002",
        client_started_perf_ms: 1,
      },
    });
    expect(started.response.status).toBe(201);

    await env.DB.prepare(`
      UPDATE sessions SET expires_at_ms = 1 WHERE session_uuid = ?
    `).bind(firstRedemption.json.session.session_id).run();

    const expired = await api("/api/session", { token: firstRedemption.json.session_token });
    expect(expired.response.status).toBe(401);
    expect(expired.json.error.code).toBe("session_expired");

    const resumed = await startVisit(
      820_004,
      "pre",
      "82000004-0000-4000-8000-000000000003",
    );
    expect(resumed.response.status).toBe(200);
    expect(resumed.json.next_trial_id).toBe(unfinishedTrialId);
    expect(Number(resumed.json.session.epoch)).toBe(Number(firstRedemption.json.session.epoch) + 1);

    const restarted = await api(`/api/trials/${unfinishedTrialId}/start`, {
      method: "POST",
      token: resumed.json.session_token,
      body: {
        start_key: "82000004-0000-4000-8000-000000000004",
        client_started_perf_ms: 2,
        resume_after_stimulus: true,
      },
    });
    expect(restarted.response.status).toBe(201);
    expect(restarted.json.repeated_after_interruption).toBe(true);
  });
});
