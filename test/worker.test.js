import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/lib/crypto.js";
import { ensureRecordingExportQueued, processRecordingExport } from "../src/lib/recording-exports.js";
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

async function createParticipant(id = 1, visitType = "immediate") {
  const result = await api("/api/admin/participants", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { participant_id: id },
  });
  expect(result.response.status).toBe(201);
  const created = result.json;
  if (visitType === "pre") return created;
  await env.DB.prepare(`
    UPDATE visits SET status = 'completed', finalized_at_ms = ?, updated_at_ms = ?
    WHERE visit_uuid = ?
  `).bind(Date.now(), Date.now(), created.participant.pre_visit_id).run();
  const issued = await api(`/api/admin/visits/${created.participant.immediate_visit_id}/invitations`, {
    method: "POST",
    token: ADMIN_TOKEN,
    body: {},
  });
  expect(issued.response.status).toBe(201);
  return { ...created, invitation: issued.json.invitation };
}

function tokenFromInvitation(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("t");
}

function validLearningPayload() {
  return {
    task: "learning",
    client_response_saved_perf_ms: 5_400,
    visual_mode: "image",
    visual_onset_perf_ms: 300,
    visual_onset_context_s: 1,
    clock_anchor: {
      context_time_s: 1,
      performance_time_ms: 300,
      performance_time_origin_ms: 1_000,
    },
    target_onset_perf_ms: 300,
    onset_late_ms: 0,
    visual_deadline_perf_ms: 5_300,
    visual_hidden_perf_ms: 5_301,
    audio_scheduled_context_s: 1.75,
    audio_scheduled_end_context_s: 2.6,
    audio_duration_s: 0.85,
    audio_ended_perf_ms: 1_200,
    trial_end_perf_ms: 5_301,
    visibility_interrupted: false,
    page_visibility_at_end: "visible",
  };
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

function validL2Payload() {
  return {
    task: "l2_to_l1",
    client_response_saved_perf_ms: 11_860,
    clock_anchor: {
      context_time_s: 1,
      performance_time_ms: 1_000,
      performance_time_origin_ms: 1_000,
    },
    target_onset_perf_ms: 1_000,
    onset_late_ms: 0,
    audio_scheduled_context_s: 1,
    audio_scheduled_end_context_s: 1.85,
    audio_duration_s: 0.85,
    audio_ended_perf_ms: 1_850,
    audio_ended_context_s: 1.85,
    response_deadline_context_s: 11.85,
    response_deadline_perf_ms: 11_850,
    scheduled_audio_onset_perf_ms: 1_000,
    response_window_after_audio_ms: 10_000,
    duration_seconds: 11,
    capture_start_context_s: 0.85,
    capture_stop_context_s: 11.85,
    capture_stop_command_perf_ms: 11_840,
    capture_stopped_perf_ms: 11_850,
    scheduled_stop_context_s: 11.85,
    sample_rate_hz: 48_000,
    sample_count: 528_000,
    expected_sample_count: 528_000,
    sample_count_difference: 0,
    missing_input_frames: 0,
    visibility_interrupted: false,
    measured_pre_audio_ms: 150,
    microphone_settings: {
      sample_rate: 48_000,
      channel_count: 1,
      echo_cancellation: false,
      noise_suppression: false,
      auto_gain_control: false,
    },
    quality: {
      analysis_start_seconds: 1,
      analyzed_sample_count: 480_000,
      rms_amplitude: 0,
      peak_amplitude: 0,
      clipping_ratio: 0,
    },
  };
}

function silenceWav(sampleRate = 48_000, sampleCount = 480_000) {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
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

describe("Worker API", () => {
  it("creates an immutable pre manifest with no L2-to-L1 and a separate pre invitation", async () => {
    const created = await createParticipant(1, "pre");
    expect(created.participant.participant_id).toBe(1);
    expect(created.participant).toMatchObject({
      training_accent: "english",
      counterbalance_cell: 1,
    });
    const existingParticipant = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: 1, issue_pre_invitation: false },
    });
    expect(existingParticipant.response.status).toBe(200);
    expect(existingParticipant.json.participant).toMatchObject({
      training_accent: "english",
      counterbalance_cell: 1,
    });
    expect(created.invitation.invitation_url).toContain("/pre-picture-naming/#t=");
    const inviteToken = tokenFromInvitation(created.invitation.invitation_url);
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: inviteToken,
        client_instance_id: "11111111-1111-4111-8111-111111111111",
        expected_visit_type: "pre",
      },
    });
    expect(redeemed.response.status).toBe(200);
    expect(redeemed.json.visit.visit_type).toBe("pre");
    expect(redeemed.json.manifest).toHaveLength(26);
    expect(redeemed.json.manifest.filter((trial) => trial.segment === "learning")).toHaveLength(0);
    expect(redeemed.json.manifest.filter((trial) => trial.segment === "l2_to_l1")).toHaveLength(0);
    expect(redeemed.json.next_route).toBe("/pre-picture-naming/");
    expect(redeemed.json.manifest.some((trial) => trial.segment === "picture_matching")).toBe(false);
    expect(redeemed.json.session_token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(redeemed.json.manifest[0]).not.toHaveProperty("item");
    expect(redeemed.json.manifest[0].protocol).toEqual({
      timing: { responseWindowMs: 10000, interTrialMs: 650 },
    });

    const futureStimulus = await api(redeemed.json.manifest[1].image_endpoint, {
      token: redeemed.json.session_token,
    });
    expect(futureStimulus.response.status).toBe(409);
    expect(futureStimulus.json.error.code).toBe("stimulus_not_current");
    const currentPlaceholderImage = await api(redeemed.json.manifest[0].image_endpoint, {
      token: redeemed.json.session_token,
    });
    expect(currentPlaceholderImage.response.status).toBe(200);
    expect(currentPlaceholderImage.response.headers.get("Content-Type")).toContain("image/svg+xml");

    const storedSeeds = await env.DB.prepare(`SELECT root_seed_hex FROM participants WHERE numeric_id = 1`).first();
    expect(storedSeeds.root_seed_hex).toMatch(/^[0-9a-f]{64}$/u);
    const manifestRows = await env.DB.prepare(`SELECT COUNT(*) AS count FROM trial_manifest`).first();
    expect(Number(manifestRows.count)).toBe(276);
    const prematureMain = await api(`/api/admin/visits/${created.participant.immediate_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(prematureMain.response.status).toBe(409);
    expect(prematureMain.json.error.code).toBe("pre_not_completed");
  });

  it("rejects an invitation on the wrong visit URL and another participant's stimulus", async () => {
    const first = await createParticipant(101, "pre");
    const second = await createParticipant(102, "pre");
    const firstToken = tokenFromInvitation(first.invitation.invitation_url);

    const wrongRoute = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: firstToken,
        client_instance_id: "10110110-1101-4101-8101-101101101101",
        expected_visit_type: "immediate",
      },
    });
    expect(wrongRoute.response.status).toBe(409);
    expect(wrongRoute.json.error.code).toBe("wrong_visit_route");

    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: firstToken,
        client_instance_id: "10110110-1101-4101-8101-101101101102",
        expected_visit_type: "pre",
      },
    });
    expect(redeemed.response.status).toBe(200);

    const otherTrial = await env.DB.prepare(`
      SELECT trial_uuid FROM trial_manifest
      WHERE visit_uuid = ? ORDER BY ordinal LIMIT 1
    `).bind(second.participant.pre_visit_id).first();
    const crossParticipant = await api(`/api/stimuli/${otherTrial.trial_uuid}/image`, {
      token: redeemed.json.session_token,
    });
    expect(crossParticipant.response.status).toBe(409);
    expect(crossParticipant.json.error.code).toBe("stimulus_not_current");

    const currentTrial = redeemed.json.manifest.find((trial) => trial.current);
    const sensitiveKey = "stimuli/real/images/secret-target-word.webp";
    await env.DB.prepare(`
      UPDATE trial_manifest SET placeholder_asset = 0, image_key = ?
      WHERE trial_uuid = ?
    `).bind(sensitiveKey, currentTrial.trial_id).run();
    const missingAsset = await api(`/api/trials/${currentTrial.trial_id}/start`, {
      method: "POST",
      token: redeemed.json.session_token,
      body: {
        start_key: "10110110-1101-4101-8101-101101101103",
        client_started_perf_ms: 1,
      },
    });
    expect(missingAsset.response.status).toBe(503);
    expect(missingAsset.json.error.code).toBe("stimulus_asset_missing");
    expect(missingAsset.json.error.details).toBeNull();
    expect(JSON.stringify(missingAsset.json)).not.toContain(sensitiveKey);
  });

  it("makes trial start and response idempotent and rejects a conflicting retry", async () => {
    const created = await createParticipant(2);
    const inviteToken = tokenFromInvitation(created.invitation.invitation_url);
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: inviteToken,
        client_instance_id: "22222222-2222-4222-8222-222222222222",
        expected_visit_type: "immediate",
      },
    });
    const sessionToken = redeemed.json.session_token;
    const trial = redeemed.json.manifest[0];
    const startKey = "33333333-3333-4333-8333-333333333333";
    const firstStart = await api(`/api/trials/${trial.trial_id}/start`, {
      method: "POST",
      token: sessionToken,
      body: { start_key: startKey, client_started_perf_ms: 10 },
    });
    expect(firstStart.response.status).toBe(201);
    const oneAhead = await api(redeemed.json.manifest[1].audio_endpoint, { token: sessionToken });
    expect(oneAhead.response.status).toBe(200);
    const twoAhead = await api(redeemed.json.manifest[2].audio_endpoint, { token: sessionToken });
    expect(twoAhead.response.status).toBe(409);
    const duplicateStart = await api(`/api/trials/${trial.trial_id}/start`, {
      method: "POST",
      token: sessionToken,
      body: { start_key: startKey, client_started_perf_ms: 10 },
    });
    expect(duplicateStart.response.status).toBe(200);
    expect(duplicateStart.json.attempt_id).toBe(firstStart.json.attempt_id);

    const eventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const event = await api("/api/events", {
      method: "POST",
      token: sessionToken,
      body: {
        events: [{
          event_id: eventId,
          type: "learning_visual_onset",
          trial_id: trial.trial_id,
          attempt_id: firstStart.json.attempt_id,
          client_event_at_ms: 20,
          payload: { visible: true },
        }],
      },
    });
    expect(event.response.status).toBe(200);
    const conflictingEvent = await api("/api/events", {
      method: "POST",
      token: sessionToken,
      body: {
        events: [{
          event_id: eventId,
          type: "learning_visual_onset",
          trial_id: trial.trial_id,
          attempt_id: firstStart.json.attempt_id,
          client_event_at_ms: 20,
          payload: { visible: false },
        }],
      },
    });
    expect(conflictingEvent.response.status).toBe(409);
    expect(conflictingEvent.json.error.code).toBe("event_idempotency_conflict");

    await env.DB.prepare(`
      UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 6000
      WHERE attempt_uuid = ?
    `).bind(firstStart.json.attempt_id).run();

    const invalidPayload = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: sessionToken,
      body: {
        attempt_id: firstStart.json.attempt_id,
        response_key: "77777777-7777-4777-8777-777777777777",
        payload: { ...validLearningPayload(), visual_onset_perf_ms: null },
      },
    });
    expect(invalidPayload.response.status).toBe(422);
    expect(invalidPayload.json.error.code).toBe("invalid_response_payload");

    const responseKey = "44444444-4444-4444-8444-444444444444";
    const payload = validLearningPayload();
    const firstResponse = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: sessionToken,
      body: { attempt_id: firstStart.json.attempt_id, response_key: responseKey, payload },
    });
    expect(firstResponse.response.status).toBe(200);
    const duplicateResponse = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: sessionToken,
      body: { attempt_id: firstStart.json.attempt_id, response_key: responseKey, payload },
    });
    expect(duplicateResponse.response.status).toBe(200);
    expect(duplicateResponse.json.duplicate).toBe(true);
    const conflicting = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: sessionToken,
      body: {
        attempt_id: firstStart.json.attempt_id,
        response_key: responseKey,
        payload: { ...payload, visual_onset_perf_ms: 999 },
      },
    });
    expect(conflicting.response.status).toBe(409);
    expect(conflicting.json.error.code).toBe("idempotency_conflict");
    const attempts = await env.DB.prepare(`SELECT COUNT(*) AS count FROM trial_attempts`).first();
    expect(Number(attempts.count)).toBe(1);
  });

  it("supersedes the old tab when the same invitation is redeemed again", async () => {
    const created = await createParticipant(3);
    const inviteToken = tokenFromInvitation(created.invitation.invitation_url);
    const first = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: inviteToken,
        client_instance_id: "55555555-5555-4555-8555-555555555555",
        expected_visit_type: "immediate",
      },
    });
    const second = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: inviteToken,
        client_instance_id: "66666666-6666-4666-8666-666666666666",
        expected_visit_type: "immediate",
      },
    });
    expect(Number(second.json.session.epoch)).toBe(Number(first.json.session.epoch) + 1);
    const oldHeartbeat = await api("/api/session/heartbeat", { method: "POST", token: first.json.session_token, body: {} });
    expect(oldHeartbeat.response.status).toBe(409);
    expect(oldHeartbeat.json.error.code).toBe("session_superseded");
    const newHeartbeat = await api("/api/session/heartbeat", { method: "POST", token: second.json.session_token, body: {} });
    expect(newHeartbeat.response.status).toBe(200);
  });

  it("does not issue the delayed invitation before immediate completion plus seven days", async () => {
    const created = await createParticipant(4);
    const delayedIssue = await api(`/api/admin/visits/${created.participant.delayed_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(delayedIssue.response.status).toBe(409);
    expect(delayedIssue.json.error.code).toBe("immediate_not_completed");

    const futureTarget = Date.now() + 7 * 86_400_000;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET status = 'completed', behavioral_completed_at_ms = ?, finalized_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(Date.now(), Date.now(), created.participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE visits SET status = 'scheduled', target_at_ms = ?, available_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(futureTarget, futureTarget, created.participant.delayed_visit_id),
    ]);
    const tooEarly = await api(`/api/admin/visits/${created.participant.delayed_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(tooEarly.response.status).toBe(409);
    expect(tooEarly.json.error.code).toBe("delayed_not_available");
  });

  it("flags a durable-start replay and rejects non-WAV recording bytes", async () => {
    const created = await createParticipant(5);
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = 0 WHERE visit_uuid = ?
    `).bind(created.participant.immediate_visit_id).run();
    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = 0, target_at_ms = 0
      WHERE visit_uuid = ?
    `).bind(created.participant.delayed_visit_id).run();
    const issued = await api(`/api/admin/visits/${created.participant.delayed_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    expect(issued.response.status).toBe(201);
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: tokenFromInvitation(issued.json.invitation.invitation_url),
        client_instance_id: "88888888-8888-4888-8888-888888888888",
        expected_visit_type: "delayed",
      },
    });
    const trial = redeemed.json.manifest[0];
    const startKey = "99999999-9999-4999-8999-999999999999";
    const started = await api(`/api/trials/${trial.trial_id}/start`, {
      method: "POST",
      token: redeemed.json.session_token,
      body: { start_key: startKey, client_started_perf_ms: 1, resume_after_stimulus: false },
    });
    const replay = await api(`/api/trials/${trial.trial_id}/start`, {
      method: "POST",
      token: redeemed.json.session_token,
      body: { start_key: startKey, client_started_perf_ms: 1, resume_after_stimulus: true },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.json.repeated_after_interruption).toBe(true);
    await env.DB.prepare(`
      UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 10000
      WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).run();
    const saved = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: redeemed.json.session_token,
      body: {
        attempt_id: started.json.attempt_id,
        response_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        payload: validPictureNamingPayload(),
      },
    });
    expect(saved.response.status).toBe(200);

    const invalidBytes = new Uint8Array(64);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", invalidBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const invalidWavResponse = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${redeemed.json.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(invalidBytes.byteLength),
          "X-Content-SHA256": digest,
        },
        body: invalidBytes,
      },
    ));
    expect(invalidWavResponse.status).toBe(422);
    expect((await invalidWavResponse.json()).error.code).toBe("invalid_wav");

    const mismatchedBytes = silenceWav(44_100, 441_000);
    const mismatchedDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", mismatchedBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const mismatchedWavResponse = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${redeemed.json.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(mismatchedBytes.byteLength),
          "X-Content-SHA256": mismatchedDigest,
        },
        body: mismatchedBytes,
      },
    ));
    expect(mismatchedWavResponse.status).toBe(422);
    expect((await mismatchedWavResponse.json()).error.code).toBe("recording_payload_mismatch");

    const validBytes = silenceWav();
    const inconsistentQualityBytes = validBytes.slice();
    new DataView(
      inconsistentQualityBytes.buffer,
      inconsistentQualityBytes.byteOffset,
      inconsistentQualityBytes.byteLength,
    ).setInt16(44, 16_384, true);
    const inconsistentQualityDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", inconsistentQualityBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const inconsistentQualityResponse = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${redeemed.json.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(inconsistentQualityBytes.byteLength),
          "X-Content-SHA256": inconsistentQualityDigest,
        },
        body: inconsistentQualityBytes,
      },
    ));
    expect(inconsistentQualityResponse.status).toBe(422);
    expect((await inconsistentQualityResponse.json()).error.code).toBe("recording_quality_mismatch");

    const validDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", validBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const validWavResponse = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${redeemed.json.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(validBytes.byteLength),
          "X-Content-SHA256": validDigest,
        },
        body: validBytes,
      },
    ));
    expect(validWavResponse.status).toBe(200);
    expect((await validWavResponse.clone().json()).quality).toEqual({
      analysis_start_seconds: 0,
      analyzed_sample_count: 480_000,
      rms_amplitude: 0,
      peak_amplitude: 0,
      clipping_ratio: 0,
    });
    const duplicateWavResponse = await exports.default.fetch(new Request(
      `${ORIGIN}/api/recordings/${started.json.attempt_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${redeemed.json.session_token}`,
          "Content-Type": "audio/wav",
          "Content-Length": String(validBytes.byteLength),
          "X-Content-SHA256": validDigest,
        },
        body: validBytes,
      },
    ));
    expect(duplicateWavResponse.status).toBe(200);
    expect((await duplicateWavResponse.json()).duplicate).toBe(true);
    const recordingRow = await env.DB.prepare(`
      SELECT state, sample_rate_hz, sample_count, duration_seconds,
             analysis_start_seconds, analyzed_sample_count,
             rms_amplitude, peak_amplitude, clipping_ratio
      FROM recordings WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).first();
    expect(recordingRow).toMatchObject({
      state: "uploaded",
      sample_rate_hz: 48_000,
      sample_count: 480_000,
      duration_seconds: 10,
      analysis_start_seconds: 0,
      analyzed_sample_count: 480_000,
      rms_amplitude: 0,
      peak_amplitude: 0,
      clipping_ratio: 0,
    });
  });

  it("strictly validates an L2-to-L1 response payload", async () => {
    const created = await createParticipant(7);
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = 0 WHERE visit_uuid = ?
    `).bind(created.participant.immediate_visit_id).run();
    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = 0, target_at_ms = 0
      WHERE visit_uuid = ?
    `).bind(created.participant.delayed_visit_id).run();
    const issued = await api(`/api/admin/visits/${created.participant.delayed_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: tokenFromInvitation(issued.json.invitation.invitation_url),
        client_instance_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        expected_visit_type: "delayed",
      },
    });
    await env.DB.prepare(`
      UPDATE trial_manifest
      SET canonical_attempt_uuid = 'test-skip-picture-naming', expects_recording = 0
      WHERE visit_uuid = ? AND segment = 'picture_naming'
    `).bind(created.participant.delayed_visit_id).run();
    const trial = redeemed.json.manifest.find((candidate) => candidate.segment === "l2_to_l1");
    const started = await api(`/api/trials/${trial.trial_id}/start`, {
      method: "POST",
      token: redeemed.json.session_token,
      body: {
        start_key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        client_started_perf_ms: 1,
      },
    });
    expect(started.response.status).toBe(201);
    await env.DB.prepare(`
      UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 12000
      WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).run();

    const malformed = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: redeemed.json.session_token,
      body: {
        attempt_id: started.json.attempt_id,
        response_key: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        payload: { ...validL2Payload(), response_deadline_context_s: 11.5 },
      },
    });
    expect(malformed.response.status).toBe(422);
    expect(malformed.json.error.code).toBe("invalid_response_timing");

    const accepted = await api(`/api/trials/${trial.trial_id}/response`, {
      method: "PUT",
      token: redeemed.json.session_token,
      body: {
        attempt_id: started.json.attempt_id,
        response_key: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        payload: validL2Payload(),
      },
    });
    expect(accepted.response.status).toBe(200);
    expect(accepted.json.expects_recording).toBe(true);
  });

  it("returns the recorded completion result when a closed session retries", async () => {
    const created = await createParticipant(6);
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: tokenFromInvitation(created.invitation.invitation_url),
        client_instance_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expected_visit_type: "immediate",
      },
    });
    const finalizedAt = Date.now() - 100;
    await env.DB.batch([
      env.DB.prepare(`UPDATE visits SET status = 'completed', finalized_at_ms = ? WHERE visit_uuid = ?`)
        .bind(finalizedAt, created.participant.immediate_visit_id),
      env.DB.prepare(`UPDATE sessions SET status = 'closed', closed_at_ms = ? WHERE session_uuid = ?`)
        .bind(finalizedAt, redeemed.json.session.session_id),
    ]);
    const retried = await api("/api/visit/complete", {
      method: "POST",
      token: redeemed.json.session_token,
      body: {},
    });
    expect(retried.response.status).toBe(200);
    expect(retried.json.duplicate).toBe(true);
    expect(retried.json.finalized_at_ms).toBe(finalizedAt);
    const completedState = await api("/api/session", { token: redeemed.json.session_token });
    expect(completedState.response.status).toBe(200);
    expect(completedState.json.visit.status).toBe("completed");
  });

  it("rejects ambiguous participant IDs as a client error", async () => {
    const result = await api("/api/admin/participants", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { participant_id: "001" },
    });
    expect(result.response.status).toBe(400);
  });

  it("builds an immutable private ZIP after every recording in a phase is ready", async () => {
    const created = await createParticipant(8, "pre");
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: tokenFromInvitation(created.invitation.invitation_url),
        client_instance_id: "12345678-1234-4234-8234-123456789abc",
        expected_visit_type: "pre",
      },
    });
    const trialResult = await env.DB.prepare(`
      SELECT trial_uuid, segment_ordinal FROM trial_manifest
      WHERE visit_uuid = ? AND segment = 'picture_naming'
      ORDER BY segment_ordinal
    `).bind(created.participant.pre_visit_id).all();
    const statements = [];
    for (const [index, trial] of trialResult.results.entries()) {
      const attemptUuid = crypto.randomUUID();
      const bytes = new Uint8Array([82, 73, 70, 70, index]);
      const sha256 = await sha256Hex(bytes);
      const r2Key = `recordings/export-test/${attemptUuid}.wav`;
      const object = await env.RECORDINGS.put(r2Key, bytes, {
        httpMetadata: { contentType: "audio/wav" },
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
          redeemed.json.session.session_id,
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
    `).bind(Date.now(), created.participant.pre_visit_id));
    await env.DB.batch(statements);

    const scheduled = await ensureRecordingExportQueued(
      env,
      created.participant.pre_visit_id,
      "picture_naming",
    );
    expect(scheduled.ready).toBe(true);
    await processRecordingExport(env, scheduled.export_uuid);
    const exportRow = await env.DB.prepare(`
      SELECT * FROM recording_exports WHERE export_uuid = ? LIMIT 1
    `).bind(scheduled.export_uuid).first();
    expect(exportRow).toMatchObject({
      state: "ready",
      phase_code: "pre_picture_naming",
      member_count: 26,
    });
    expect(Number(exportRow.zip_byte_count)).toBeGreaterThan(Number(exportRow.source_total_bytes));

    const forbidden = await api(
      `/api/admin/visits/${created.participant.pre_visit_id}/recordings/picture_naming.zip`,
    );
    expect(forbidden.response.status).toBe(401);
    const downloaded = await exports.default.fetch(new Request(
      `${ORIGIN}/api/admin/visits/${created.participant.pre_visit_id}/recordings/picture_naming.zip`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    ));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("Content-Type")).toBe("application/zip");
    expect((await downloaded.arrayBuffer()).byteLength).toBe(Number(exportRow.zip_byte_count));
    const audit = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM recording_export_downloads WHERE export_uuid = ?
    `).bind(scheduled.export_uuid).first();
    expect(Number(audit.count)).toBe(1);
  });

  it("serves six canonical task URLs", async () => {
    const pages = new Map([
      ["/main-experiment/", 'data-visit-type="immediate" data-segment="learning"'],
      ["/pre-picture-naming/", 'data-visit-type="pre" data-segment="picture_naming"'],
      ["/immediate-picture-naming/", 'data-visit-type="immediate" data-segment="picture_naming"'],
      ["/immediate-l2-to-l1/", 'data-visit-type="immediate" data-segment="l2_to_l1"'],
      ["/delayed-picture-naming/", 'data-visit-type="delayed" data-segment="picture_naming"'],
      ["/delayed-l2-to-l1/", 'data-visit-type="delayed" data-segment="l2_to_l1"'],
    ]);
    for (const [path, expectedConfiguration] of pages) {
      const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`));
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain("/js/task-page.js");
      expect(html, path).toContain(expectedConfiguration);
    }
  });

  it("does not preload a stimulus across a Picture Naming to L2-to-L1 boundary", async () => {
    const created = await createParticipant(9);
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = 0 WHERE visit_uuid = ?
    `).bind(created.participant.immediate_visit_id).run();
    await env.DB.prepare(`
      UPDATE visits SET available_at_ms = 0, target_at_ms = 0 WHERE visit_uuid = ?
    `).bind(created.participant.delayed_visit_id).run();
    const issued = await api(`/api/admin/visits/${created.participant.delayed_visit_id}/invitations`, {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    });
    const redeemed = await api("/api/invitations/redeem", {
      method: "POST",
      body: {
        token: tokenFromInvitation(issued.json.invitation.invitation_url),
        client_instance_id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
        expected_visit_type: "delayed",
      },
    });
    const pictureTrials = redeemed.json.manifest.filter((trial) => trial.segment === "picture_naming");
    const lastPicture = pictureTrials.at(-1);
    await env.DB.prepare(`
      UPDATE trial_manifest SET canonical_attempt_uuid = 'test-skip-prior-picture-trials'
      WHERE visit_uuid = ? AND segment = 'picture_naming' AND segment_ordinal < ?
    `).bind(created.participant.delayed_visit_id, lastPicture.segment_ordinal).run();
    const started = await api(`/api/trials/${lastPicture.trial_id}/start`, {
      method: "POST",
      token: redeemed.json.session_token,
      body: { start_key: crypto.randomUUID(), client_started_perf_ms: 1 },
    });
    expect(started.response.status).toBe(201);
    const firstL2 = redeemed.json.manifest.find((trial) => trial.segment === "l2_to_l1");
    const preload = await api(firstL2.audio_endpoint, { token: redeemed.json.session_token });
    expect(preload.response.status).toBe(409);
    expect(preload.json.error.code).toBe("stimulus_not_current");
  });
});
