import { exports } from "cloudflare:workers";
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

describe("admin allocation monitoring", () => {
  it("reports ID gaps and assignment/completion counts by accent and counterbalance cell", async () => {
    for (const participantId of [2, 3, 5]) {
      const created = await adminRequest("/api/admin/participants", {
        method: "POST",
        body: { participant_id: participantId, issue_pre_invitation: false },
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
    expect(summary.json.assignment_flow.every((row) => Number(row.pre_completed_count) === 0)).toBe(true);
  });
});
