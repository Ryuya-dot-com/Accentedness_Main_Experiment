import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto.js";
import { crc32 } from "../src/lib/stored-zip.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function request(path, { method = "GET", token = null, body = null } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== null) headers.set("Content-Type", "application/json");
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
  }));
  return response;
}

async function jsonRequest(path, options = {}) {
  const response = await request(path, options);
  return { response, json: await response.json() };
}

function invitationToken(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("t");
}

async function redeem(invitationUrl, visitType) {
  const nameAction = visitType === "pre" ? "register" : "confirm";
  const result = await jsonRequest("/api/invitations/redeem", {
    method: "POST",
    body: {
      token: invitationToken(invitationUrl),
      participant_id: 901,
      name_action: nameAction,
      participant_name_confirmed: true,
      ...(nameAction === "register" ? { participant_name: "Test Participant" } : {}),
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: visitType,
    },
  });
  expect(result.response.status).toBe(200);
  return result.json;
}

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

async function seedVisit(visitUuid, sessionUuid, visitType, { skipTrialUuid = null } = {}) {
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
      const bytes = new Uint8Array([82, 73, 70, 70, Number(trial.segment_ordinal) & 0xff]);
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
        ) VALUES (?, ?, 'uploaded', ?, ?, ?, 'audio/wav', 48000, 1, 0.00002, ?, 0, 1, 0, 0, 0, ?, ?, ?)
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

function validPictureNamingPayload() {
  return {
    task: "picture_naming",
    client_response_saved_perf_ms: 10_500,
    visual_mode: "image",
    visual_onset_perf_ms: 350,
    visual_onset_context_s: 1,
    clock_anchor: {
      context_time_s: 1,
      performance_time_ms: 350,
      performance_time_origin_ms: 1_000,
    },
    target_onset_perf_ms: 350,
    onset_late_ms: 0,
    response_deadline_perf_ms: 10_350,
    response_deadline_context_s: 11,
    visual_hidden_perf_ms: 10_351,
    response_window_ms: 10_000,
    sample_rate_hz: 48_000,
    sample_count: 480_000,
    duration_seconds: 10,
    capture_start_context_s: 1,
    capture_stop_context_s: 11,
    capture_stop_command_perf_ms: 10_350,
    capture_stopped_perf_ms: 10_360,
    scheduled_stop_context_s: 11,
    expected_sample_count: 480_000,
    sample_count_difference: 0,
    missing_input_frames: 0,
    visibility_interrupted: false,
    measured_pre_roll_ms: 0,
    microphone_settings: {
      sample_rate: 48_000,
      channel_count: 1,
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain_control: false,
    },
    quality: {
      analysis_start_seconds: 0,
      analyzed_sample_count: 480_000,
      rms_amplitude: 0,
      peak_amplitude: 0,
      clipping_ratio: 0,
    },
  };
}

function silenceWav() {
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

function parseStoredEntries(archiveBytes) {
  const bytes = new Uint8Array(archiveBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  const localEntries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const storedCrc32 = view.getUint32(offset + 14, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(storedCrc32);
    entries.set(name, data);
    localEntries.set(name, { crc32: storedCrc32, size, offset });
    offset = dataStart + size;
  }

  const endOffset = bytes.byteLength - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x06054b50);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  expect(entryCount).toBe(localEntries.size);
  expect(centralOffset).toBe(offset);
  expect(centralOffset + centralSize).toBe(endOffset);

  let centralCursor = centralOffset;
  let centralCount = 0;
  while (centralCursor < endOffset) {
    expect(view.getUint32(centralCursor, true)).toBe(0x02014b50);
    expect(view.getUint16(centralCursor + 10, true)).toBe(0);
    const storedCrc32 = view.getUint32(centralCursor + 16, true);
    const storedSize = view.getUint32(centralCursor + 20, true);
    expect(view.getUint32(centralCursor + 24, true)).toBe(storedSize);
    const nameLength = view.getUint16(centralCursor + 28, true);
    const extraLength = view.getUint16(centralCursor + 30, true);
    const commentLength = view.getUint16(centralCursor + 32, true);
    const localOffset = view.getUint32(centralCursor + 42, true);
    const name = decoder.decode(bytes.slice(
      centralCursor + 46,
      centralCursor + 46 + nameLength,
    ));
    expect(localEntries.get(name)).toEqual({
      crc32: storedCrc32,
      size: storedSize,
      offset: localOffset,
    });
    centralCursor += 46 + nameLength + extraLength + commentLength;
    centralCount += 1;
  }
  expect(centralCount).toBe(entryCount);
  return entries;
}

async function completeVisit(token) {
  const response = await request("/api/visit/complete", { method: "POST", token, body: {} });
  expect(response.status).toBe(200);
}

describe("on-demand result ZIP", () => {
  it("is participant-accessible only after delayed completion and contains all three visits without labels or UUIDs", async () => {
    const createdResult = await jsonRequest("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 901 },
    });
    expect(createdResult.response.status).toBe(201);
    const created = createdResult.json;

    const pre = await redeem(created.invitation.invitation_url, "pre");
    const preForbidden = await request("/api/visit/results.zip", { token: pre.session_token });
    expect(preForbidden.status).toBe(403);
    await seedVisit(created.participant.pre_visit_id, pre.session.session_id, "pre");
    await completeVisit(pre.session_token);

    const immediateInvitation = await jsonRequest(
      `/api/admin/visits/${created.participant.immediate_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    const immediate = await redeem(immediateInvitation.json.invitation.invitation_url, "immediate");
    await seedVisit(
      created.participant.immediate_visit_id,
      immediate.session.session_id,
      "immediate",
    );
    await completeVisit(immediate.session_token);
    await env.DB.prepare(`
      UPDATE visits SET target_at_ms = 1, available_at_ms = 1 WHERE visit_uuid = ?
    `).bind(created.participant.delayed_visit_id).run();

    const delayedInvitation = await jsonRequest(
      `/api/admin/visits/${created.participant.delayed_visit_id}/invitations`,
      { method: "POST", token: ADMIN_TOKEN, body: {} },
    );
    const delayed = await redeem(delayedInvitation.json.invitation.invitation_url, "delayed");
    const routeUploadedTrial = delayed.manifest[0];
    await seedVisit(
      created.participant.delayed_visit_id,
      delayed.session.session_id,
      "delayed",
      { skipTrialUuid: routeUploadedTrial.trial_id },
    );
    const started = await jsonRequest(`/api/trials/${routeUploadedTrial.trial_id}/start`, {
      method: "POST",
      token: delayed.session_token,
      body: {
        start_key: crypto.randomUUID(),
        client_started_perf_ms: 1,
        resume_after_stimulus: false,
      },
    });
    expect(started.response.status).toBe(201);
    await env.DB.prepare(`
      UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 10000
      WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).run();
    const saved = await jsonRequest(`/api/trials/${routeUploadedTrial.trial_id}/response`, {
      method: "PUT",
      token: delayed.session_token,
      body: {
        attempt_id: started.json.attempt_id,
        response_key: crypto.randomUUID(),
        payload: validPictureNamingPayload(),
      },
    });
    expect(saved.response.status).toBe(200);
    const routeUploadedWav = silenceWav();
    const routeUploadedSha256 = await sha256Hex(routeUploadedWav);
    const uploaded = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${delayed.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(routeUploadedWav.byteLength),
          "X-Content-SHA256": routeUploadedSha256,
        },
        body: routeUploadedWav,
      },
    ));
    expect(uploaded.status).toBe(200);
    const beforeCompletion = await jsonRequest("/api/visit/results.zip", {
      token: delayed.session_token,
    });
    expect(beforeCompletion.response.status).toBe(409);
    expect(beforeCompletion.json.error.code).toBe("participant_copy_before_completion");

    await completeVisit(delayed.session_token);
    const downloaded = await request("/api/visit/results.zip", { token: delayed.session_token });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Content-Type")).toBe("application/zip");
    expect(downloaded.headers.get("Content-Disposition")).toContain("accentedness_results.zip");
    const archive = await downloaded.arrayBuffer();
    expect(archive.byteLength).toBe(Number(downloaded.headers.get("Content-Length")));
    const entries = parseStoredEntries(archive);
    const responses = JSON.parse(new TextDecoder().decode(entries.get("responses.json")));
    expect(responses.visits.map((visit) => visit.visit_type)).toEqual([
      "pre",
      "immediate",
      "delayed",
    ]);
    expect(new Set(responses.responses.map((row) => row.visit_type))).toEqual(
      new Set(["pre", "immediate", "delayed"]),
    );
    expect(responses.copy_purpose).toBe("participant_local_copy");
    expect(responses.responses.every((row) => row.research === undefined)).toBe(true);
    expect(entries.has("design.json")).toBe(false);
    expect(entries.has("learning_trials.csv")).toBe(false);
    expect([...entries.keys()]).toContain("recordings/pre/picture_naming/recording_001.wav");
    expect([...entries.keys()]).toContain("recordings/immediate/l2_to_l1/recording_001.wav");
    expect([...entries.keys()]).toContain("recordings/delayed/l2_to_l1/recording_001.wav");
    expect(entries.get("recordings/delayed/picture_naming/recording_001.wav"))
      .toEqual(routeUploadedWav);
    const routeUploadedRecording = await env.DB.prepare(`
      SELECT crc32, sha256, byte_count FROM recordings WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).first();
    expect(routeUploadedRecording).toMatchObject({
      crc32: crc32(routeUploadedWav),
      sha256: routeUploadedSha256,
      byte_count: routeUploadedWav.byteLength,
    });
    const exposedText = new TextDecoder().decode(archive);
    expect(exposedText).not.toMatch(/casket|english|chinese|japanese|test_f/iu);
    expect(exposedText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);

    const adminDownload = await request(
      `/api/admin/participants/${created.participant.participant_id}/results.zip`,
      { token: ADMIN_TOKEN },
    );
    expect(adminDownload.status).toBe(200);
    expect(adminDownload.headers.get("Content-Disposition"))
      .toContain("accentedness_p901_results.zip");
    const adminEntries = parseStoredEntries(await adminDownload.arrayBuffer());
    const adminResponses = JSON.parse(
      new TextDecoder().decode(adminEntries.get("responses.json")),
    );
    expect(adminResponses.copy_purpose).toBe("research_admin_copy");
    expect(adminResponses.responses[0].research).toMatchObject({
      trial_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      attempt_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      attempt_no: 1,
      repeated_after_interruption: false,
      extra_exposure: false,
      item: {
        id: expect.any(Number),
        word: expect.any(String),
        gloss: expect.any(String),
        asset_version: expect.any(String),
      },
    });
    expect(adminResponses.responses.find((row) => row.recording)?.research.recording_storage)
      .toMatchObject({
        r2_key: expect.any(String),
        crc32: expect.any(Number),
        latency_reference: {
          event: "picture_onset",
          seconds_in_recording: expect.any(Number),
          acoustic_offset_correction_required: false,
        },
        received_at_ms: expect.any(Number),
      });
    expect(adminResponses.responses.find(
      (row) => row.segment === "l2_to_l1" && row.recording,
    ).research.recording_storage.latency_reference).toMatchObject({
      event: "test_audio_buffer_end",
      seconds_in_recording: expect.any(Number),
      acoustic_offset_correction_required: true,
    });

    const design = JSON.parse(new TextDecoder().decode(adminEntries.get("design.json")));
    const storedParticipantDesign = await env.DB.prepare(`
      SELECT numeric_id, training_accent, within_accent_q, counterbalance_cycle,
        counterbalance_cell, list_cell, order_cell, talker_cell,
        assignment_version, seed_algorithm_version, asset_version
      FROM participants WHERE numeric_id = 901
    `).first();
    const storedVisitDesign = await env.DB.prepare(`
      SELECT visit_type, manifest_hash FROM visits
      WHERE participant_uuid = (SELECT participant_uuid FROM participants WHERE numeric_id = 901)
      ORDER BY CASE visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END
    `).all();
    expect(design).toEqual({
      design_export_version: 1,
      participant: {
        participant_id: Number(storedParticipantDesign.numeric_id),
        training_accent: storedParticipantDesign.training_accent,
        counterbalance: {
          within_accent_q: Number(storedParticipantDesign.within_accent_q),
          cycle: Number(storedParticipantDesign.counterbalance_cycle),
          cell: Number(storedParticipantDesign.counterbalance_cell),
          list_cell: Number(storedParticipantDesign.list_cell),
          order_cell: Number(storedParticipantDesign.order_cell),
          talker_cell: Number(storedParticipantDesign.talker_cell),
        },
        assignment_version: storedParticipantDesign.assignment_version,
        seed_algorithm_version: storedParticipantDesign.seed_algorithm_version,
        asset_version: storedParticipantDesign.asset_version,
      },
      visits: storedVisitDesign.results,
    });
    expect(JSON.stringify(design)).not.toMatch(/participant_name|root_seed/iu);

    const learningCsvBytes = adminEntries.get("learning_trials.csv");
    expect([...learningCsvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const learningCsv = new TextDecoder().decode(learningCsvBytes);
    const learningLines = learningCsv.trimEnd().split("\r\n");
    const learningHeaders = learningLines[0].split(",");
    expect(learningLines).toHaveLength(
      adminResponses.responses.filter((row) => row.segment === "learning").length + 1,
    );
    expect(learningHeaders).toContain("planned_variability");
    expect(learningHeaders).toContain("planned_talker_id");
    expect(learningHeaders).toContain("planned_visual_duration_ms");
    expect(learningHeaders).toContain("runtime_canonical_response_state");
    expect(learningHeaders).toContain("runtime_total_attempt_count");
    expect(learningHeaders).toContain("runtime_noncanonical_attempt_count");
    expect(learningHeaders).toContain("runtime_server_trial_start_accepted_at_ms");
    expect(learningHeaders).toContain("runtime_client_response_saved_perf_ms");
    expect(learningHeaders).toContain("runtime_visual_onset_perf_ms");
    expect(learningHeaders).toContain("runtime_audio_scheduled_context_s");
    const learningRecords = learningLines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(
        learningHeaders.map((header, index) => [header, values[index]]),
      );
    });
    const firstLearning = learningRecords.find((record) => record.planned_practice === "false");
    expect(firstLearning).toMatchObject({
      csv_version: "1",
      participant_id: "901",
      visit_type: "immediate",
      planned_practice: "false",
      planned_exclude_from_analysis: "false",
      planned_visual_duration_ms: "5000",
      planned_audio_onset_ms: "750",
      planned_inter_trial_ms: "650",
      runtime_canonical_response_state: "response_saved",
      runtime_total_attempt_count: "1",
      runtime_noncanonical_attempt_count: "0",
      runtime_client_response_saved_perf_ms: "6130",
      runtime_target_visual_onset_perf_ms: "1028",
      runtime_visual_onset_perf_ms: "1030",
      runtime_onset_late_ms: "2",
      runtime_visibility_interrupted: "false",
    });
    expect(learningCsv).not.toMatch(/participant_name|root_seed|Test Participant/iu);
  }, 60_000);

  it("exports every planned learning trial before responses and leaves canonical runtime fields blank", async () => {
    const createdResult = await jsonRequest("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 902 },
    });
    expect(createdResult.response.status).toBe(201);

    const adminDownload = await request(
      "/api/admin/participants/902/results.zip",
      { token: ADMIN_TOKEN },
    );
    expect(adminDownload.status).toBe(200);
    const entries = parseStoredEntries(await adminDownload.arrayBuffer());
    const responses = JSON.parse(new TextDecoder().decode(entries.get("responses.json")));
    expect(responses.responses).toEqual([]);

    const learningCsv = new TextDecoder().decode(entries.get("learning_trials.csv"));
    const learningLines = learningCsv.trimEnd().split("\r\n");
    const headers = learningLines[0].split(",");
    const records = learningLines.slice(1).map((line) => {
      const values = line.split(",");
      return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    });
    expect(records).toHaveLength(146);
    expect(records.filter((record) => record.planned_practice === "true")).toHaveLength(2);
    expect(records.every((record) => record.runtime_canonical_attempt_id === "")).toBe(true);
    expect(records.every((record) => record.runtime_canonical_response_state === "")).toBe(true);
    expect(records.every((record) => record.runtime_attempt_no === "")).toBe(true);
    expect(records.every((record) => record.runtime_total_attempt_count === "0")).toBe(true);
    expect(records.every((record) => record.runtime_noncanonical_attempt_count === "0")).toBe(true);
  });

  it("requires admin authentication for researcher downloads", async () => {
    const response = await request("/api/admin/participants/901/results.zip");
    expect(response.status).toBe(401);
  });
});
