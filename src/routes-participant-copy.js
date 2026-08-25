import { requireAdmin, requireSession } from "./lib/auth.js";
import { ApiError, requireMethod } from "./lib/http.js";
import { crc32, createStoredZipStream, storedZipSize } from "./lib/stored-zip.js";

const encoder = new TextEncoder();

function parseStoredPayload(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
    return payload;
  } catch {
    throw new ApiError(500, "participant_copy_payload_invalid", "A stored response cannot be copied");
  }
}

function recordingEntryName(row) {
  return `recordings/${row.visit_type}/${row.segment}/recording_${String(row.segment_ordinal).padStart(3, "0")}.wav`;
}

function participantCopyFilename() {
  return "accentedness_results.zip";
}

function adminCopyFilename(numericId) {
  return `accentedness_p${numericId}_results.zip`;
}

function inlineEntry(name, text) {
  const bytes = encoder.encode(text);
  return { name, bytes, size: bytes.byteLength, crc32: crc32(bytes) };
}

async function participantVisits(env, session) {
  const result = await env.DB.prepare(`
    SELECT visit_type, status, expected_trial_count, expected_recording_count,
           behavioral_completed_at_ms, finalized_at_ms
    FROM visits
    WHERE participant_uuid = ?
    ORDER BY CASE visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END
  `).bind(session.participant_uuid).all();
  return result.results;
}

async function canonicalParticipantRows(env, session) {
  const result = await env.DB.prepare(`
    SELECT
      v.visit_type,
      tm.trial_uuid, tm.ordinal, tm.segment, tm.segment_ordinal, tm.practice,
      tm.exclude_from_analysis, tm.item_id, tm.item_word, tm.item_gloss,
      tm.list_id, tm.list_rank, tm.variability, tm.exposure, tm.cycle,
      tm.learning_block, tm.miniblock, tm.test_accent, tm.talker_id,
      tm.audio_key, tm.image_key, tm.asset_version, tm.placeholder_asset,
      tm.expects_recording,
      ta.attempt_uuid, ta.attempt_no, ta.state AS response_state,
      ta.repeated_after_interruption, ta.extra_exposure,
      ta.server_started_at_ms, ta.server_received_at_ms,
      ta.client_started_perf_ms, ta.client_received_perf_ms,
      ta.payload_hash, ta.payload_json,
      r.r2_key, r.state AS recording_state, r.sha256, r.crc32,
      r.byte_count, r.sample_rate_hz, r.sample_count, r.duration_seconds,
      r.analysis_start_seconds, r.analyzed_sample_count,
      r.rms_amplitude, r.peak_amplitude, r.clipping_ratio,
      r.received_at_ms, r.uploaded_at_ms
    FROM visits v
    JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
    LEFT JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
    LEFT JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
    WHERE v.participant_uuid = ?
    ORDER BY CASE v.visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END,
             tm.ordinal
  `).bind(session.participant_uuid).all();
  return result.results;
}

function assertCopyReady(visits, rows) {
  const requiredVisitTypes = ["pre", "immediate", "delayed"];
  if (visits.length !== requiredVisitTypes.length
      || visits.some((visit, index) => (
        visit.visit_type !== requiredVisitTypes[index]
        || visit.status !== "completed"
        || visit.finalized_at_ms === null
      ))) {
    throw new ApiError(
      409,
      "participant_copy_visits_incomplete",
      "All three visits must be completed before the participant copy is available",
    );
  }
  let missingResponses = 0;
  let missingRecordings = 0;
  for (const row of rows) {
    if (row.response_state !== "response_saved" || !row.payload_hash || !row.payload_json) {
      missingResponses += 1;
    }
    if (Number(row.expects_recording) === 1
        && (row.recording_state !== "uploaded"
          || !/^[0-9a-f]{64}$/u.test(String(row.sha256 ?? ""))
          || !Number.isSafeInteger(Number(row.crc32))
          || !Number.isSafeInteger(Number(row.byte_count))
          || Number(row.byte_count) <= 0
          || !row.r2_key)) {
      missingRecordings += 1;
    }
  }
  const expectedResponses = visits.reduce(
    (sum, visit) => sum + Number(visit.expected_trial_count),
    0,
  );
  const expectedRecordings = visits.reduce(
    (sum, visit) => sum + Number(visit.expected_recording_count),
    0,
  );
  const storedRecordings = rows.filter(recordingIsReady).length;
  if (rows.length !== expectedResponses
      || missingResponses > 0
      || missingRecordings > 0
      || storedRecordings !== expectedRecordings) {
    throw new ApiError(
      409,
      "participant_copy_not_ready",
      "The participant copy is not ready until every response and recording is stored",
      {
        expected_responses: expectedResponses,
        stored_responses: rows.length - missingResponses,
        expected_recordings: expectedRecordings,
        stored_recordings: storedRecordings,
      },
    );
  }
}

function recordingIsReady(row) {
  return Number(row.expects_recording) === 1
    && row.recording_state === "uploaded"
    && /^[0-9a-f]{64}$/u.test(String(row.sha256 ?? ""))
    && Number.isSafeInteger(Number(row.crc32))
    && Number.isSafeInteger(Number(row.byte_count))
    && Number(row.byte_count) > 0
    && Boolean(row.r2_key);
}

function buildResponseDocument(visits, rows, session, generatedAtMs, purpose) {
  return {
    copy_version: 1,
    copy_purpose: purpose,
    authoritative_storage: "research_server",
    generated_at_ms: generatedAtMs,
    participant: {
      participant_id: Number(session.numeric_id),
    },
    visits: visits.map((visit) => {
      const visitRows = rows.filter((row) => row.visit_type === visit.visit_type);
      return {
        visit_type: visit.visit_type,
        expected_response_count: Number(visit.expected_trial_count),
        copied_response_count: visitRows.length,
        expected_recording_count: Number(visit.expected_recording_count),
        copied_recording_count: visitRows.filter(recordingIsReady).length,
        behavioral_completed_at_ms: nullableNumber(visit.behavioral_completed_at_ms),
        finalized_at_ms: nullableNumber(visit.finalized_at_ms),
      };
    }),
    responses: rows.map((row) => {
      const response = {
        visit_type: row.visit_type,
        ordinal: Number(row.ordinal),
        segment: row.segment,
        segment_ordinal: Number(row.segment_ordinal),
        practice: Boolean(row.practice),
        exclude_from_analysis: Boolean(row.exclude_from_analysis),
        server_started_at_ms: Number(row.server_started_at_ms),
        server_received_at_ms: Number(row.server_received_at_ms),
        payload_sha256: row.payload_hash,
        payload: parseStoredPayload(row.payload_json),
        expects_recording: Boolean(row.expects_recording),
        recording: recordingIsReady(row) ? {
          archive_name: recordingEntryName(row),
          sha256: row.sha256,
          byte_count: Number(row.byte_count),
          sample_rate_hz: Number(row.sample_rate_hz),
          sample_count: Number(row.sample_count),
          duration_seconds: Number(row.duration_seconds),
          uploaded_at_ms: Number(row.uploaded_at_ms),
        } : null,
      };
      if (purpose === "research_admin_copy") {
        response.research = {
          trial_id: row.trial_uuid,
          attempt_id: row.attempt_uuid,
          attempt_no: Number(row.attempt_no),
          repeated_after_interruption: Boolean(row.repeated_after_interruption),
          extra_exposure: Boolean(row.extra_exposure),
          client_started_perf_ms: nullableNumber(row.client_started_perf_ms),
          client_received_perf_ms: nullableNumber(row.client_received_perf_ms),
          item: {
            id: Number(row.item_id),
            word: row.item_word,
            gloss: row.item_gloss,
            list_id: nullableNumber(row.list_id),
            list_rank: nullableNumber(row.list_rank),
            variability: row.variability,
            exposure: nullableNumber(row.exposure),
            cycle: nullableNumber(row.cycle),
            learning_block: nullableNumber(row.learning_block),
            miniblock: nullableNumber(row.miniblock),
            test_accent: row.test_accent,
            talker_id: row.talker_id,
            audio_key: row.audio_key,
            image_key: row.image_key,
            asset_version: row.asset_version,
            placeholder_asset: Boolean(row.placeholder_asset),
          },
          recording_storage: recordingIsReady(row) ? {
            r2_key: row.r2_key,
            crc32: Number(row.crc32),
            analysis_start_seconds: nullableNumber(row.analysis_start_seconds),
            analyzed_sample_count: nullableNumber(row.analyzed_sample_count),
            rms_amplitude: nullableNumber(row.rms_amplitude),
            peak_amplitude: nullableNumber(row.peak_amplitude),
            clipping_ratio: nullableNumber(row.clipping_ratio),
            received_at_ms: nullableNumber(row.received_at_ms),
          } : null,
        };
      }
      return response;
    }),
  };
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function copyEntries(visits, rows, participant, generatedAtMs, purpose) {
  const responseDocument = buildResponseDocument(
    visits,
    rows,
    { numeric_id: participant.numeric_id },
    generatedAtMs,
    purpose,
  );
  const readme = [
    "Accentedness experiment: result copy",
    "",
    "このZIPは、収集済みの回答データと録音のコピーです。",
    "研究用サーバーに保存されたデータの代替ではありません。",
    "共用パソコンでは音声と回答が他の利用者に見えない保存先を選び、研究担当者の案内に従って削除してください。",
    purpose === "participant_local_copy"
      ? "招待情報、セッショントークン、刺激語、訳語、アクセント・話者条件は含まれていません。"
      : "responses.jsonのresearch欄に採点・照合用の刺激、条件、内部ID、録音QCを含みます。",
    "responses.jsonには試行順、計時情報、録音ファイルのSHA-256が含まれます。",
    "",
  ].join("\n");
  return [
    inlineEntry("README.txt", readme),
    inlineEntry("responses.json", `${JSON.stringify(responseDocument, null, 2)}\n`),
    ...rows.filter(recordingIsReady).map((row) => ({
      name: recordingEntryName(row),
      key: row.r2_key,
      size: Number(row.byte_count),
      crc32: Number(row.crc32),
      sha256: row.sha256,
    })),
  ];
}

function zipResponse(env, entries, generatedAtMs, filename = participantCopyFilename()) {
  const { readable, completion } = createStoredZipStream({
    bucket: env.RECORDINGS,
    entries,
    generatedAt: new Date(generatedAtMs),
  });
  void completion.catch((error) => {
    console.error(JSON.stringify({ message: "result_copy_stream_failed", error: String(error) }));
  });
  return new Response(readable, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(storedZipSize(entries)),
      "Content-Type": "application/zip",
      "Referrer-Policy": "no-referrer",
      "X-Archive-Entry-Count": String(entries.length),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function downloadParticipantCopy(request, env) {
  requireMethod(request, ["GET"]);
  const session = await requireSession(request, env, { allowCompleted: true });
  if (session.visit_type !== "delayed") {
    throw new ApiError(
      403,
      "participant_copy_unavailable",
      "Participant result copies are available only after the final delayed session",
    );
  }
  if (session.visit_status !== "completed") {
    throw new ApiError(
      409,
      "participant_copy_before_completion",
      "The delayed visit must be completed before the participant copy is available",
    );
  }
  const [visits, rows] = await Promise.all([
    participantVisits(env, session),
    canonicalParticipantRows(env, session),
  ]);
  assertCopyReady(visits, rows);

  const generatedAtMs = Date.now();
  return zipResponse(
    env,
    copyEntries(visits, rows, session, generatedAtMs, "participant_local_copy"),
    generatedAtMs,
  );
}

export async function downloadAdminParticipantCopy(request, env, numericIdInput) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const numericIdText = String(numericIdInput ?? "");
  const numericId = Number(numericIdText);
  if (!/^[1-9][0-9]*$/u.test(numericIdText) || !Number.isSafeInteger(numericId)) {
    throw new ApiError(400, "invalid_participant_id", "participant_id must be a positive integer");
  }
  const participant = await env.DB.prepare(`
    SELECT participant_uuid, numeric_id FROM participants WHERE numeric_id = ? LIMIT 1
  `).bind(numericId).first();
  if (!participant) throw new ApiError(404, "participant_not_found", "Participant was not found");
  const sessionLike = { participant_uuid: participant.participant_uuid };
  const [visits, allRows] = await Promise.all([
    participantVisits(env, sessionLike),
    canonicalParticipantRows(env, sessionLike),
  ]);
  const rows = allRows.filter((row) => row.response_state === "response_saved" && row.payload_json);
  if (!rows.length) {
    throw new ApiError(409, "participant_results_empty", "No canonical responses have been collected");
  }
  const adminVisits = visits.map((visit) => ({
    ...visit,
    behavioral_completed_at_ms: nullableNumber(visit.behavioral_completed_at_ms),
    finalized_at_ms: nullableNumber(visit.finalized_at_ms),
  }));
  const generatedAtMs = Date.now();
  return zipResponse(
    env,
    copyEntries(adminVisits, rows, participant, generatedAtMs, "research_admin_copy"),
    generatedAtMs,
    adminCopyFilename(numericId),
  );
}
