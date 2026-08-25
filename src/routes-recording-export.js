import { requireAdmin } from "./lib/auth.js";
import { ApiError, jsonResponse, requireMethod, requireUuid } from "./lib/http.js";

const EXPORTABLE_SEGMENTS = new Set(["picture_naming", "l2_to_l1"]);

export async function listRecordingExports(request, env) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const url = new URL(request.url);
  const participantIdText = url.searchParams.get("participant_id");
  const participantId = participantIdText === null ? null : Number(participantIdText);
  if (participantIdText !== null
      && (!/^[1-9][0-9]*$/u.test(participantIdText) || !Number.isSafeInteger(participantId))) {
    throw new ApiError(400, "invalid_participant_id", "participant_id must be a positive integer");
  }
  const result = participantId === null
    ? await env.DB.prepare(`
        SELECT e.*, p.numeric_id
        FROM recording_exports e
        JOIN participants p ON p.participant_uuid = e.participant_uuid
        ORDER BY e.requested_at_ms DESC LIMIT 200
      `).all()
    : await env.DB.prepare(`
        SELECT e.*, p.numeric_id
        FROM recording_exports e
        JOIN participants p ON p.participant_uuid = e.participant_uuid
        WHERE p.numeric_id = ?
        ORDER BY e.requested_at_ms DESC LIMIT 200
      `).bind(participantId).all();
  return jsonResponse({
    ok: true,
    server_now_ms: Date.now(),
    exports: result.results.map((row) => ({
      export_id: row.export_uuid,
      participant_id: row.numeric_id,
      visit_id: row.visit_uuid,
      phase_code: row.phase_code,
      segment: row.segment,
      state: row.state,
      filename: row.filename,
      member_count: row.member_count,
      source_total_bytes: row.source_total_bytes,
      zip_byte_count: row.zip_byte_count,
      requested_at_ms: row.requested_at_ms,
      ready_at_ms: row.ready_at_ms,
      expires_at_ms: row.expires_at_ms,
      download_count: row.download_count,
      last_error_code: row.last_error_code,
      download_path: `/api/admin/visits/${row.visit_uuid}/recordings/${row.segment}.zip`,
    })),
  });
}

function actorId(request) {
  return request.headers.has("Cf-Access-Authenticated-User-Email")
    ? "cloudflare-access"
    : "admin-token";
}

export async function downloadRecordingZip(request, env, visitUuidInput, segmentInput) {
  requireMethod(request, ["GET", "HEAD"]);
  await requireAdmin(request, env);
  const visitUuid = requireUuid(visitUuidInput, "visit_id");
  const segment = String(segmentInput);
  if (!EXPORTABLE_SEGMENTS.has(segment)) {
    throw new ApiError(404, "recording_export_segment_not_found", "This segment cannot be exported");
  }
  const exportRow = await env.DB.prepare(`
    SELECT * FROM recording_exports
    WHERE visit_uuid = ? AND segment = ? LIMIT 1
  `).bind(visitUuid, segment).first();
  if (!exportRow) {
    throw new ApiError(404, "recording_export_not_found", "The automatic ZIP export has not been created");
  }
  if (exportRow.state !== "ready") {
    throw new ApiError(409, "recording_export_not_ready", "The automatic ZIP export is not ready", {
      export_id: exportRow.export_uuid,
      state: exportRow.state,
      last_error_code: exportRow.last_error_code,
    });
  }

  const object = request.method === "HEAD"
    ? await env.EXPORTS.head(exportRow.r2_key)
    : await env.EXPORTS.get(exportRow.r2_key, {
        onlyIf: request.headers,
        range: request.headers,
      });
  if (!object) throw new ApiError(503, "recording_export_object_missing", "The ZIP object is missing from private storage");
  const objectMatchesDatabase = Number(object.size) === Number(exportRow.zip_byte_count)
    && object.etag === exportRow.r2_etag
    && object.customMetadata?.export_uuid === exportRow.export_uuid
    && object.customMetadata?.source_snapshot_sha256 === exportRow.source_snapshot_sha256;
  if (!objectMatchesDatabase) {
    throw new ApiError(
      503,
      "recording_export_integrity_mismatch",
      "The ZIP object does not match its database record",
    );
  }
  const hasBody = request.method === "GET" && "body" in object;
  let responseStatus = request.method === "GET" && !hasBody ? 412 : 200;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${exportRow.filename}"`,
    "Content-Type": "application/zip",
    "ETag": object.httpEtag,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Recording-Export-ID": exportRow.export_uuid,
  });
  if (hasBody
      && request.headers.has("Range")
      && object.range
      && Number.isFinite(object.range.offset)
      && Number.isFinite(object.range.length)) {
    const start = Number(object.range.offset);
    const length = Number(object.range.length);
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    responseStatus = 206;
  } else if (responseStatus !== 412) {
    headers.set("Content-Length", String(object.size));
  }

  const nowMs = Date.now();
  const downloadUuid = crypto.randomUUID();
  const requestId = request.headers.get("CF-Ray") ?? crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO recording_export_downloads (
        download_uuid, export_uuid, actor_id, request_id, method,
        requested_at_ms, range_header, response_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      downloadUuid,
      exportRow.export_uuid,
      actorId(request),
      requestId,
      request.method,
      nowMs,
      request.headers.get("Range"),
      responseStatus,
    ),
    env.DB.prepare(`
      UPDATE recording_exports
      SET download_count = download_count + 1, last_downloaded_at_ms = ?, updated_at_ms = ?
      WHERE export_uuid = ?
    `).bind(nowMs, nowMs, exportRow.export_uuid),
  ]);

  return new Response(hasBody ? object.body : null, { status: responseStatus, headers });
}
