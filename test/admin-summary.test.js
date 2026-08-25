import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function adminRequest(path, { method = "GET", body = null } = {}) {
  const headers = new Headers({ Authorization: `Bearer ${ADMIN_TOKEN}` });
  if (body !== null) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  }));
  return { response, json: await response.json() };
}

async function participantRequest(path, { method = "GET", token = null, body = null } = {}) {
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

function invitationToken(invitationUrl) {
  return new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get("t");
}

async function redeemInvitation(invitationUrl, expectedVisitType, participantId) {
  const redeemed = await participantRequest("/api/invitations/redeem", {
    method: "POST",
    body: {
      token: invitationToken(invitationUrl),
      participant_id: participantId,
      participant_name: "Test Participant",
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: expectedVisitType,
    },
  });
  expect(redeemed.response.status).toBe(200);
  return redeemed;
}

async function redeemAndStartFirstTrial(invitationUrl, expectedVisitType, participantId) {
  const redeemed = await redeemInvitation(invitationUrl, expectedVisitType, participantId);
  const firstTrial = redeemed.json.manifest.find((trial) => trial.current);
  const started = await participantRequest(`/api/trials/${firstTrial.trial_id}/start`, {
    method: "POST",
    token: redeemed.json.session_token,
    body: { start_key: crypto.randomUUID(), client_started_perf_ms: 1 },
  });
  expect(started.response.status).toBe(201);
}

describe("admin allocation monitoring", () => {
  it("reports ID gaps and assignment/completion counts by accent and counterbalance cell", async () => {
    for (const participantId of [2, 3, 5]) {
      const created = await adminRequest("/api/admin/participants", {
        method: "POST",
        body: {
          participant_id: participantId,
          participant_name: "Test Participant",
          issue_pre_invitation: false,
        },
      });
      expect(created.response.status).toBe(201);
    }

    const summary = await adminRequest("/api/admin/summary");
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
    expect(summary.json.assignment_flow.every(
      (row) => Number(row.pre_behavioral_completed_count) === 0,
    )).toBe(true);
  });

  it("separates invitation, redemption, first trial, behavioral completion, and finalization", async () => {
    const created = await adminRequest("/api/admin/participants", {
      method: "POST",
      body: { participant_id: 41, participant_name: "Test Participant" },
    });
    expect(created.response.status).toBe(201);

    // IDs separated by 72 share training accent and counterbalance cell. Build
    // a staggered cohort so adjacent funnel stages cannot accidentally collapse.
    const assignedOnly = await adminRequest("/api/admin/participants", {
      method: "POST",
      body: { participant_id: 113, participant_name: "Test Participant", issue_pre_invitation: false },
    });
    const issuedOnly = await adminRequest("/api/admin/participants", {
      method: "POST",
      body: { participant_id: 185, participant_name: "Test Participant" },
    });
    const redeemedOnly = await adminRequest("/api/admin/participants", {
      method: "POST",
      body: { participant_id: 257, participant_name: "Test Participant" },
    });
    const firstTrialOnly = await adminRequest("/api/admin/participants", {
      method: "POST",
      body: { participant_id: 329, participant_name: "Test Participant" },
    });
    for (const cohort of [assignedOnly, issuedOnly, redeemedOnly, firstTrialOnly]) {
      expect(cohort.response.status).toBe(201);
      expect(cohort.json.participant.training_accent).toBe(created.json.participant.training_accent);
      expect(cohort.json.participant.counterbalance_cell)
        .toBe(created.json.participant.counterbalance_cell);
    }
    expect(assignedOnly.json.invitation).toBeNull();
    await redeemInvitation(redeemedOnly.json.invitation.invitation_url, "pre", 257);
    await redeemAndStartFirstTrial(firstTrialOnly.json.invitation.invitation_url, "pre", 329);

    await redeemAndStartFirstTrial(created.json.invitation.invitation_url, "pre", 41);
    const preFinishedAt = Date.now();
    await env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      preFinishedAt,
      preFinishedAt + 1,
      preFinishedAt + 1,
      created.json.participant.pre_visit_id,
    ).run();

    const immediateInvitation = await adminRequest(
      `/api/admin/visits/${created.json.participant.immediate_visit_id}/invitations`,
      { method: "POST", body: {} },
    );
    expect(immediateInvitation.response.status).toBe(201);
    await redeemAndStartFirstTrial(immediateInvitation.json.invitation.invitation_url, "immediate", 41);
    const immediateFinishedAt = preFinishedAt + 2;
    await env.DB.prepare(`
      UPDATE visits
      SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      immediateFinishedAt,
      immediateFinishedAt + 1,
      immediateFinishedAt + 1,
      created.json.participant.immediate_visit_id,
    ).run();
    const delayedAvailableAt = Date.now() - 1;
    await env.DB.prepare(`
      UPDATE visits SET status = 'scheduled', target_at_ms = ?, available_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      delayedAvailableAt,
      delayedAvailableAt,
      Date.now(),
      created.json.participant.delayed_visit_id,
    ).run();

    const delayedInvitation = await adminRequest(
      `/api/admin/visits/${created.json.participant.delayed_visit_id}/invitations`,
      { method: "POST", body: {} },
    );
    expect(delayedInvitation.response.status).toBe(201);
    await redeemAndStartFirstTrial(delayedInvitation.json.invitation.invitation_url, "delayed", 41);
    await env.DB.prepare(`
      UPDATE visits SET status = 'awaiting_uploads', behavioral_completed_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      immediateFinishedAt + 2,
      immediateFinishedAt + 2,
      created.json.participant.delayed_visit_id,
    ).run();

    const summary = await adminRequest("/api/admin/summary");
    expect(summary.response.status).toBe(200);
    const flow = summary.json.assignment_flow.find(
      (row) => row.training_accent === created.json.participant.training_accent
        && Number(row.counterbalance_cell) === Number(created.json.participant.counterbalance_cell),
    );
    expect(flow).toMatchObject({
      assigned_count: 5,
      ever_paused_count: 0,
      currently_paused_count: 0,
      terminated_count: 0,
      pre_issued_count: 4,
      pre_redeemed_count: 3,
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
