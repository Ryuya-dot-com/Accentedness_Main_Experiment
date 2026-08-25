import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const REGISTERED_NAME = "\u3000\uff31\uff55\uff41\uff53\uff41\uff52\u3000\uff29\uff44\uff45\uff4e\uff54\uff49\uff54\uff59\u3000\uff2d\uff41\uff52\uff4b\uff45\uff52\u3000";
const EQUIVALENT_NAME = "QUASAR   IDENTITY MARKER";
const WRONG_NAME = "Quasar Identity Intruder";
const PLAINTEXT_MARKER = "quasar";

async function api(
  path,
  {
    method = "GET",
    token = null,
    body = null,
    runtimeEnv = null,
  } = {},
) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  });
  const response = runtimeEnv
    ? await worker.fetch(request, runtimeEnv)
    : await exports.default.fetch(request);
  const json = (response.headers.get("Content-Type") ?? "").includes("application/json")
    ? await response.json()
    : null;
  return { response, json };
}

function invitationToken(invitationUrl) {
  return new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get("t");
}

function normalizedSearchText(value) {
  return JSON.stringify(value).normalize("NFKC").toLocaleLowerCase("en-US");
}

function expectPlaintextNameAbsent(value) {
  expect(normalizedSearchText(value)).not.toContain(PLAINTEXT_MARKER);
}

function nestedKeys(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry) => nestedKeys(entry, output));
    return output;
  }
  Object.entries(value).forEach(([key, entry]) => {
    output.push(key);
    nestedKeys(entry, output);
  });
  return output;
}

function expectNoIdentityInternalsInApi(value) {
  const forbidden = new Set([
    "participant_name",
    "name",
    "verifier_hex",
    "identity_verifier_hex",
    "normalization_version",
    "verifier_version",
  ]);
  expect(nestedKeys(value).filter((key) => forbidden.has(key))).toEqual([]);
  expectPlaintextNameAbsent(value);
}

async function all(sql, ...bindings) {
  return (await env.DB.prepare(sql).bind(...bindings).all()).results;
}

async function first(sql, ...bindings) {
  return env.DB.prepare(sql).bind(...bindings).first();
}

async function participantAuditRows(participantUuid) {
  return all(`
    SELECT * FROM audit_log
    WHERE participant_uuid = ?
    ORDER BY server_at_ms, audit_uuid
  `, participantUuid);
}

async function redemptionSnapshot(participantUuid, visitUuid, inviteUuid) {
  return {
    visit: await first("SELECT * FROM visits WHERE visit_uuid = ?", visitUuid),
    invitation: await first("SELECT * FROM invitations WHERE invite_uuid = ?", inviteUuid),
    identity: await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      participantUuid,
    ),
    sessions: await all(
      "SELECT * FROM sessions WHERE visit_uuid = ? ORDER BY epoch, session_uuid",
      visitUuid,
    ),
    audits: await participantAuditRows(participantUuid),
  };
}

async function createBoundParticipant(participantId) {
  const created = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: {
      participant_id: participantId,
      participant_name: REGISTERED_NAME,
      issue_pre_invitation: false,
    },
  });
  expect(created.response.status).toBe(201);
  return created.json;
}

describe("participant identity API and persistence contract", () => {
  it("requires both a participant name and a configured identity secret before admin creation", async () => {
    const missingName = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 991_001, issue_pre_invitation: false },
    });
    expect(missingName.response.status).toBe(400);
    expect(missingName.json.error.code).toBe("invalid_participant_name");

    const envWithoutIdentitySecret = new Proxy(env, {
      get(target, property) {
        if (property === "IDENTITY_SECRET") return undefined;
        return target[property];
      },
    });
    const missingSecret = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        participant_id: 991_002,
        participant_name: "Secret Required",
        issue_pre_invitation: false,
      },
      runtimeEnv: envWithoutIdentitySecret,
    });
    expect(missingSecret.response.status).toBe(503);
    expect(missingSecret.json.error.code).toBe("identity_verification_unconfigured");

    expect(await first("SELECT COUNT(*) AS count FROM participants")).toEqual({ count: 0 });
    expect(await first("SELECT COUNT(*) AS count FROM participant_identity_bindings"))
      .toEqual({ count: 0 });
    expect(await first("SELECT COUNT(*) AS count FROM audit_log")).toEqual({ count: 0 });
  });

  it("stores only a versioned HMAC and treats a normalized-equivalent re-registration as idempotent", async () => {
    const participantId = 991_101;
    const created = await createBoundParticipant(participantId);
    const participant = created.participant;

    expect(participant.identity_registered).toBe(true);
    expect(Object.keys(participant).filter((key) => key.startsWith("identity_")))
      .toEqual(["identity_registered"]);
    expectNoIdentityInternalsInApi(created);

    const identityBefore = await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      participant.participant_uuid,
    );
    expect(identityBefore).toMatchObject({
      participant_uuid: participant.participant_uuid,
      normalization_version: "nfkc-whitespace-lower-v1",
      verifier_version: "hmac-sha256-v1",
      last_confirmed_at_ms: null,
      confirmation_count: 0,
    });
    expect(identityBefore.verifier_hex).toMatch(/^[0-9a-f]{64}$/u);
    expectPlaintextNameAbsent(identityBefore);

    const auditsBefore = await participantAuditRows(participant.participant_uuid);
    expect(auditsBefore.map((row) => row.action)).toEqual(["participant_created"]);
    expectPlaintextNameAbsent(auditsBefore);

    const equivalent = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        participant_id: participantId,
        participant_name: EQUIVALENT_NAME,
        issue_pre_invitation: false,
      },
    });
    expect(equivalent.response.status).toBe(200);
    expect(equivalent.json.created).toBe(false);
    expect(equivalent.json.participant.identity_registered).toBe(true);
    expectNoIdentityInternalsInApi(equivalent.json);
    expect(await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      participant.participant_uuid,
    )).toEqual(identityBefore);
    expect(await participantAuditRows(participant.participant_uuid)).toEqual(auditsBefore);

    const mismatch = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        participant_id: participantId,
        participant_name: WRONG_NAME,
        issue_pre_invitation: false,
      },
    });
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.json.error).toEqual({
      code: "participant_binding_mismatch",
      message: "Participant ID and name do not match the registered recipient",
      details: null,
    });
    expectNoIdentityInternalsInApi(mismatch.json);
    expect(await first(
      "SELECT * FROM participant_identity_bindings WHERE participant_uuid = ?",
      participant.participant_uuid,
    )).toEqual(identityBefore);
    expect(await participantAuditRows(participant.participant_uuid)).toEqual(auditsBefore);

    const identityColumns = await all("PRAGMA table_info(participant_identity_bindings)");
    expect(identityColumns.map((column) => column.name)).not.toContain("participant_name");
  });

  it("rejects every incomplete or wrong redemption generically and atomically, then redeems correct fields without leaking the name", async () => {
    const participantId = 991_201;
    const created = await createBoundParticipant(participantId);
    const { participant } = created;
    const issued = await api(
      `/api/admin/visits/${participant.pre_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    expect(issued.response.status).toBe(201);
    expectNoIdentityInternalsInApi(issued.json);
    const token = invitationToken(issued.json.invitation.invitation_url);
    const inviteUuid = issued.json.invitation.invite_id;
    const beforeFailures = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      inviteUuid,
    );

    const base = {
      token,
      participant_id: participantId,
      participant_name: EQUIVALENT_NAME,
      expected_visit_type: "pre",
    };
    const invalidBodies = [
      { ...base, participant_id: undefined },
      { ...base, participant_id: participantId + 1 },
      { ...base, participant_name: undefined },
      { ...base, participant_name: WRONG_NAME },
    ];
    const genericErrors = [];
    for (const invalidBody of invalidBodies) {
      const failed = await api("/api/invitations/redeem", {
        method: "POST",
        body: { ...invalidBody, client_instance_id: crypto.randomUUID() },
      });
      expect(failed.response.status).toBe(409);
      genericErrors.push(failed.json.error);
      expectNoIdentityInternalsInApi(failed.json);
      expect(await redemptionSnapshot(
        participant.participant_uuid,
        participant.pre_visit_id,
        inviteUuid,
      )).toEqual(beforeFailures);
    }
    expect(genericErrors).toEqual(Array.from({ length: invalidBodies.length }, () => ({
      code: "participant_binding_mismatch",
      message: "Participant ID and name do not match the registered recipient",
      details: null,
    })));

    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: { ...base, client_instance_id: crypto.randomUUID() },
    });
    expect(redeemed.response.status).toBe(200);
    expectNoIdentityInternalsInApi(redeemed.json);

    const afterRedeem = await redemptionSnapshot(
      participant.participant_uuid,
      participant.pre_visit_id,
      inviteUuid,
    );
    expect(afterRedeem.visit.status).toBe("started");
    expect(afterRedeem.visit.active_session_epoch)
      .toBe(beforeFailures.visit.active_session_epoch + 1);
    expect(afterRedeem.sessions).toHaveLength(1);
    expect(afterRedeem.invitation.redeem_count).toBe(1);
    expect(afterRedeem.invitation.first_redeemed_at_ms).not.toBeNull();
    expect(afterRedeem.invitation.last_redeemed_at_ms).not.toBeNull();
    expect(afterRedeem.identity.confirmation_count).toBe(1);
    expect(afterRedeem.identity.last_confirmed_at_ms).not.toBeNull();
    expect(afterRedeem.audits).toHaveLength(beforeFailures.audits.length + 1);
    expect(afterRedeem.audits.at(-1).action).toBe("invitation_redeemed");

    const sessionState = await api("/api/session", { token: redeemed.json.session_token });
    expect(sessionState.response.status).toBe(200);
    expectNoIdentityInternalsInApi(sessionState.json);

    const event = await api("/api/events", {
      method: "POST",
      token: redeemed.json.session_token,
      body: {
        events: [{
          event_id: crypto.randomUUID(),
          type: "visibility_changed",
          client_event_at_ms: 100,
          payload: { hidden: false },
        }],
      },
    });
    expect(event.response.status).toBe(200);
    expectNoIdentityInternalsInApi(event.json);

    const sessionRows = await all(
      "SELECT * FROM sessions WHERE visit_uuid = ? ORDER BY epoch",
      participant.pre_visit_id,
    );
    const eventRows = await all(
      "SELECT * FROM events WHERE visit_uuid = ? ORDER BY server_received_at_ms, event_uuid",
      participant.pre_visit_id,
    );
    const auditRows = await participantAuditRows(participant.participant_uuid);
    expect(eventRows).toHaveLength(1);
    expectPlaintextNameAbsent(sessionRows);
    expectPlaintextNameAbsent(eventRows);
    expectPlaintextNameAbsent(auditRows);

    const successLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let capturedLogs;
    try {
      const loggedState = await api("/api/session", {
        token: redeemed.json.session_token,
        runtimeEnv: env,
      });
      expect(loggedState.response.status).toBe(200);
      const loggedMismatch = await api("/api/invitations/redeem", {
        method: "POST",
        body: {
          ...base,
          participant_name: WRONG_NAME,
          client_instance_id: crypto.randomUUID(),
        },
        runtimeEnv: env,
      });
      expect(loggedMismatch.response.status).toBe(409);
      expect(successLog).toHaveBeenCalled();
      expect(failureLog).toHaveBeenCalled();
      capturedLogs = [successLog.mock.calls, failureLog.mock.calls];
    } finally {
      successLog.mockRestore();
      failureLog.mockRestore();
    }
    expectPlaintextNameAbsent(capturedLogs);
  });

  it("blocks invitation issuance for a legacy participant whose identity binding is absent", async () => {
    const participantId = 991_301;
    const created = await createBoundParticipant(participantId);
    const { participant } = created;
    await env.DB.prepare(
      "DELETE FROM participant_identity_bindings WHERE participant_uuid = ?",
    ).bind(participant.participant_uuid).run();

    const before = {
      visit: await first("SELECT * FROM visits WHERE visit_uuid = ?", participant.pre_visit_id),
      invitations: await all("SELECT * FROM invitations WHERE visit_uuid = ?", participant.pre_visit_id),
      audits: await participantAuditRows(participant.participant_uuid),
    };
    const issue = await api(`/api/admin/visits/${participant.pre_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(issue.response.status).toBe(409);
    expect(issue.json.error.code).toBe("participant_identity_not_registered");
    expectNoIdentityInternalsInApi(issue.json);
    expect({
      visit: await first("SELECT * FROM visits WHERE visit_uuid = ?", participant.pre_visit_id),
      invitations: await all("SELECT * FROM invitations WHERE visit_uuid = ?", participant.pre_visit_id),
      audits: await participantAuditRows(participant.participant_uuid),
    }).toEqual(before);
  });
});
