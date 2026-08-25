import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

async function createParticipant(participantId, issuePreInvitation = true) {
  const result = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { participant_id: participantId, issue_pre_invitation: issuePreInvitation },
  });
  expect(result.response.status).toBe(201);
  return result.json;
}

function invitationToken(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("t");
}

async function redeem(url, expectedVisitType, clientInstanceId = crypto.randomUUID()) {
  return api("/api/invitations/redeem", {
    method: "POST",
    body: {
      token: invitationToken(url),
      client_instance_id: clientInstanceId,
      expected_visit_type: expectedVisitType,
    },
  });
}

describe("no upper participation deadlines", () => {
  it("issues an immediate invitation long after pre completion", async () => {
    const created = await createParticipant(820_001, false);
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

    const issued = await api(
      `/api/admin/visits/${created.participant.immediate_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );

    expect(issued.response.status).toBe(201);
    expect(issued.json.invitation.visit_type).toBe("immediate");
  });

  it("redeems an active invitation regardless of how long ago it was issued", async () => {
    const created = await createParticipant(820_002);
    await env.DB.prepare(`
      UPDATE invitations SET issued_at_ms = ? WHERE invite_uuid = ?
    `).bind(Date.now() - 365 * DAY_MS, created.invitation.invite_id).run();

    const redeemed = await redeem(created.invitation.invitation_url, "pre");

    expect(redeemed.response.status).toBe(200);
    expect(redeemed.json.visit.visit_type).toBe("pre");
  });

  it("issues and redeems a delayed invitation long after the seven-day minimum", async () => {
    const created = await createParticipant(820_003, false);
    const immediateCompletionAt = Date.now() - 400 * DAY_MS;
    const delayedTargetAt = immediateCompletionAt + 7 * DAY_MS;
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

    const issued = await api(
      `/api/admin/visits/${created.participant.delayed_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    expect(issued.response.status).toBe(201);

    const redeemed = await redeem(issued.json.invitation.invitation_url, "delayed");
    expect(redeemed.response.status).toBe(200);
    expect(redeemed.json.visit.target_at_ms).toBe(delayedTargetAt);
  });

  it("rejects an expired session but resumes the same unfinished trial from the active invitation", async () => {
    const created = await createParticipant(820_004);
    const firstRedemption = await redeem(
      created.invitation.invitation_url,
      "pre",
      "82000004-0000-4000-8000-000000000001",
    );
    expect(firstRedemption.response.status).toBe(200);
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

    const resumed = await redeem(
      created.invitation.invitation_url,
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
