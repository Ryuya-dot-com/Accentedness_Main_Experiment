import { exports } from "cloudflare:workers";
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

function invitationToken(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("t");
}

async function createAndRedeemPre(participantId) {
  const createdResult = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { participant_id: participantId },
  });
  expect(createdResult.response.status).toBe(201);
  const created = createdResult.json;
  const redeemedResult = await api("/api/invitations/redeem", {
    method: "POST",
    body: {
      token: invitationToken(created.invitation.invitation_url),
      participant_id: participantId,
      participant_name: "Test Participant",
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: "pre",
    },
  });
  expect(redeemedResult.response.status).toBe(200);
  return { created, redeemed: redeemedResult.json };
}

describe("session invalidation", () => {
  it("supersedes active sessions when an invitation is reissued or revoked", async () => {
    const { created, redeemed } = await createAndRedeemPre(101);
    const reissued = await api(
      `/api/admin/visits/${created.participant.pre_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    expect(reissued.response.status).toBe(201);

    const staleAfterReissue = await api("/api/session/heartbeat", {
      method: "POST",
      token: redeemed.session_token,
      body: {},
    });
    expect(staleAfterReissue.response.status).toBe(409);
    expect(staleAfterReissue.json.error.code).toBe("session_superseded");

    const resumed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: invitationToken(reissued.json.invitation.invitation_url),
        participant_id: 101,
        participant_name: "Test Participant",
        client_instance_id: crypto.randomUUID(),
        expected_visit_type: "pre",
      },
    });
    expect(resumed.response.status).toBe(200);
    const revoked = await api(`/api/admin/invitations/${reissued.json.invitation.invite_id}/revoke`, {
      method: "POST",
      token: ADMIN_TOKEN,
    });
    expect(revoked.response.status).toBe(200);

    const staleAfterRevoke = await api("/api/session/heartbeat", {
      method: "POST",
      token: resumed.json.session_token,
      body: {},
    });
    expect(staleAfterRevoke.response.status).toBe(409);
    expect(staleAfterRevoke.json.error.code).toBe("session_superseded");
  });
});
