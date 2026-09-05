import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";

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
    const started = await jsonRequest("/api/participant-access/start", {
      method: "POST",
      body: {
        participant_id: 810_001,
        participant_id_confirmed: true,
        client_instance_id: "81000001-0000-4000-8000-000000000001",
        expected_visit_type: "pre",
      },
    });
    expect(started.response.status).toBe(200);

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'completed', finalized_at_ms = 1
        WHERE visit_uuid = ?
      `).bind(started.json.visit.visit_id),
      env.DB.prepare(`
        UPDATE sessions SET status = 'closed', closed_at_ms = 1, expires_at_ms = 1
        WHERE session_uuid = ?
      `).bind(started.json.session.session_id),
    ]);

    const expired = await jsonRequest("/api/session", {
      token: started.json.session_token,
    });
    expect(expired.response.status).toBe(401);
    expect(expired.json.error.code).toBe("session_expired");
  });
});
