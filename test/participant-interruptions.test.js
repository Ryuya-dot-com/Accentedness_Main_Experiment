import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

async function api(path, {
  method = "GET",
  token = null,
  body = null,
} = {}) {
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

async function adminApi(path, options = {}) {
  return api(path, { ...options, token: ADMIN_TOKEN });
}

async function createParticipant(participantId) {
  const started = await startVisit("pre", participantId);
  expect(started.response.status).toBe(200);
  const rows = await env.DB.prepare(`
    SELECT p.participant_uuid, v.visit_uuid, v.visit_type
    FROM participants p JOIN visits v ON v.participant_uuid = p.participant_uuid
    WHERE p.numeric_id = ?
  `).bind(participantId).all();
  const participant = {
    participant_id: participantId,
    participant_uuid: rows.results[0].participant_uuid,
  };
  for (const visit of rows.results) participant[`${visit.visit_type}_visit_id`] = visit.visit_uuid;
  return { participant, start: started };
}

async function startVisit(expectedVisitType, participantId) {
  return api("/api/participant-access/start", {
    method: "POST",
    body: {
      participant_id: participantId,
      participant_id_confirmed: true,
      client_instance_id: crypto.randomUUID(),
      expected_visit_type: expectedVisitType,
    },
  });
}

async function startTrial(sessionToken, trialId, resumeAfterStimulus = false) {
  return api(`/api/trials/${trialId}/start`, {
    method: "POST",
    token: sessionToken,
    body: {
      start_key: crypto.randomUUID(),
      client_started_perf_ms: 1,
      resume_after_stimulus: resumeAfterStimulus,
    },
  });
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

function silenceWav(sampleRate = 48_000, sampleCount = 480_000) {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function savePictureNamingResponse(sessionToken, trialId, attemptId) {
  await env.DB.prepare(`
    UPDATE trial_attempts SET server_started_at_ms = server_started_at_ms - 12000
    WHERE attempt_uuid = ?
  `).bind(attemptId).run();
  return api(`/api/trials/${trialId}/response`, {
    method: "PUT",
    token: sessionToken,
    body: {
      attempt_id: attemptId,
      response_key: crypto.randomUUID(),
      payload: validPictureNamingPayload(),
    },
  });
}

async function uploadSilenceRecording(sessionToken, attemptId) {
  const bytes = silenceWav();
  const digest = await sha256Hex(bytes);
  const response = await exports.default.fetch(new Request(
    `${ORIGIN}/api/recordings/${attemptId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.byteLength),
        "X-Content-SHA256": digest,
      },
      body: bytes,
    },
  ));
  const json = await response.json();
  return { response, json, bytes, digest };
}

async function completeLeadingNonRecordingPractice(redemption) {
  const firstRecordedTrial = redemption.json.manifest.find(
    (trial) => trial.expects_recording,
  );
  const leadingPractice = redemption.json.manifest.filter(
    (trial) => trial.ordinal < firstRecordedTrial.ordinal,
  );
  expect(leadingPractice.length).toBeGreaterThan(0);
  expect(leadingPractice.every((trial) => (
    trial.practice
    && trial.segment === "picture_naming"
    && trial.expects_recording === false
  ))).toBe(true);

  for (const trial of leadingPractice) {
    const started = await startTrial(redemption.json.session_token, trial.trial_id);
    expect(started.response.status).toBe(201);
    const saved = await savePictureNamingResponse(
      redemption.json.session_token,
      trial.trial_id,
      started.json.attempt_id,
    );
    expect(saved.response.status).toBe(200);
    expect(saved.json.expects_recording).toBe(false);
    const recordingCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM recordings WHERE attempt_uuid = ?
    `).bind(started.json.attempt_id).first();
    expect(Number(recordingCount.count)).toBe(0);
  }

  return {
    firstRecordedTrial,
    secondRecordedTrial: redemption.json.manifest.find(
      (trial) => trial.ordinal === firstRecordedTrial.ordinal + 1,
    ),
  };
}

async function requestInterruption(sessionToken, mode, requestId = crypto.randomUUID()) {
  return api("/api/participation/interruptions", {
    method: "POST",
    token: sessionToken,
    body: { request_id: requestId, mode },
  });
}

async function finalizeInterruption(sessionToken, interruptionId, requestId) {
  return api(`/api/participation/interruptions/${interruptionId}/finalize`, {
    method: "POST",
    token: sessionToken,
    body: { request_id: requestId },
  });
}

function expectApiError(result, status, code) {
  expect(result.response.status).toBe(status);
  expect(result.json.error.code).toBe(code);
}

function groupedCount(rows, expected) {
  const row = rows.find((candidate) => Object.entries(expected).every(
    ([key, value]) => candidate[key] === value,
  ));
  return Number(row?.count ?? 0);
}

function integrityCount(summary, key) {
  return Number(summary.recording_integrity[key] ?? 0);
}

function assignmentFlowTotal(summary, key) {
  return summary.assignment_flow.reduce(
    (total, row) => total + Number(row[key] ?? 0),
    0,
  );
}

describe("participant interruption lifecycle", () => {
  it("pauses idempotently, drains the started trial, and resumes the exact canonical position", async () => {
    const baseline = (await adminApi("/api/admin/summary")).json;
    const participantId = 930_001;
    const created = await createParticipant(participantId);
    const firstRedemption = created.start;
    const {
      firstRecordedTrial: firstTrial,
      secondRecordedTrial: secondTrial,
    } = await completeLeadingNonRecordingPractice(firstRedemption);
    expect(firstTrial).toMatchObject({ practice: false, expects_recording: true });

    const firstStart = await startTrial(
      firstRedemption.json.session_token,
      firstTrial.trial_id,
    );
    expect(firstStart.response.status).toBe(201);

    const requestId = crypto.randomUUID();
    const requested = await requestInterruption(
      firstRedemption.json.session_token,
      "pause",
      requestId,
    );
    expect(requested.response.status).toBe(202);
    expect(requested.json).toMatchObject({ duplicate: false });
    expect(requested.json.interruption).toMatchObject({
      request_id: requestId,
      mode: "pause",
      state: "requested",
      accepted_trial_count: firstTrial.ordinal - 1,
      next_ordinal: firstTrial.ordinal,
    });

    const duplicatedRequest = await requestInterruption(
      firstRedemption.json.session_token,
      "pause",
      requestId,
    );
    expect(duplicatedRequest.response.status).toBe(200);
    expect(duplicatedRequest.json).toMatchObject({
      duplicate: true,
      interruption: {
        interruption_id: requested.json.interruption.interruption_id,
        request_id: requestId,
        mode: "pause",
        state: "requested",
        accepted_trial_count: firstTrial.ordinal - 1,
        next_ordinal: firstTrial.ordinal,
      },
    });

    const blockedNextStart = await startTrial(
      firstRedemption.json.session_token,
      secondTrial.trial_id,
    );
    expectApiError(
      blockedNextStart,
      409,
      "trial_start_blocked_by_participation_interruption",
    );

    const saved = await savePictureNamingResponse(
      firstRedemption.json.session_token,
      firstTrial.trial_id,
      firstStart.json.attempt_id,
    );
    expect(saved.response.status).toBe(200);
    expect(saved.json).toMatchObject({
      attempt_id: firstStart.json.attempt_id,
      expects_recording: true,
      behavioral_completed: false,
    });

    const pendingSummary = await adminApi("/api/admin/summary");
    expect(pendingSummary.response.status).toBe(200);
    expect(
      integrityCount(pendingSummary.json, "canonical_pending_uploads")
        - integrityCount(baseline, "canonical_pending_uploads"),
    ).toBe(1);
    expect(
      integrityCount(pendingSummary.json, "noncanonical_abandoned_slots")
        - integrityCount(baseline, "noncanonical_abandoned_slots"),
    ).toBe(0);

    const prematurePause = await finalizeInterruption(
      firstRedemption.json.session_token,
      requested.json.interruption.interruption_id,
      requestId,
    );
    expectApiError(
      prematurePause,
      409,
      "participation_pause_recordings_pending",
    );
    expect(prematurePause.json.error.details).toEqual({ pending_recordings: 1 });
    expect(await env.DB.prepare(`
      SELECT pi.state AS interruption_state, s.status AS session_status
      FROM participation_interruptions pi
      JOIN sessions s ON s.session_uuid = ?
      WHERE pi.interruption_uuid = ?
    `).bind(
      firstRedemption.json.session.session_id,
      requested.json.interruption.interruption_id,
    ).first()).toEqual({
      interruption_state: "requested",
      session_status: "active",
    });

    const uploaded = await uploadSilenceRecording(
      firstRedemption.json.session_token,
      firstStart.json.attempt_id,
    );
    expect(uploaded.response.status).toBe(200);
    expect(uploaded.json).toMatchObject({
      duplicate: false,
      attempt_id: firstStart.json.attempt_id,
      sha256: uploaded.digest,
    });

    const finalized = await finalizeInterruption(
      firstRedemption.json.session_token,
      requested.json.interruption.interruption_id,
      requestId,
    );
    expect(finalized.response.status).toBe(200);
    expect(finalized.json).toMatchObject({
      duplicate: false,
      partial_data_preserved: true,
      interruption: { mode: "pause", state: "paused" },
    });
    expect(finalized.json.interruption.finalized_at_ms).not.toBeNull();

    const pausedVisit = await env.DB.prepare(`
      SELECT status, behavioral_completed_at_ms, finalized_at_ms,
             picture_naming_completed_at_ms, withdrawn_at_ms
      FROM visits WHERE visit_uuid = ?
    `).bind(created.participant.pre_visit_id).first();
    expect(pausedVisit).toEqual({
      status: "started",
      behavioral_completed_at_ms: null,
      finalized_at_ms: null,
      picture_naming_completed_at_ms: null,
      withdrawn_at_ms: null,
    });
    const pausedSession = await env.DB.prepare(`
      SELECT status, closed_at_ms FROM sessions WHERE session_uuid = ?
    `).bind(firstRedemption.json.session.session_id).first();
    expect(pausedSession.status).toBe("closed");
    expect(pausedSession.closed_at_ms).not.toBeNull();
    const participantAfterPause = await env.DB.prepare(`
      SELECT status, withdrawn_at_ms FROM participants WHERE participant_uuid = ?
    `).bind(created.participant.participant_uuid).first();
    expect(participantAfterPause).toEqual({ status: "active", withdrawn_at_ms: null });
    const resumed = await startVisit("pre", participantId);
    expect(resumed.json.next_trial_id).toBe(secondTrial.trial_id);
    expect(resumed.json.manifest.find((trial) => trial.current)).toMatchObject({
      trial_id: secondTrial.trial_id,
      ordinal: secondTrial.ordinal,
    });
    expect(resumed.json.accepted).toHaveLength(firstTrial.ordinal);
    expect(resumed.json.accepted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trial_id: firstTrial.trial_id,
        ordinal: firstTrial.ordinal,
        attempt_id: firstStart.json.attempt_id,
        recording_state: "uploaded",
      }),
    ]));
    const resumedInterruption = await env.DB.prepare(`
      SELECT state, resumed_at_ms FROM participation_interruptions
      WHERE interruption_uuid = ?
    `).bind(requested.json.interruption.interruption_id).first();
    expect(resumedInterruption.state).toBe("resumed");
    expect(resumedInterruption.resumed_at_ms).not.toBeNull();
    const escalationAfterPauseFinalized = await requestInterruption(
      resumed.json.session_token,
      "terminate",
      requestId,
    );
    expectApiError(
      escalationAfterPauseFinalized,
      409,
      "interruption_idempotency_conflict",
    );

    const unfinishedStart = await startTrial(
      resumed.json.session_token,
      secondTrial.trial_id,
    );
    expect(unfinishedStart.response.status).toBe(201);
    const secondPauseRequestId = crypto.randomUUID();
    const secondPause = await requestInterruption(
      resumed.json.session_token,
      "pause",
      secondPauseRequestId,
    );
    expect(secondPause.response.status).toBe(202);
    expect(secondPause.json.interruption).toMatchObject({
      accepted_trial_count: firstTrial.ordinal,
      next_ordinal: secondTrial.ordinal,
    });
    const secondFinalize = await finalizeInterruption(
      resumed.json.session_token,
      secondPause.json.interruption.interruption_id,
      secondPauseRequestId,
    );
    expect(secondFinalize.response.status).toBe(200);
    expect(secondFinalize.json.interruption.state).toBe("paused");

    const unfinishedBeforeResume = await env.DB.prepare(`
      SELECT state, abandoned_at_ms, abandon_reason
      FROM trial_attempts WHERE attempt_uuid = ?
    `).bind(unfinishedStart.json.attempt_id).first();
    expect(unfinishedBeforeResume).toEqual({
      state: "started",
      abandoned_at_ms: null,
      abandon_reason: null,
    });

    const resumedAgain = await startVisit("pre", participantId);
    expect(resumedAgain.json.next_trial_id).toBe(secondTrial.trial_id);
    const unfinishedAfterRedeem = await env.DB.prepare(`
      SELECT abandoned_at_ms FROM trial_attempts WHERE attempt_uuid = ?
    `).bind(unfinishedStart.json.attempt_id).first();
    expect(unfinishedAfterRedeem.abandoned_at_ms).toBeNull();

    const restarted = await startTrial(
      resumedAgain.json.session_token,
      secondTrial.trial_id,
      true,
    );
    expect(restarted.response.status).toBe(201);
    expect(restarted.json).toMatchObject({
      duplicate: false,
      attempt_no: 2,
      repeated_after_interruption: true,
    });
    expect(restarted.json.attempt_id).not.toBe(unfinishedStart.json.attempt_id);

    const attemptsAfterRestart = await env.DB.prepare(`
      SELECT attempt_uuid, attempt_no, state, repeated_after_interruption,
             abandoned_at_ms, abandon_reason
      FROM trial_attempts WHERE trial_uuid = ? ORDER BY attempt_no
    `).bind(secondTrial.trial_id).all();
    expect(attemptsAfterRestart.results).toHaveLength(2);
    expect(attemptsAfterRestart.results[0]).toMatchObject({
      attempt_uuid: unfinishedStart.json.attempt_id,
      attempt_no: 1,
      state: "started",
      abandon_reason: "superseded_on_resume",
    });
    expect(attemptsAfterRestart.results[0].abandoned_at_ms).not.toBeNull();
    expect(attemptsAfterRestart.results[1]).toMatchObject({
      attempt_uuid: restarted.json.attempt_id,
      attempt_no: 2,
      state: "started",
      repeated_after_interruption: 1,
      abandoned_at_ms: null,
      abandon_reason: null,
    });
    const recordingSlots = await env.DB.prepare(`
      SELECT attempt_uuid, state, abandoned_at_ms, abandon_reason
      FROM recordings WHERE attempt_uuid IN (?, ?) ORDER BY attempt_uuid
    `).bind(unfinishedStart.json.attempt_id, restarted.json.attempt_id).all();
    const slotsByAttempt = Object.fromEntries(
      recordingSlots.results.map((row) => [row.attempt_uuid, row]),
    );
    expect(slotsByAttempt[unfinishedStart.json.attempt_id]).toMatchObject({
      state: "pending",
      abandon_reason: "superseded_on_resume",
    });
    expect(slotsByAttempt[unfinishedStart.json.attempt_id].abandoned_at_ms).not.toBeNull();
    expect(slotsByAttempt[restarted.json.attempt_id]).toMatchObject({
      state: "pending",
      abandoned_at_ms: null,
      abandon_reason: null,
    });

    const summary = await adminApi("/api/admin/summary");
    expect(summary.response.status).toBe(200);
    expect(
      groupedCount(summary.json.participation_interruptions, {
        mode: "pause",
        state: "resumed",
      }) - groupedCount(baseline.participation_interruptions, {
        mode: "pause",
        state: "resumed",
      }),
    ).toBe(2);
    expect(
      assignmentFlowTotal(summary.json, "ever_paused_count")
        - assignmentFlowTotal(baseline, "ever_paused_count"),
    ).toBe(1);
    expect(
      assignmentFlowTotal(summary.json, "currently_paused_count")
        - assignmentFlowTotal(baseline, "currently_paused_count"),
    ).toBe(0);
    expect(
      integrityCount(summary.json, "canonical_pending_uploads")
        - integrityCount(baseline, "canonical_pending_uploads"),
    ).toBe(0);
    expect(
      integrityCount(summary.json, "noncanonical_abandoned_slots")
        - integrityCount(baseline, "noncanonical_abandoned_slots"),
    ).toBe(1);
    expect(
      integrityCount(summary.json, "canonical_recordings_abandoned_after_termination")
        - integrityCount(baseline, "canonical_recordings_abandoned_after_termination"),
    ).toBe(0);
  });

  it("re-authenticates only to finish a requested termination after the original tab is lost", async () => {
    const participantId = 930_003;
    const created = await createParticipant(participantId);
    const firstRedemption = created.start;
    const {
      firstRecordedTrial: firstTrial,
      secondRecordedTrial: secondTrial,
    } = await completeLeadingNonRecordingPractice(firstRedemption);
    const started = await startTrial(firstRedemption.json.session_token, firstTrial.trial_id);
    expect(started.response.status).toBe(201);
    const saved = await savePictureNamingResponse(
      firstRedemption.json.session_token,
      firstTrial.trial_id,
      started.json.attempt_id,
    );
    expect(saved.response.status).toBe(200);
    const unfinishedSecond = await startTrial(
      firstRedemption.json.session_token,
      secondTrial.trial_id,
    );
    expect(unfinishedSecond.response.status).toBe(201);

    const requestId = crypto.randomUUID();
    const requested = await requestInterruption(
      firstRedemption.json.session_token,
      "terminate",
      requestId,
    );
    expect(requested.response.status).toBe(202);
    expect(requested.json.interruption).toMatchObject({
      request_id: requestId,
      mode: "terminate",
      state: "requested",
      accepted_trial_count: firstTrial.ordinal,
      next_ordinal: secondTrial.ordinal,
    });

    const reopened = await startVisit("pre", participantId);
    expect(reopened.json.session.session_id).not.toBe(
      firstRedemption.json.session.session_id,
    );
    expect(reopened.json.participation_control).toMatchObject({
      trial_start_allowed: false,
      interruption: {
        interruption_id: requested.json.interruption.interruption_id,
        request_id: requestId,
        mode: "terminate",
        state: "requested",
      },
    });
    expect(reopened.json.next_trial_id).toBe(secondTrial.trial_id);

    const originAndSessions = await env.DB.prepare(`
      SELECT pi.requested_session_uuid,
             original.status AS original_status,
             reopened.status AS reopened_status
      FROM participation_interruptions pi
      JOIN sessions original ON original.session_uuid = pi.requested_session_uuid
      JOIN sessions reopened ON reopened.session_uuid = ?
      WHERE pi.interruption_uuid = ?
    `).bind(
      reopened.json.session.session_id,
      requested.json.interruption.interruption_id,
    ).first();
    expect(originAndSessions).toEqual({
      requested_session_uuid: firstRedemption.json.session.session_id,
      original_status: "superseded",
      reopened_status: "active",
    });

    const blockedStart = await startTrial(
      reopened.json.session_token,
      secondTrial.trial_id,
    );
    expectApiError(
      blockedStart,
      409,
      "trial_start_blocked_by_participation_interruption",
    );

    const uploaded = await uploadSilenceRecording(
      reopened.json.session_token,
      started.json.attempt_id,
    );
    expect(uploaded.response.status).toBe(200);
    const finalized = await finalizeInterruption(
      reopened.json.session_token,
      requested.json.interruption.interruption_id,
      requestId,
    );
    expect(finalized.response.status).toBe(200);
    expect(finalized.json.interruption).toMatchObject({
      mode: "terminate",
      state: "terminated",
    });

    const preserved = await env.DB.prepare(`
      SELECT v.status AS visit_status, v.behavioral_completed_at_ms,
             v.finalized_at_ms, r.state AS recording_state,
             r.abandoned_at_ms, r.sha256
      FROM visits v
      JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
      JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
      WHERE v.visit_uuid = ? AND tm.trial_uuid = ?
    `).bind(created.participant.pre_visit_id, firstTrial.trial_id).first();
    expect(preserved).toMatchObject({
      visit_status: "withdrawn",
      behavioral_completed_at_ms: null,
      finalized_at_ms: null,
      recording_state: "uploaded",
      abandoned_at_ms: null,
      sha256: uploaded.digest,
    });
    const abandonedOldSessionWork = await env.DB.prepare(`
      SELECT ta.state AS attempt_state, ta.abandoned_at_ms AS attempt_abandoned_at_ms,
             ta.abandon_reason AS attempt_abandon_reason,
             r.state AS recording_state, r.abandoned_at_ms AS recording_abandoned_at_ms,
             r.abandon_reason AS recording_abandon_reason
      FROM trial_attempts ta
      JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
      WHERE ta.attempt_uuid = ?
    `).bind(unfinishedSecond.json.attempt_id).first();
    expect(abandonedOldSessionWork).toMatchObject({
      attempt_state: "started",
      attempt_abandon_reason: "participant_terminated",
      recording_state: "pending",
      recording_abandon_reason: "participant_terminated",
    });
    expect(abandonedOldSessionWork.attempt_abandoned_at_ms).not.toBeNull();
    expect(abandonedOldSessionWork.recording_abandoned_at_ms).not.toBeNull();
  });

  it("keeps a requested pause closed to trials and idempotently escalates it to termination", async () => {
    const participantId = 930_004;
    const created = await createParticipant(participantId);
    const firstRedemption = created.start;
    const firstTrial = firstRedemption.json.manifest.find((trial) => trial.ordinal === 1);
    const requestId = crypto.randomUUID();
    const requestedPause = await requestInterruption(
      firstRedemption.json.session_token,
      "pause",
      requestId,
    );
    expect(requestedPause.response.status).toBe(202);
    expect(requestedPause.json.interruption).toMatchObject({
      request_id: requestId,
      mode: "pause",
      state: "requested",
      accepted_trial_count: 0,
      next_ordinal: 1,
    });

    const reopened = await startVisit("pre", participantId);
    expect(reopened.json.participation_control).toMatchObject({
      trial_start_allowed: false,
      interruption: {
        interruption_id: requestedPause.json.interruption.interruption_id,
        request_id: requestId,
        mode: "pause",
        state: "requested",
      },
    });
    const interruptionBeforeEscalation = await env.DB.prepare(`
      SELECT mode, state, requested_session_uuid, resumed_at_ms
      FROM participation_interruptions WHERE interruption_uuid = ?
    `).bind(requestedPause.json.interruption.interruption_id).first();
    expect(interruptionBeforeEscalation).toEqual({
      mode: "pause",
      state: "requested",
      requested_session_uuid: firstRedemption.json.session.session_id,
      resumed_at_ms: null,
    });
    const staleOldSessionFinalize = await env.DB.prepare(`
      UPDATE participation_interruptions
      SET state = 'paused', finalized_at_ms = ?
      WHERE interruption_uuid = ? AND request_uuid = ?
        AND mode = 'pause' AND state = 'requested'
        AND EXISTS (
          SELECT 1 FROM sessions active_session
          JOIN visits active_visit
            ON active_visit.visit_uuid = active_session.visit_uuid
          WHERE active_session.session_uuid = ?
            AND active_session.visit_uuid = participation_interruptions.visit_uuid
            AND active_session.status = 'active'
            AND active_session.epoch = active_visit.active_session_epoch
        )
    `).bind(
      Date.now(),
      requestedPause.json.interruption.interruption_id,
      requestId,
      firstRedemption.json.session.session_id,
    ).run();
    expect(Number(staleOldSessionFinalize.meta.changes ?? 0)).toBe(0);
    const staleOldSessionEscalation = await env.DB.prepare(`
      UPDATE participation_interruptions SET mode = 'terminate'
      WHERE interruption_uuid = ? AND request_uuid = ?
        AND mode = 'pause' AND state = 'requested'
        AND EXISTS (
          SELECT 1 FROM sessions active_session
          JOIN visits active_visit
            ON active_visit.visit_uuid = active_session.visit_uuid
          WHERE active_session.session_uuid = ?
            AND active_session.visit_uuid = participation_interruptions.visit_uuid
            AND active_session.status = 'active'
            AND active_session.epoch = active_visit.active_session_epoch
            AND active_visit.status NOT IN ('completed', 'withdrawn')
        )
    `).bind(
      requestedPause.json.interruption.interruption_id,
      requestId,
      firstRedemption.json.session.session_id,
    ).run();
    expect(Number(staleOldSessionEscalation.meta.changes ?? 0)).toBe(0);
    const blockedStart = await startTrial(reopened.json.session_token, firstTrial.trial_id);
    expectApiError(
      blockedStart,
      409,
      "trial_start_blocked_by_participation_interruption",
    );

    const escalated = await requestInterruption(
      reopened.json.session_token,
      "terminate",
      requestId,
    );
    expect(escalated.response.status).toBe(200);
    expect(escalated.json).toMatchObject({
      duplicate: false,
      escalated: true,
      interruption: {
        interruption_id: requestedPause.json.interruption.interruption_id,
        request_id: requestId,
        mode: "terminate",
        state: "requested",
      },
    });
    const stalePauseFinalize = await env.DB.prepare(`
      UPDATE participation_interruptions
      SET state = 'paused', finalized_at_ms = ?
      WHERE interruption_uuid = ? AND request_uuid = ?
        AND mode = 'pause' AND state = 'requested'
    `).bind(
      Date.now(),
      requestedPause.json.interruption.interruption_id,
      requestId,
    ).run();
    expect(Number(stalePauseFinalize.meta.changes ?? 0)).toBe(0);
    await expect(env.DB.prepare(`
      UPDATE participation_interruptions SET state = 'paused'
      WHERE interruption_uuid = ?
    `).bind(
      requestedPause.json.interruption.interruption_id,
    ).run()).rejects.toThrow("CHECK constraint failed");
    const duplicateEscalation = await requestInterruption(
      reopened.json.session_token,
      "terminate",
      requestId,
    );
    expect(duplicateEscalation.response.status).toBe(200);
    expect(duplicateEscalation.json).toMatchObject({
      duplicate: true,
      interruption: {
        interruption_id: requestedPause.json.interruption.interruption_id,
        mode: "terminate",
        state: "requested",
      },
    });
    const forbiddenReverse = await requestInterruption(
      reopened.json.session_token,
      "pause",
      requestId,
    );
    expectApiError(forbiddenReverse, 409, "interruption_idempotency_conflict");

    const oldSessionFinalize = await finalizeInterruption(
      firstRedemption.json.session_token,
      requestedPause.json.interruption.interruption_id,
      requestId,
    );
    expectApiError(oldSessionFinalize, 409, "session_superseded");
    const finalized = await finalizeInterruption(
      reopened.json.session_token,
      requestedPause.json.interruption.interruption_id,
      requestId,
    );
    expect(finalized.response.status).toBe(200);
    expect(finalized.json.interruption).toMatchObject({
      mode: "terminate",
      state: "terminated",
    });

    const auditRows = await env.DB.prepare(`
      SELECT action, COUNT(*) AS count FROM audit_log
      WHERE participant_uuid = ? AND action = 'participation_interruption_escalated'
      GROUP BY action
    `).bind(created.participant.participant_uuid).all();
    expect(auditRows.results).toEqual([{
      action: "participation_interruption_escalated",
      count: 1,
    }]);
  });

  it("prevents completion from leaving a stale open interruption", async () => {
    const requestWinsId = 930_005;
    const requestWins = await createParticipant(requestWinsId);
    const requestWinsRedemption = requestWins.start;
    const openRequest = await requestInterruption(
      requestWinsRedemption.json.session_token,
      "pause",
    );
    expect(openRequest.response.status).toBe(202);
    const blockedCompletion = await api("/api/visit/complete", {
      method: "POST",
      token: requestWinsRedemption.json.session_token,
      body: {},
    });
    expectApiError(blockedCompletion, 409, "participation_interruption_open");
    const completionWinsId = 930_006;
    const completionWins = await createParticipant(completionWinsId);
    const completionWinsRedemption = completionWins.start;
    const completedAt = Date.now();
    await env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(
      completedAt,
      completedAt,
      completionWins.participant.pre_visit_id,
    ).run();
    await expect(env.DB.prepare(`
      INSERT INTO participation_interruptions (
        interruption_uuid, request_uuid, participant_uuid, visit_uuid,
        requested_session_uuid, mode, state, requested_at_ms,
        accepted_trial_count, next_ordinal
      ) VALUES (?, ?, ?, ?, ?, 'pause', 'requested', ?, 0, 1)
    `).bind(
      crypto.randomUUID(),
      crypto.randomUUID(),
      completionWins.participant.participant_uuid,
      completionWins.participant.pre_visit_id,
      completionWinsRedemption.json.session.session_id,
      Date.now(),
    ).run()).rejects.toThrow("interruption_blocked_by_visit_or_session_state");

    const count = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM participation_interruptions
      WHERE participant_uuid = ?
    `).bind(completionWins.participant.participant_uuid).first();
    expect(Number(count.count)).toBe(0);
  });

  it("terminates idempotently while preserving completed visits and canonical D1/R2 data", async () => {
    const baseline = (await adminApi("/api/admin/summary")).json;
    const participantId = 930_002;
    const created = await createParticipant(participantId);
    const preRedemption = created.start;
    const { firstRecordedTrial: preTrial } = await completeLeadingNonRecordingPractice(
      preRedemption,
    );
    const preStart = await startTrial(preRedemption.json.session_token, preTrial.trial_id);
    expect(preStart.response.status).toBe(201);
    const preSaved = await savePictureNamingResponse(
      preRedemption.json.session_token,
      preTrial.trial_id,
      preStart.json.attempt_id,
    );
    expect(preSaved.response.status).toBe(200);
    const preUpload = await uploadSilenceRecording(
      preRedemption.json.session_token,
      preStart.json.attempt_id,
    );
    expect(preUpload.response.status).toBe(200);

    const preRecordingBefore = await env.DB.prepare(`
      SELECT r2_key, state, sha256, byte_count, abandoned_at_ms
      FROM recordings WHERE attempt_uuid = ?
    `).bind(preStart.json.attempt_id).first();
    expect(preRecordingBefore).toMatchObject({
      state: "uploaded",
      sha256: preUpload.digest,
      byte_count: preUpload.bytes.byteLength,
      abandoned_at_ms: null,
    });
    const preObjectBefore = await env.RECORDINGS.head(preRecordingBefore.r2_key);
    expect(preObjectBefore).not.toBeNull();
    expect(preObjectBefore.size).toBe(preUpload.bytes.byteLength);
    expect(preObjectBefore.customMetadata.sha256).toBe(preUpload.digest);

    const preCompletedAt = Date.now() - 20_000;
    const preFinalizedAt = preCompletedAt + 1;
    const immediateCompletedAt = preCompletedAt + 2;
    const immediateFinalizedAt = preCompletedAt + 3;
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits
        SET status = 'completed', behavioral_completed_at_ms = ?,
            finalized_at_ms = ?, updated_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(
        preCompletedAt,
        preFinalizedAt,
        preFinalizedAt,
        created.participant.pre_visit_id,
      ),
      env.DB.prepare(`
        UPDATE visits
        SET status = 'completed', behavioral_completed_at_ms = ?,
            finalized_at_ms = ?, updated_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(
        immediateCompletedAt,
        immediateFinalizedAt,
        immediateFinalizedAt,
        created.participant.immediate_visit_id,
      ),
      env.DB.prepare(`
        UPDATE visits
        SET status = 'scheduled', target_at_ms = 0, available_at_ms = 0,
            updated_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(Date.now(), created.participant.delayed_visit_id),
    ]);

    const delayedRedemption = await startVisit("delayed", participantId);
    expect(delayedRedemption.response.status).toBe(200);
    const {
      firstRecordedTrial: delayedTrial,
      secondRecordedTrial: delayedSecondTrial,
    } = await completeLeadingNonRecordingPractice(delayedRedemption);
    const delayedStart = await startTrial(
      delayedRedemption.json.session_token,
      delayedTrial.trial_id,
    );
    expect(delayedStart.response.status).toBe(201);
    const delayedSaved = await savePictureNamingResponse(
      delayedRedemption.json.session_token,
      delayedTrial.trial_id,
      delayedStart.json.attempt_id,
    );
    expect(delayedSaved.response.status).toBe(200);

    const pendingBeforeTermination = await adminApi("/api/admin/summary");
    expect(pendingBeforeTermination.response.status).toBe(200);
    expect(
      integrityCount(pendingBeforeTermination.json, "canonical_pending_uploads")
        - integrityCount(baseline, "canonical_pending_uploads"),
    ).toBe(1);
    expect(
      integrityCount(pendingBeforeTermination.json, "noncanonical_abandoned_slots")
        - integrityCount(baseline, "noncanonical_abandoned_slots"),
    ).toBe(0);
    const dueBeforeTermination = await adminApi("/api/admin/delayed/due");
    expect(dueBeforeTermination.json.visits.some(
      (visit) => Number(visit.numeric_id) === participantId,
    )).toBe(true);

    const terminateRequestId = crypto.randomUUID();
    const terminateRequest = await requestInterruption(
      delayedRedemption.json.session_token,
      "terminate",
      terminateRequestId,
    );
    expect(terminateRequest.response.status).toBe(202);
    expect(terminateRequest.json.interruption).toMatchObject({
      mode: "terminate",
      state: "requested",
      accepted_trial_count: delayedTrial.ordinal,
      next_ordinal: delayedSecondTrial.ordinal,
    });

    const blockedAfterTerminationRequest = await startTrial(
      delayedRedemption.json.session_token,
      delayedSecondTrial.trial_id,
    );
    expectApiError(
      blockedAfterTerminationRequest,
      409,
      "trial_start_blocked_by_participation_interruption",
    );

    const terminated = await finalizeInterruption(
      delayedRedemption.json.session_token,
      terminateRequest.json.interruption.interruption_id,
      terminateRequestId,
    );
    expect(terminated.response.status).toBe(200);
    expect(terminated.json).toMatchObject({
      duplicate: false,
      partial_data_preserved: true,
      interruption: { mode: "terminate", state: "terminated" },
    });

    const duplicateFinalize = await finalizeInterruption(
      delayedRedemption.json.session_token,
      terminateRequest.json.interruption.interruption_id,
      terminateRequestId,
    );
    expect(duplicateFinalize.response.status).toBe(200);
    expect(duplicateFinalize.json).toMatchObject({
      duplicate: true,
      interruption: {
        interruption_id: terminateRequest.json.interruption.interruption_id,
        request_id: terminateRequestId,
        mode: "terminate",
        state: "terminated",
      },
    });

    const participant = await env.DB.prepare(`
      SELECT status, withdrawn_at_ms FROM participants WHERE participant_uuid = ?
    `).bind(created.participant.participant_uuid).first();
    expect(participant.status).toBe("withdrawn");
    expect(participant.withdrawn_at_ms).not.toBeNull();

    const visits = await env.DB.prepare(`
      SELECT visit_type, status, behavioral_completed_at_ms, finalized_at_ms,
             withdrawn_at_ms
      FROM visits WHERE participant_uuid = ?
    `).bind(created.participant.participant_uuid).all();
    const visitsByType = Object.fromEntries(visits.results.map((visit) => [visit.visit_type, visit]));
    expect(visitsByType.pre).toEqual({
      visit_type: "pre",
      status: "completed",
      behavioral_completed_at_ms: preCompletedAt,
      finalized_at_ms: preFinalizedAt,
      withdrawn_at_ms: null,
    });
    expect(visitsByType.immediate).toEqual({
      visit_type: "immediate",
      status: "completed",
      behavioral_completed_at_ms: immediateCompletedAt,
      finalized_at_ms: immediateFinalizedAt,
      withdrawn_at_ms: null,
    });
    expect(visitsByType.delayed).toMatchObject({
      visit_type: "delayed",
      status: "withdrawn",
      behavioral_completed_at_ms: null,
      finalized_at_ms: null,
    });
    expect(visitsByType.delayed.withdrawn_at_ms).not.toBeNull();

    const sessions = await env.DB.prepare(`
      SELECT visit_uuid, status, closed_at_ms FROM sessions
      WHERE visit_uuid IN (?, ?)
    `).bind(
      created.participant.pre_visit_id,
      created.participant.delayed_visit_id,
    ).all();
    expect(sessions.results).toHaveLength(2);
    expect(sessions.results.every((session) => session.status === "closed")).toBe(true);
    expect(sessions.results.every((session) => session.closed_at_ms !== null)).toBe(true);

    const invitations = await env.DB.prepare(`
      SELECT invite_uuid, status, revoked_at_ms FROM invitations
      WHERE visit_uuid IN (?, ?)
    `).bind(
      created.participant.pre_visit_id,
      created.participant.delayed_visit_id,
    ).all();
    expect(invitations.results).toHaveLength(2);
    expect(invitations.results.every((invitation) => invitation.status === "revoked")).toBe(true);
    expect(invitations.results.every((invitation) => invitation.revoked_at_ms !== null)).toBe(true);

    const preCanonicalAfter = await env.DB.prepare(`
      SELECT tm.canonical_attempt_uuid, ta.state AS attempt_state,
             r.state AS recording_state, r.r2_key, r.sha256, r.byte_count,
             r.abandoned_at_ms
      FROM trial_manifest tm
      JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
      JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
      WHERE tm.trial_uuid = ?
    `).bind(preTrial.trial_id).first();
    expect(preCanonicalAfter).toMatchObject({
      canonical_attempt_uuid: preStart.json.attempt_id,
      attempt_state: "response_saved",
      recording_state: "uploaded",
      r2_key: preRecordingBefore.r2_key,
      sha256: preUpload.digest,
      byte_count: preUpload.bytes.byteLength,
      abandoned_at_ms: null,
    });
    const preObjectAfter = await env.RECORDINGS.head(preRecordingBefore.r2_key);
    expect(preObjectAfter).not.toBeNull();
    expect(preObjectAfter.etag).toBe(preObjectBefore.etag);
    expect(preObjectAfter.size).toBe(preObjectBefore.size);
    expect(preObjectAfter.customMetadata.sha256).toBe(preUpload.digest);

    const delayedCanonicalAfter = await env.DB.prepare(`
      SELECT tm.canonical_attempt_uuid, ta.state AS attempt_state,
             ta.server_received_at_ms, r.state AS recording_state, r.r2_key,
             r.abandoned_at_ms, r.abandon_reason
      FROM trial_manifest tm
      JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
      JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
      WHERE tm.trial_uuid = ?
    `).bind(delayedTrial.trial_id).first();
    expect(delayedCanonicalAfter).toMatchObject({
      canonical_attempt_uuid: delayedStart.json.attempt_id,
      attempt_state: "response_saved",
      recording_state: "pending",
      abandon_reason: "participant_terminated",
    });
    expect(delayedCanonicalAfter.server_received_at_ms).not.toBeNull();
    expect(delayedCanonicalAfter.abandoned_at_ms).not.toBeNull();
    expect(await env.RECORDINGS.head(delayedCanonicalAfter.r2_key)).toBeNull();

    const futureStart = await startVisit("delayed", participantId);
    expectApiError(futureStart, 409, "participant_withdrawn");
    const dueAfterTermination = await adminApi("/api/admin/delayed/due");
    expect(dueAfterTermination.response.status).toBe(200);
    expect(dueAfterTermination.json.visits.some(
      (visit) => Number(visit.numeric_id) === participantId,
    )).toBe(false);

    const summary = await adminApi("/api/admin/summary");
    expect(summary.response.status).toBe(200);
    expect(
      groupedCount(summary.json.participation_interruptions, {
        mode: "terminate",
        state: "terminated",
      }) - groupedCount(baseline.participation_interruptions, {
        mode: "terminate",
        state: "terminated",
      }),
    ).toBe(1);
    expect(
      integrityCount(summary.json, "canonical_pending_uploads")
        - integrityCount(baseline, "canonical_pending_uploads"),
    ).toBe(0);
    expect(
      integrityCount(summary.json, "noncanonical_abandoned_slots")
        - integrityCount(baseline, "noncanonical_abandoned_slots"),
    ).toBe(0);
    expect(
      integrityCount(summary.json, "canonical_recordings_abandoned_after_termination")
        - integrityCount(baseline, "canonical_recordings_abandoned_after_termination"),
    ).toBe(1);
    expect(
      groupedCount(summary.json.participants, { status: "withdrawn" })
        - groupedCount(baseline.participants, { status: "withdrawn" }),
    ).toBe(1);
    expect(
      assignmentFlowTotal(summary.json, "terminated_count")
        - assignmentFlowTotal(baseline, "terminated_count"),
    ).toBe(1);
    for (const [visitType, status] of [
      ["pre", "completed"],
      ["immediate", "completed"],
      ["delayed", "withdrawn"],
    ]) {
      expect(
        groupedCount(summary.json.visits, { visit_type: visitType, status })
          - groupedCount(baseline.visits, { visit_type: visitType, status }),
      ).toBe(1);
    }
  });
});
