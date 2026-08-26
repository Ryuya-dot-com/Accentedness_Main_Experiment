import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function jsonRequest(path, { method = "GET", token = null, body = null } = {}) {
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

describe("completed-session expiry", () => {
  it("does not let a closed session token read participant state forever", async () => {
    const created = await jsonRequest("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 810_001 },
    });
    const invitationToken = new URLSearchParams(
      new URL(created.json.invitation.invitation_url).hash.slice(1),
    ).get("t");
    const redeemed = await jsonRequest("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: invitationToken,
        participant_id: 810_001,
        name_action: "register",
        participant_name_confirmed: true,
        participant_name: "Test Participant",
        client_instance_id: "81000001-0000-4000-8000-000000000001",
        expected_visit_type: "pre",
      },
    });
    expect(redeemed.response.status).toBe(200);

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'completed', finalized_at_ms = 1
        WHERE visit_uuid = ?
      `).bind(created.json.participant.pre_visit_id),
      env.DB.prepare(`
        UPDATE sessions SET status = 'closed', closed_at_ms = 1, expires_at_ms = 1
        WHERE session_uuid = ?
      `).bind(redeemed.json.session.session_id),
    ]);

    const expired = await jsonRequest("/api/session", {
      token: redeemed.json.session_token,
    });
    expect(expired.response.status).toBe(401);
    expect(expired.json.error.code).toBe("session_expired");
  });
});
