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
  const result = await jsonRequest("/api/invitations/redeem", {
    method: "POST",
    body: {
      token: invitationToken(invitationUrl),
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: visitType,
    },
  });
  expect(result.response.status).toBe(200);
  return result.json;
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
    const payload = JSON.stringify({ task: trial.segment, timing_marker: `${visitType}-${trial.segment_ordinal}` });
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
          received_at_ms, uploaded_at_ms, updated_at_ms
        ) VALUES (?, ?, 'uploaded', ?, ?, ?, 'audio/wav', 48000, 1, 0.00002, ?, ?, ?, ?)
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
        received_at_ms: expect.any(Number),
      });
  }, 60_000);

  it("requires admin authentication for researcher downloads", async () => {
    const response = await request("/api/admin/participants/901/results.zip");
    expect(response.status).toBe(401);
  });
});
