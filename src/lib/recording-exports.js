import { sha256Hex, stableJson } from "./crypto.js";
import { crc32, createStoredZipStream } from "./zip.js";

const EXPORTABLE_PHASES = new Set([
  "pre_picture_naming",
  "immediate_picture_naming",
  "immediate_l2_to_l1",
  "delayed_picture_naming",
  "delayed_l2_to_l1",
]);
const MAX_FILES_PER_EXPORT = 30;
const LEASE_MS = 10 * 60_000;
const EXPORT_RETENTION_MS = 7 * 86_400_000;

function slug(value, fallback = "unknown") {
  const clean = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return clean || fallback;
}

function timestampSlug(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function archiveEntryName(row) {
  const ordinal = String(row.segment_ordinal).padStart(2, "0");
  const phase = Number(row.practice) === 1 ? "practice" : "main";
  const item = slug(row.item_word, `item-${row.item_id}`);
  const accent = row.test_accent ? `_${slug(row.test_accent)}` : "";
  const talker = row.talker_id ? `_${slug(row.talker_id)}` : "";
  return `wav/${ordinal}_${phase}_${item}${accent}${talker}.wav`;
}

async function readyRecordingRows(env, visitUuid, segment) {
  const result = await env.DB.prepare(`
    SELECT
      v.visit_type, v.participant_uuid, p.numeric_id, s.status AS segment_status,
      tm.trial_uuid, tm.segment_ordinal, tm.practice, tm.item_id, tm.item_word,
      tm.test_accent, tm.talker_id, tm.canonical_attempt_uuid AS attempt_uuid,
      r.r2_key, r.state AS recording_state, r.sha256, r.crc32,
      r.byte_count, r.uploaded_at_ms
    FROM visits v
    JOIN participants p ON p.participant_uuid = v.participant_uuid
    JOIN segments s ON s.visit_uuid = v.visit_uuid AND s.segment = ?
    JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid AND tm.segment = s.segment
    LEFT JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
    WHERE v.visit_uuid = ? AND tm.expects_recording = 1
    ORDER BY tm.segment_ordinal
  `).bind(segment, visitUuid).all();
  return result.results;
}

async function sendExportMessage(env, exportUuid) {
  try {
    await env.EXPORT_QUEUE.send({ export_uuid: exportUuid });
    await env.DB.prepare(`
      UPDATE recording_exports SET enqueued_at_ms = ?, updated_at_ms = ?
      WHERE export_uuid = ? AND state = 'pending'
    `).bind(Date.now(), Date.now(), exportUuid).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      message: "recording_export_enqueue_failed",
      export_uuid: exportUuid,
      error: String(error),
    }));
    return false;
  }
}

export async function ensureRecordingExportQueued(env, visitUuid, segment) {
  if (!new Set(["picture_naming", "l2_to_l1"]).has(segment)) return { ready: false };
  const rows = await readyRecordingRows(env, visitUuid, segment);
  if (!rows.length || rows[0].segment_status !== "completed") return { ready: false };
  if (rows.length > MAX_FILES_PER_EXPORT) throw new Error("recording_export_member_limit_exceeded");
  const allReady = rows.every((row) => row.recording_state === "uploaded"
    && /^[0-9a-f]{64}$/u.test(String(row.sha256 ?? ""))
    && Number.isSafeInteger(Number(row.crc32))
    && Number.isSafeInteger(Number(row.byte_count))
    && Number(row.byte_count) > 0
    && Number.isSafeInteger(Number(row.uploaded_at_ms)));
  if (!allReady) return { ready: false };

  const phaseCode = `${rows[0].visit_type}_${segment}`;
  if (!EXPORTABLE_PHASES.has(phaseCode)) throw new Error("recording_export_phase_invalid");
  const members = rows.map((row) => ({
    attempt_uuid: row.attempt_uuid,
    trial_uuid: row.trial_uuid,
    segment_ordinal: Number(row.segment_ordinal),
    practice: Number(row.practice),
    entry_name: archiveEntryName(row),
    r2_key: row.r2_key,
    sha256: row.sha256,
    crc32: Number(row.crc32),
    byte_count: Number(row.byte_count),
    uploaded_at_ms: Number(row.uploaded_at_ms),
  }));
  const sourceSnapshotSha256 = await sha256Hex(stableJson(members));
  const existing = await env.DB.prepare(`
    SELECT export_uuid, state FROM recording_exports
    WHERE visit_uuid = ? AND segment = ? LIMIT 1
  `).bind(visitUuid, segment).first();
  if (existing) {
    if (existing.state === "failed") {
      const nowMs = Date.now();
      await env.DB.prepare(`
        UPDATE recording_exports
        SET state = 'pending', enqueued_at_ms = NULL, failed_at_ms = NULL,
            last_error_code = NULL, updated_at_ms = ?
        WHERE export_uuid = ? AND state = 'failed'
      `).bind(nowMs, existing.export_uuid).run();
      await sendExportMessage(env, existing.export_uuid);
    }
    return { ready: true, export_uuid: existing.export_uuid, existing: true };
  }

  const nowMs = Date.now();
  const exportUuid = crypto.randomUUID();
  const participantLabel = `p${String(rows[0].numeric_id).padStart(6, "0")}`;
  const filename = `${participantLabel}_${phaseCode}_${timestampSlug(nowMs)}.zip`;
  const r2Key = `exports/${rows[0].participant_uuid}/${phaseCode}/${exportUuid}.zip`;
  const sourceTotalBytes = members.reduce((sum, member) => sum + member.byte_count, 0);
  const statements = [
    env.DB.prepare(`
      INSERT OR IGNORE INTO recording_exports (
        export_uuid, participant_uuid, visit_uuid, segment, phase_code, state,
        source_snapshot_sha256, filename, r2_key, member_count, source_total_bytes,
        requested_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      exportUuid,
      rows[0].participant_uuid,
      visitUuid,
      segment,
      phaseCode,
      sourceSnapshotSha256,
      filename,
      r2Key,
      members.length,
      sourceTotalBytes,
      nowMs,
      nowMs,
    ),
    ...members.map((member) => env.DB.prepare(`
      INSERT OR IGNORE INTO recording_export_members (
        export_uuid, attempt_uuid, trial_uuid, segment_ordinal, practice,
        entry_name, r2_key, sha256, crc32, byte_count, uploaded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      exportUuid,
      member.attempt_uuid,
      member.trial_uuid,
      member.segment_ordinal,
      member.practice,
      member.entry_name,
      member.r2_key,
      member.sha256,
      member.crc32,
      member.byte_count,
      member.uploaded_at_ms,
    )),
    env.DB.prepare(`
      INSERT INTO audit_log (
        audit_uuid, actor_type, action, participant_uuid, visit_uuid, server_at_ms, details_json
      ) VALUES (?, 'system', 'recording_export_requested', ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      rows[0].participant_uuid,
      visitUuid,
      nowMs,
      stableJson({ export_uuid: exportUuid, phase_code: phaseCode, source_snapshot_sha256: sourceSnapshotSha256 }),
    ),
  ];
  await env.DB.batch(statements);
  const canonical = await env.DB.prepare(`
    SELECT export_uuid FROM recording_exports WHERE visit_uuid = ? AND segment = ? LIMIT 1
  `).bind(visitUuid, segment).first();
  if (!canonical) throw new Error("recording_export_insert_failed");
  if (canonical.export_uuid === exportUuid) await sendExportMessage(env, exportUuid);
  return { ready: true, export_uuid: canonical.export_uuid, existing: canonical.export_uuid !== exportUuid };
}

export async function processRecordingExport(env, exportUuid) {
  const nowMs = Date.now();
  const leaseToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(`
    UPDATE recording_exports
    SET state = 'building', lease_token = ?, lease_expires_at_ms = ?,
        attempt_count = attempt_count + 1,
        started_at_ms = COALESCE(started_at_ms, ?), updated_at_ms = ?
    WHERE export_uuid = ?
      AND (
        state IN ('pending', 'failed')
        OR (state = 'building' AND COALESCE(lease_expires_at_ms, 0) <= ?)
      )
  `).bind(leaseToken, nowMs + LEASE_MS, nowMs, nowMs, exportUuid, nowMs).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare(`
      SELECT state FROM recording_exports WHERE export_uuid = ? LIMIT 1
    `).bind(exportUuid).first();
    if (!current) throw new Error("recording_export_not_found");
    return { skipped: true, state: current.state };
  }

  const exportRow = await env.DB.prepare(`
    SELECT * FROM recording_exports WHERE export_uuid = ? LIMIT 1
  `).bind(exportUuid).first();
  const memberResult = await env.DB.prepare(`
    SELECT * FROM recording_export_members
    WHERE export_uuid = ? ORDER BY segment_ordinal
  `).bind(exportUuid).all();
  const members = memberResult.results;
  if (!exportRow || members.length !== Number(exportRow.member_count)) {
    throw new Error("recording_export_snapshot_incomplete");
  }

  try {
    const existingObject = await env.EXPORTS.head(exportRow.r2_key);
    let object = existingObject;
    if (existingObject
        && existingObject.customMetadata?.source_snapshot_sha256 !== exportRow.source_snapshot_sha256) {
      throw new Error("recording_export_object_conflict");
    }
    if (!object) {
      const manifestBytes = new TextEncoder().encode(`${JSON.stringify({
        export_version: 1,
        export_uuid: exportUuid,
        phase_code: exportRow.phase_code,
        source_snapshot_sha256: exportRow.source_snapshot_sha256,
        members: members.map((member) => ({
          attempt_uuid: member.attempt_uuid,
          trial_uuid: member.trial_uuid,
          segment_ordinal: Number(member.segment_ordinal),
          practice: Boolean(member.practice),
          archive_name: member.entry_name,
          sha256: member.sha256,
          byte_count: Number(member.byte_count),
          uploaded_at_ms: Number(member.uploaded_at_ms),
        })),
      }, null, 2)}\n`);
      const entries = [
        {
          name: "manifest.json",
          bytes: manifestBytes,
          size: manifestBytes.byteLength,
          crc32: crc32(manifestBytes),
        },
        ...members.map((member) => ({
          key: member.r2_key,
          name: member.entry_name,
          size: Number(member.byte_count),
          crc32: Number(member.crc32),
          sha256: member.sha256,
        })),
      ];
      const { readable, completion } = createStoredZipStream({
        bucket: env.RECORDINGS,
        entries,
        generatedAt: new Date(Number(exportRow.requested_at_ms)),
      });
      const completionResult = completion.then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      try {
        object = await env.EXPORTS.put(exportRow.r2_key, readable, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: {
            contentType: "application/zip",
            contentDisposition: `attachment; filename="${exportRow.filename}"`,
            cacheControl: "private, no-store",
          },
          customMetadata: {
            export_uuid: exportUuid,
            phase_code: exportRow.phase_code,
            source_snapshot_sha256: exportRow.source_snapshot_sha256,
            member_count: String(exportRow.member_count),
          },
        });
      } catch (error) {
        await readable.cancel(error).catch(() => {});
        await completionResult;
        throw error;
      }
      if (!object) {
        await readable.cancel(new Error("recording_export_put_precondition_failed")).catch(() => {});
        await completionResult;
        object = await env.EXPORTS.head(exportRow.r2_key);
        if (!object
            || object.customMetadata?.source_snapshot_sha256 !== exportRow.source_snapshot_sha256) {
          throw new Error("recording_export_put_conflict");
        }
      } else {
        const pump = await completionResult;
        if (!pump.ok) throw pump.error;
      }
    }

    const readyAtMs = Date.now();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE recording_exports
        SET state = 'ready', zip_byte_count = ?, r2_etag = ?, ready_at_ms = ?,
            expires_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
            failed_at_ms = NULL, last_error_code = NULL, updated_at_ms = ?
        WHERE export_uuid = ? AND lease_token = ?
      `).bind(
        object.size,
        object.etag,
        readyAtMs,
        readyAtMs + EXPORT_RETENTION_MS,
        readyAtMs,
        exportUuid,
        leaseToken,
      ),
      env.DB.prepare(`
        INSERT INTO audit_log (
          audit_uuid, actor_type, action, participant_uuid, visit_uuid, server_at_ms, details_json
        ) VALUES (?, 'system', 'recording_export_ready', ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        exportRow.participant_uuid,
        exportRow.visit_uuid,
        readyAtMs,
        stableJson({ export_uuid: exportUuid, zip_byte_count: object.size, r2_etag: object.etag }),
      ),
    ]);
    return { skipped: false, state: "ready" };
  } catch (error) {
    const failedAtMs = Date.now();
    const code = String(error?.message ?? error).split(":", 1)[0].slice(0, 80) || "build_failed";
    await env.DB.prepare(`
      UPDATE recording_exports
      SET state = 'failed', failed_at_ms = ?, last_error_code = ?,
          lease_token = NULL, lease_expires_at_ms = NULL, updated_at_ms = ?
      WHERE export_uuid = ? AND lease_token = ?
    `).bind(failedAtMs, code, failedAtMs, exportUuid, leaseToken).run();
    throw error;
  }
}

export async function reconcileRecordingExports(env) {
  const nowMs = Date.now();
  const staleBeforeMs = nowMs - 10 * 60_000;
  const result = await env.DB.prepare(`
    SELECT export_uuid FROM recording_exports
    WHERE (
      state = 'pending' AND (enqueued_at_ms IS NULL OR enqueued_at_ms <= ?)
    ) OR (
      state = 'building' AND COALESCE(lease_expires_at_ms, 0) <= ?
    ) OR (
      state = 'failed' AND attempt_count < 5 AND updated_at_ms <= ?
    )
    ORDER BY requested_at_ms LIMIT 50
  `).bind(staleBeforeMs, nowMs, staleBeforeMs).all();
  for (const row of result.results) {
    await env.DB.prepare(`
      UPDATE recording_exports
      SET state = 'pending', lease_token = NULL, lease_expires_at_ms = NULL,
          enqueued_at_ms = NULL, updated_at_ms = ?
      WHERE export_uuid = ? AND state != 'ready'
    `).bind(nowMs, row.export_uuid).run();
    await sendExportMessage(env, row.export_uuid);
  }
  return result.results.length;
}
