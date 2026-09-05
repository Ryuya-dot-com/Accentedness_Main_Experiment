import { sha256Hex } from "../../src/lib/crypto.js";
import { crc32 } from "../../src/lib/stored-zip.js";

// Synthetic fixtures only; never import into the deployed Worker or browser bundle.
function seededLearningPayload(segmentOrdinal) {
  const visualOnsetPerfMs = 1_000 + segmentOrdinal * 10;
  const visualOnsetContextS = 10 + segmentOrdinal;
  return {
    task: "learning",
    client_response_saved_perf_ms: visualOnsetPerfMs + 5_100,
    visual_mode: "image",
    visual_onset_perf_ms: visualOnsetPerfMs,
    visual_onset_context_s: visualOnsetContextS,
    clock_anchor: {
      context_time_s: visualOnsetContextS,
      performance_time_ms: visualOnsetPerfMs,
      performance_time_origin_ms: 1_000_000,
    },
    target_onset_perf_ms: visualOnsetPerfMs - 2,
    onset_late_ms: 2,
    visual_deadline_perf_ms: visualOnsetPerfMs + 5_000,
    visual_hidden_perf_ms: visualOnsetPerfMs + 5_001,
    audio_scheduled_context_s: visualOnsetContextS + 0.75,
    audio_scheduled_end_context_s: visualOnsetContextS + 1.25,
    audio_duration_s: 0.5,
    audio_ended_perf_ms: visualOnsetPerfMs + 1_251,
    trial_end_perf_ms: visualOnsetPerfMs + 5_001,
    visibility_interrupted: false,
    page_visibility_at_end: "visible",
  };
}

export async function seedVisit(env, visitUuid, sessionUuid, visitType, { skipTrialUuid = null, recordingBytes = null } = {}) {
  const trialResult = await env.DB.prepare(`
    SELECT trial_uuid, segment, segment_ordinal, expects_recording
    FROM trial_manifest WHERE visit_uuid = ? ORDER BY ordinal
  `).bind(visitUuid).all();
  const statements = [];
  for (const trial of trialResult.results) {
    if (trial.trial_uuid === skipTrialUuid) continue;
    const attemptUuid = crypto.randomUUID();
    const payload = JSON.stringify(trial.segment === "learning"
      ? seededLearningPayload(Number(trial.segment_ordinal))
      : { task: trial.segment, timing_marker: `${visitType}-${trial.segment_ordinal}` });
    const payloadHash = await sha256Hex(payload);
    statements.push(
      env.DB.prepare(`
        INSERT INTO trial_attempts (
          attempt_uuid, trial_uuid, attempt_no, session_uuid, start_key, response_key,
          state, repeated_after_interruption, extra_exposure, server_started_at_ms,
          server_received_at_ms, payload_hash, payload_json
        ) VALUES (?, ?, 1, ?, ?, ?, 'response_saved', 0, 0, ?, ?, ?, ?)
      `).bind(
        attemptUuid,
        trial.trial_uuid,
        sessionUuid,
        crypto.randomUUID(),
        crypto.randomUUID(),
        Date.now() - 100,
        Date.now(),
        payloadHash,
        payload,
      ),
      env.DB.prepare(`
        UPDATE trial_manifest SET canonical_attempt_uuid = ? WHERE trial_uuid = ?
      `).bind(attemptUuid, trial.trial_uuid),
    );
    if (Number(trial.expects_recording) === 1) {
      const bytes = recordingBytes ?? new Uint8Array([82, 73, 70, 70, Number(trial.segment_ordinal) & 0xff]);
      const sampleCount = recordingBytes ? (bytes.byteLength - 44) / 2 : 1;
      const sha256 = await sha256Hex(bytes);
      const r2Key = `recordings/participant-copy-test/${attemptUuid}.wav`;
      const object = await env.RECORDINGS.put(r2Key, bytes, {
        httpMetadata: { contentType: "audio/wav", cacheControl: "private, no-store" },
        customMetadata: { sha256 },
      });
      statements.push(env.DB.prepare(`
        INSERT INTO recordings (
          attempt_uuid, r2_key, state, sha256, etag, byte_count, mime_type,
          sample_rate_hz, sample_count, duration_seconds, crc32,
          analysis_start_seconds, analyzed_sample_count, rms_amplitude,
          peak_amplitude, clipping_ratio, received_at_ms, uploaded_at_ms, updated_at_ms
        ) VALUES (?, ?, 'uploaded', ?, ?, ?, 'audio/wav', 48000, ?, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?)
      `).bind(
        attemptUuid,
        r2Key,
        sha256,
        object.etag,
        bytes.byteLength,
        sampleCount,
        recordingBytes ? sampleCount / 48_000 : 0.00002,
        crc32(bytes),
        sampleCount,
        Date.now(),
        Date.now(),
        Date.now(),
      ));
    }
  }
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
  await env.DB.prepare(`
    UPDATE segments SET status = 'completed', completed_at_ms = ? WHERE visit_uuid = ?
  `).bind(Date.now(), visitUuid).run();
}

export function silenceWav() {
  const sampleRate = 48_000;
  const sampleCount = 480_000;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}
