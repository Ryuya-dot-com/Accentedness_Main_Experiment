import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function request(path, { method = "GET", token = null, body = null } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  }));
  return { response, json: await response.json() };
}

function startVisit(participantId, visitType = "pre") {
  return request("/api/participant-access/start", {
    method: "POST",
    body: {
      participant_id: participantId,
      participant_id_confirmed: true,
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: visitType,
    },
  });
}

async function participantRow(participantId) {
  return env.DB.prepare(`
    SELECT p.participant_uuid, p.training_accent, p.counterbalance_cell,
      MAX(CASE WHEN v.visit_type = 'pre' THEN v.visit_uuid END) AS pre_visit_id,
      MAX(CASE WHEN v.visit_type = 'immediate' THEN v.visit_uuid END) AS immediate_visit_id,
      MAX(CASE WHEN v.visit_type = 'delayed' THEN v.visit_uuid END) AS delayed_visit_id
    FROM participants p JOIN visits v ON v.participant_uuid = p.participant_uuid
    WHERE p.numeric_id = ? GROUP BY p.participant_uuid
  `).bind(participantId).first();
}

async function startFirstTrial(started) {
  const trial = started.json.manifest.find((candidate) => candidate.current);
  const result = await request(`/api/trials/${trial.trial_id}/start`, {
    method: "POST",
    token: started.json.session_token,
    body: { start_key: crypto.randomUUID(), client_started_perf_ms: 1 },
  });
  expect(result.response.status).toBe(201);
}

describe("admin allocation monitoring", () => {
  it("reports ID gaps and assignment/completion counts", async () => {
    for (const participantId of [2, 3, 5]) {
      expect((await startVisit(participantId)).response.status).toBe(200);
    }
    const summary = await request("/api/admin/summary", { token: ADMIN_TOKEN });
    expect(summary.response.status).toBe(200);
    expect(summary.json.participant_id_span).toMatchObject({
      assigned_count: 3,
      minimum_id: 2,
      maximum_id: 5,
      missing_ids_within_span: 1,
      missing_ids_through_maximum: 2,
    });
    const totalsByAccent = Object.fromEntries(
      ["english", "chinese", "japanese"].map((accent) => [
        accent,
        summary.json.assignment_flow
          .filter((row) => row.training_accent === accent)
          .reduce((total, row) => total + Number(row.assigned_count), 0),
      ]),
    );
    expect(totalsByAccent).toEqual({ english: 0, chinese: 2, japanese: 1 });
  });

  it("separates ID start, first trial, behavioral completion, and finalization", async () => {
    const cohortIds = [41, 113, 185, 257, 329];
    const starts = new Map();
    for (const participantId of cohortIds) {
      const started = await startVisit(participantId);
      expect(started.response.status).toBe(200);
      starts.set(participantId, started);
    }
    await startFirstTrial(starts.get(41));
    await startFirstTrial(starts.get(329));
    const participant = await participantRow(41);
    const preFinishedAt = Date.now();
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', behavioral_completed_at_ms = ?,
        finalized_at_ms = ?, updated_at_ms = ? WHERE visit_uuid = ?
    `).bind(preFinishedAt, preFinishedAt + 1, preFinishedAt + 1, participant.pre_visit_id).run();

    const immediate = await startVisit(41, "immediate");
    expect(immediate.response.status).toBe(200);
    await startFirstTrial(immediate);
    const immediateFinishedAt = preFinishedAt + 2;
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', behavioral_completed_at_ms = ?,
        finalized_at_ms = ?, updated_at_ms = ? WHERE visit_uuid = ?
    `).bind(
      immediateFinishedAt,
      immediateFinishedAt + 1,
      immediateFinishedAt + 1,
      participant.immediate_visit_id,
    ).run();
    await env.DB.prepare(`
      UPDATE visits SET status = 'scheduled', target_at_ms = 1, available_at_ms = 1
      WHERE visit_uuid = ?
    `).bind(participant.delayed_visit_id).run();
    const delayed = await startVisit(41, "delayed");
    expect(delayed.response.status).toBe(200);
    await startFirstTrial(delayed);
    await env.DB.prepare(`
      UPDATE visits SET status = 'awaiting_uploads', behavioral_completed_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(immediateFinishedAt + 2, participant.delayed_visit_id).run();

    const summary = await request("/api/admin/summary", { token: ADMIN_TOKEN });
    const flow = summary.json.assignment_flow.find(
      (row) => row.training_accent === participant.training_accent
        && Number(row.counterbalance_cell) === Number(participant.counterbalance_cell),
    );
    expect(flow).toMatchObject({
      assigned_count: 5,
      pre_issued_count: 5,
      pre_redeemed_count: 5,
      pre_first_trial_count: 2,
      pre_behavioral_completed_count: 1,
      pre_finalized_count: 1,
      immediate_issued_count: 1,
      immediate_redeemed_count: 1,
      immediate_first_trial_count: 1,
      immediate_behavioral_completed_count: 1,
      immediate_finalized_count: 1,
      delayed_issued_count: 1,
      delayed_redeemed_count: 1,
      delayed_first_trial_count: 1,
      delayed_behavioral_completed_count: 1,
      delayed_finalized_count: 0,
    });
  });
});
