import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto.js";
import {
  ensureRecordingExportQueued,
  processRecordingExport,
  reconcileRecordingExports,
} from "../src/lib/recording-exports.js";
import { crc32 } from "../src/lib/zip.js";

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
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: "pre",
    },
  });
  expect(redeemedResult.response.status).toBe(200);
  return { created, redeemed: redeemedResult.json };
}

async function seedCompletedPictureNaming(participantId) {
  const context = await createAndRedeemPre(participantId);
  const visitUuid = context.created.participant.pre_visit_id;
  const trialResult = await env.DB.prepare(`
    SELECT trial_uuid, segment_ordinal FROM trial_manifest
    WHERE visit_uuid = ? AND segment = 'picture_naming'
    ORDER BY segment_ordinal
  `).bind(visitUuid).all();
  const statements = [];
  for (const [index, trial] of trialResult.results.entries()) {
    const attemptUuid = crypto.randomUUID();
    const bytes = new Uint8Array([82, 73, 70, 70, index]);
    const sha256 = await sha256Hex(bytes);
    const r2Key = `recordings/security-export-test/${attemptUuid}.wav`;
    const object = await env.RECORDINGS.put(r2Key, bytes, {
      httpMetadata: { contentType: "audio/wav", cacheControl: "private, no-store" },
      customMetadata: { sha256, crc32: String(crc32(bytes)) },
    });
    statements.push(
      env.DB.prepare(`
        INSERT INTO trial_attempts (
          attempt_uuid, trial_uuid, attempt_no, session_uuid, start_key, response_key,
          state, repeated_after_interruption, extra_exposure, server_started_at_ms,
          server_received_at_ms, payload_hash, payload_json
        ) VALUES (?, ?, 1, ?, ?, ?, 'response_saved', 0, 0, ?, ?, ?, '{}')
      `).bind(
        attemptUuid,
        trial.trial_uuid,
        context.redeemed.session.session_id,
        crypto.randomUUID(),
        crypto.randomUUID(),
        Date.now() - 100,
        Date.now(),
        sha256,
      ),
      env.DB.prepare(`
        UPDATE trial_manifest SET canonical_attempt_uuid = ? WHERE trial_uuid = ?
      `).bind(attemptUuid, trial.trial_uuid),
      env.DB.prepare(`
        INSERT INTO recordings (
          attempt_uuid, r2_key, state, sha256, etag, byte_count, mime_type,
          crc32, received_at_ms, uploaded_at_ms, updated_at_ms
        ) VALUES (?, ?, 'uploaded', ?, ?, ?, 'audio/wav', ?, ?, ?, ?)
      `).bind(
        attemptUuid,
        r2Key,
        sha256,
        object.etag,
        bytes.byteLength,
        crc32(bytes),
        Date.now(),
        Date.now(),
        Date.now(),
      ),
    );
  }
  statements.push(env.DB.prepare(`
    UPDATE segments SET status = 'completed', completed_at_ms = ?
    WHERE visit_uuid = ? AND segment = 'picture_naming'
  `).bind(Date.now(), visitUuid));
  await env.DB.batch(statements);
  return { ...context, visitUuid };
}

async function localEntryNames(object) {
  const bytes = new Uint8Array(await object.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const names = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    names.push(decoder.decode(bytes.slice(nameStart, nameStart + nameLength)));
    offset = nameStart + nameLength + extraLength + size;
  }
  return names;
}

describe("session invalidation and recording export recovery", () => {
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

  it("discovers a completed phase with no job and produces opaque idempotent ZIP entries", async () => {
    const { visitUuid } = await seedCompletedPictureNaming(102);
    const before = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM recording_exports WHERE visit_uuid = ?
    `).bind(visitUuid).first();
    expect(Number(before.count)).toBe(0);

    expect(await reconcileRecordingExports(env)).toBeGreaterThanOrEqual(1);
    const exportRow = await env.DB.prepare(`
      SELECT * FROM recording_exports WHERE visit_uuid = ? AND segment = 'picture_naming'
    `).bind(visitUuid).first();
    expect(exportRow.state).toBe("pending");
    await processRecordingExport(env, exportRow.export_uuid);

    const ready = await env.DB.prepare(`
      SELECT * FROM recording_exports WHERE export_uuid = ?
    `).bind(exportRow.export_uuid).first();
    expect(ready.state).toBe("ready");
    const archive = await env.EXPORTS.get(ready.r2_key);
    const names = await localEntryNames(archive);
    expect(names).toHaveLength(27);
    expect(names[0]).toBe("manifest.json");
    expect(names.slice(1)).toEqual(
      Array.from({ length: 26 }, (_, index) => `wav/recording_${String(index + 1).padStart(2, "0")}.wav`),
    );
    expect(names.join("\n")).not.toMatch(/casket|english|chinese|japanese|test_f/iu);

    const firstObject = await env.EXPORTS.head(ready.r2_key);
    const duplicate = await processRecordingExport(env, ready.export_uuid);
    const duplicateObject = await env.EXPORTS.head(ready.r2_key);
    expect(duplicate).toEqual({ skipped: true, state: "ready" });
    expect(duplicateObject.etag).toBe(firstObject.etag);
  });

  it("records post-claim snapshot failures and stops after five attempts", async () => {
    const { visitUuid } = await seedCompletedPictureNaming(103);
    const scheduled = await ensureRecordingExportQueued(env, visitUuid, "picture_naming");
    await env.DB.prepare(`
      DELETE FROM recording_export_members
      WHERE export_uuid = ? AND segment_ordinal = 1
    `).bind(scheduled.export_uuid).run();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(processRecordingExport(env, scheduled.export_uuid))
        .rejects.toThrow("recording_export_snapshot_incomplete");
      const failed = await env.DB.prepare(`
        SELECT state, attempt_count, lease_token, last_error_code
        FROM recording_exports WHERE export_uuid = ?
      `).bind(scheduled.export_uuid).first();
      expect(failed).toMatchObject({
        state: "failed",
        attempt_count: attempt,
        lease_token: null,
        last_error_code: "recording_export_snapshot_incomplete",
      });
    }

    const exhausted = await processRecordingExport(env, scheduled.export_uuid);
    expect(exhausted).toEqual({ skipped: true, state: "failed" });
    await ensureRecordingExportQueued(env, visitUuid, "picture_naming");
    const finalRow = await env.DB.prepare(`
      SELECT state, attempt_count FROM recording_exports WHERE export_uuid = ?
    `).bind(scheduled.export_uuid).first();
    expect(finalRow).toEqual({ state: "failed", attempt_count: 5 });
  });

  it("requeues an export whose building lease expired before completion", async () => {
    const { visitUuid } = await seedCompletedPictureNaming(105);
    const scheduled = await ensureRecordingExportQueued(env, visitUuid, "picture_naming");
    await env.DB.prepare(`
      UPDATE recording_exports
      SET state = 'building', lease_token = ?, lease_expires_at_ms = 1,
          attempt_count = 1, enqueued_at_ms = NULL, updated_at_ms = 1
      WHERE export_uuid = ?
    `).bind(crypto.randomUUID(), scheduled.export_uuid).run();

    expect(await reconcileRecordingExports(env)).toBeGreaterThanOrEqual(1);
    const recovered = await env.DB.prepare(`
      SELECT state, lease_token, lease_expires_at_ms, enqueued_at_ms
      FROM recording_exports WHERE export_uuid = ?
    `).bind(scheduled.export_uuid).first();
    expect(recovered.state).toBe("pending");
    expect(recovered.lease_token).toBeNull();
    expect(recovered.lease_expires_at_ms).toBeNull();
    expect(Number(recovered.enqueued_at_ms)).toBeGreaterThan(1);

    await processRecordingExport(env, scheduled.export_uuid);
    const ready = await env.DB.prepare(`
      SELECT state, attempt_count FROM recording_exports WHERE export_uuid = ?
    `).bind(scheduled.export_uuid).first();
    expect(ready).toEqual({ state: "ready", attempt_count: 2 });
  });

  it("refuses a ZIP whose private R2 metadata no longer matches D1", async () => {
    const { visitUuid } = await seedCompletedPictureNaming(104);
    const scheduled = await ensureRecordingExportQueued(env, visitUuid, "picture_naming");
    await processRecordingExport(env, scheduled.export_uuid);
    const exportRow = await env.DB.prepare(`
      SELECT * FROM recording_exports WHERE export_uuid = ?
    `).bind(scheduled.export_uuid).first();
    const original = await env.EXPORTS.get(exportRow.r2_key);
    const bytes = await original.arrayBuffer();
    await env.EXPORTS.put(exportRow.r2_key, bytes, {
      httpMetadata: {
        contentType: "application/zip",
        contentDisposition: `attachment; filename="${exportRow.filename}"`,
        cacheControl: "private, no-store",
      },
      customMetadata: {
        export_uuid: crypto.randomUUID(),
        phase_code: exportRow.phase_code,
        source_snapshot_sha256: exportRow.source_snapshot_sha256,
        member_count: String(exportRow.member_count),
      },
    });

    const downloaded = await api(
      `/api/admin/visits/${visitUuid}/recordings/picture_naming.zip`,
      { token: ADMIN_TOKEN },
    );
    expect(downloaded.response.status).toBe(503);
    expect(downloaded.json.error.code).toBe("recording_export_integrity_mismatch");
    const audits = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM recording_export_downloads WHERE export_uuid = ?
    `).bind(exportRow.export_uuid).first();
    expect(Number(audits.count)).toBe(0);
  });
});
