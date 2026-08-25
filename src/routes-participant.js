import { requireSession } from "./lib/auth.js";
import { getVisitForInvitation, getVisitState } from "./lib/db.js";
import { randomToken, sha256Hex, stableJson } from "./lib/crypto.js";
import {
  ApiError,
  bearerToken,
  jsonResponse,
  readBoundedBytes,
  readJson,
  requireMethod,
  requireUuid,
} from "./lib/http.js";
import { collectionConfiguration, placeholderAssetsAllowed } from "./lib/config.js";
import { DELAY_MINIMUM_MS } from "./lib/protocol.js";
import { crc32 } from "./lib/stored-zip.js";

const VALID_VISITS = new Set(["pre", "immediate", "delayed"]);
const VALID_EVENT_TYPES = new Set([
  "visibility_changed",
  "learning_visual_onset",
  "picture_naming_visual_onset",
  "l2_audio_scheduled",
  "trial_onset_late",
]);

function numericEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function assertParticipantCollectionConfigured(env) {
  const collection = collectionConfiguration(env);
  if (!collection.blocked) return;
  throw new ApiError(
    503,
    "production_collection_blocked",
    "Production participation requires real assets and an explicit supported test-token policy",
    {
      asset_version: env.ASSET_VERSION,
      assignment_version: env.ASSIGNMENT_VERSION,
      placeholder_assets: collection.placeholder,
      allow_placeholder_assets: collection.placeholderAllowed,
      test_token_policy: collection.testTokenPolicy,
      test_token_policy_ready: collection.tokenPolicyReady,
    },
  );
}

function finiteField(object, key, { minimum = -Infinity, maximum = Infinity } = {}) {
  const value = object?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(422, "invalid_response_payload", `${key} is outside the accepted range`);
  }
  return value;
}

function integerField(object, key, bounds = {}) {
  const value = finiteField(object, key, bounds);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(422, "invalid_response_payload", `${key} must be an integer`);
  }
  return value;
}

function booleanField(object, key) {
  if (typeof object?.[key] !== "boolean") {
    throw new ApiError(422, "invalid_response_payload", `${key} must be boolean`);
  }
  return object[key];
}

function nullableFiniteField(object, key, bounds = {}) {
  if (object?.[key] === null) return null;
  return finiteField(object, key, bounds);
}

function nullableBooleanField(object, key) {
  if (object?.[key] === null) return null;
  return booleanField(object, key);
}

function enumField(object, key, values) {
  if (!values.includes(object?.[key])) {
    throw new ApiError(422, "invalid_response_payload", `${key} has an invalid value`);
  }
  return object[key];
}

function plainObjectField(object, key) {
  const value = object?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "invalid_response_payload", `${key} must be an object`);
  }
  return value;
}

function assertNear(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new ApiError(422, "invalid_response_timing", `${label} does not match the assigned protocol`, {
      actual,
      expected,
      tolerance,
    });
  }
}

function validateResponsePayload(payload, attempt, nowMs) {
  const expectedTask = attempt.segment;
  if (payload.task !== expectedTask) {
    throw new ApiError(422, "task_mismatch", `Response task must be ${expectedTask}`);
  }
  const clientSavedPerfMs = finiteField(payload, "client_response_saved_perf_ms", { minimum: 0 });
  const minimumElapsedMs = expectedTask === "learning" ? 4_800 : 9_500;
  const serverElapsedMs = nowMs - Number(attempt.server_started_at_ms);
  if (!Number.isFinite(serverElapsedMs) || serverElapsedMs < minimumElapsedMs) {
    throw new ApiError(422, "response_too_early", "The response arrived before the task response window elapsed", {
      minimum_elapsed_ms: minimumElapsedMs,
      server_elapsed_ms: serverElapsedMs,
    });
  }

  let timing;
  try {
    timing = JSON.parse(attempt.trial_json).protocol.timing;
  } catch {
    throw new ApiError(500, "manifest_protocol_invalid", "Stored trial timing protocol is invalid");
  }
  const clockAnchor = plainObjectField(payload, "clock_anchor");
  finiteField(clockAnchor, "context_time_s", { minimum: 0 });
  finiteField(clockAnchor, "performance_time_ms", { minimum: 0 });
  finiteField(clockAnchor, "performance_time_origin_ms", { minimum: 0 });
  booleanField(payload, "visibility_interrupted");
  const targetOnsetPerfMs = finiteField(payload, "target_onset_perf_ms", { minimum: 0 });
  const onsetLateMs = finiteField(payload, "onset_late_ms", { minimum: 0 });

  if (expectedTask === "learning") {
    for (const key of [
      "visual_onset_perf_ms", "visual_onset_context_s", "visual_deadline_perf_ms",
      "audio_scheduled_context_s", "audio_scheduled_end_context_s", "audio_duration_s",
      "audio_ended_perf_ms", "visual_hidden_perf_ms", "trial_end_perf_ms",
    ]) finiteField(payload, key, { minimum: 0 });
    enumField(payload, "visual_mode", ["image", "placeholder"]);
    enumField(payload, "page_visibility_at_end", ["visible", "hidden"]);
    assertNear(
      payload.visual_deadline_perf_ms - payload.visual_onset_perf_ms,
      timing.visualDurationMs,
      1,
      "learning visual duration",
    );
    assertNear(
      (payload.audio_scheduled_context_s - payload.visual_onset_context_s) * 1000,
      timing.audioOnsetMs,
      10,
      "learning audio onset",
    );
    assertNear(
      payload.audio_scheduled_end_context_s - payload.audio_scheduled_context_s,
      payload.audio_duration_s,
      0.005,
      "learning audio duration",
    );
    assertNear(
      onsetLateMs,
      Math.max(0, payload.visual_onset_perf_ms - targetOnsetPerfMs),
      2,
      "learning onset lateness",
    );
    if (payload.visual_hidden_perf_ms < payload.visual_deadline_perf_ms
        || payload.trial_end_perf_ms < payload.visual_deadline_perf_ms
        || payload.audio_ended_perf_ms > clientSavedPerfMs
        || clientSavedPerfMs < payload.trial_end_perf_ms) {
      throw new ApiError(422, "invalid_response_timing", "Learning timing fields are not chronological");
    }
  } else {
    for (const key of [
      "duration_seconds", "capture_start_context_s", "capture_stop_context_s",
      "capture_stop_command_perf_ms", "capture_stopped_perf_ms", "scheduled_stop_context_s",
    ]) finiteField(payload, key, { minimum: 0 });
    const sampleRate = integerField(payload, "sample_rate_hz", { minimum: 8_000, maximum: 192_000 });
    const sampleCount = integerField(payload, "sample_count", { minimum: 1 });
    const expectedSampleCount = integerField(payload, "expected_sample_count", { minimum: 1 });
    integerField(payload, "sample_count_difference", { minimum: 0, maximum: 0 });
    integerField(payload, "missing_input_frames", { minimum: 0, maximum: 0 });
    const duration = finiteField(payload, "duration_seconds", {
      minimum: expectedTask === "picture_naming" ? 9 : 9.5,
      maximum: expectedTask === "picture_naming" ? 12.5 : 18,
    });
    const quality = plainObjectField(payload, "quality");
    const reportedAnalysisStartSeconds = finiteField(quality, "analysis_start_seconds", {
      minimum: 0,
    });
    const reportedAnalyzedSampleCount = integerField(quality, "analyzed_sample_count", {
      minimum: 1,
    });
    finiteField(quality, "rms_amplitude", { minimum: 0, maximum: 1 });
    finiteField(quality, "peak_amplitude", { minimum: 0, maximum: 1.1 });
    finiteField(quality, "clipping_ratio", { minimum: 0, maximum: 1 });
    const microphoneSettings = plainObjectField(payload, "microphone_settings");
    nullableFiniteField(microphoneSettings, "sample_rate", { minimum: 8_000, maximum: 192_000 });
    const microphoneChannels = nullableFiniteField(microphoneSettings, "channel_count", {
      minimum: 1,
      maximum: 32,
    });
    if (microphoneChannels !== null && !Number.isSafeInteger(microphoneChannels)) {
      throw new ApiError(422, "invalid_response_payload", "channel_count must be an integer or null");
    }
    nullableBooleanField(microphoneSettings, "echo_cancellation");
    nullableBooleanField(microphoneSettings, "noise_suppression");
    nullableBooleanField(microphoneSettings, "auto_gain_control");
    assertNear(sampleCount / sampleRate, duration, 0.01, "recording duration");
    if (sampleCount !== expectedSampleCount) {
      throw new ApiError(422, "recording_frame_loss", "Recording frame counts are inconsistent");
    }
    assertNear(
      payload.capture_stop_context_s - payload.capture_start_context_s,
      duration,
      0.01,
      "recording capture duration",
    );
    assertNear(
      payload.scheduled_stop_context_s,
      payload.capture_stop_context_s,
      0.005,
      "recording scheduled stop",
    );
    if (payload.capture_stop_command_perf_ms > payload.capture_stopped_perf_ms
        || clientSavedPerfMs < payload.capture_stopped_perf_ms) {
      throw new ApiError(422, "invalid_response_timing", "Response was saved before capture stopped");
    }

    if (expectedTask === "picture_naming") {
      for (const key of [
        "visual_onset_perf_ms", "visual_onset_context_s", "response_deadline_perf_ms",
        "response_deadline_context_s", "visual_hidden_perf_ms",
      ]) finiteField(payload, key, { minimum: 0 });
      enumField(payload, "visual_mode", ["image", "placeholder"]);
      const responseWindowMs = integerField(payload, "response_window_ms", { minimum: 1 });
      const measuredPreRollMs = finiteField(payload, "measured_pre_roll_ms", { minimum: 0 });
      assertNear(responseWindowMs, timing.responseWindowMs, 0, "Picture Naming response window");
      assertNear(
        payload.response_deadline_perf_ms - payload.visual_onset_perf_ms,
        timing.responseWindowMs,
        1,
        "Picture Naming performance deadline",
      );
      assertNear(
        (payload.response_deadline_context_s - payload.visual_onset_context_s) * 1000,
        timing.responseWindowMs,
        10,
        "Picture Naming audio-clock deadline",
      );
      assertNear(
        onsetLateMs,
        Math.max(0, payload.visual_onset_perf_ms - targetOnsetPerfMs),
        2,
        "Picture Naming onset lateness",
      );
      assertNear(
        measuredPreRollMs,
        Math.max(0, (payload.visual_onset_context_s - payload.capture_start_context_s) * 1000),
        2,
        "Picture Naming recording pre-roll",
      );
      if (payload.capture_start_context_s > payload.visual_onset_context_s
          || payload.visual_hidden_perf_ms < payload.response_deadline_perf_ms
          || clientSavedPerfMs < payload.response_deadline_perf_ms) {
        throw new ApiError(422, "invalid_response_timing", "Picture Naming timing fields are not chronological");
      }
    } else {
      for (const key of [
        "audio_scheduled_context_s", "audio_scheduled_end_context_s", "audio_duration_s",
        "audio_ended_perf_ms", "audio_ended_context_s", "response_deadline_context_s",
        "response_deadline_perf_ms", "scheduled_audio_onset_perf_ms",
      ]) finiteField(payload, key, { minimum: 0 });
      const responseWindowMs = integerField(payload, "response_window_after_audio_ms", { minimum: 1 });
      const measuredPreAudioMs = finiteField(payload, "measured_pre_audio_ms", { minimum: 0 });
      assertNear(responseWindowMs, timing.responseWindowAfterAudioMs, 0, "L2-to-L1 response window");
      assertNear(
        payload.audio_scheduled_end_context_s - payload.audio_scheduled_context_s,
        payload.audio_duration_s,
        0.005,
        "L2-to-L1 cue duration",
      );
      assertNear(
        payload.scheduled_audio_onset_perf_ms,
        clockAnchor.performance_time_ms
          + (payload.audio_scheduled_context_s - clockAnchor.context_time_s) * 1000,
        10,
        "L2-to-L1 scheduled audio onset",
      );
      assertNear(
        (payload.response_deadline_context_s - payload.audio_scheduled_end_context_s) * 1000,
        timing.responseWindowAfterAudioMs,
        10,
        "L2-to-L1 response deadline",
      );
      assertNear(
        onsetLateMs,
        Math.max(0, payload.scheduled_audio_onset_perf_ms - targetOnsetPerfMs),
        2,
        "L2-to-L1 onset lateness",
      );
      assertNear(
        measuredPreAudioMs,
        Math.max(0, (payload.audio_scheduled_context_s - payload.capture_start_context_s) * 1000),
        2,
        "L2-to-L1 recording pre-audio window",
      );
      if (payload.capture_start_context_s > payload.audio_scheduled_context_s
          || payload.audio_ended_context_s < payload.audio_scheduled_context_s
          || payload.audio_ended_perf_ms > clientSavedPerfMs
          || clientSavedPerfMs < payload.response_deadline_perf_ms) {
        throw new ApiError(422, "invalid_response_timing", "L2-to-L1 timing fields are not chronological");
      }
    }

    const expectedAnalysisStartSeconds = expectedTask === "picture_naming"
      ? Math.max(0, payload.visual_onset_context_s - payload.capture_start_context_s)
      : Math.max(0, payload.audio_scheduled_end_context_s - payload.capture_start_context_s);
    assertNear(
      reportedAnalysisStartSeconds,
      expectedAnalysisStartSeconds,
      0.005,
      "recording quality analysis start",
    );
    const analysisStartIndex = Math.max(
      0,
      Math.min(sampleCount, Math.floor(expectedAnalysisStartSeconds * sampleRate)),
    );
    const expectedAnalyzedSampleCount = Math.max(1, sampleCount - analysisStartIndex);
    if (reportedAnalyzedSampleCount !== expectedAnalyzedSampleCount) {
      throw new ApiError(422, "invalid_response_payload", "analyzed_sample_count is inconsistent", {
        actual: reportedAnalyzedSampleCount,
        expected: expectedAnalyzedSampleCount,
      });
    }
  }
  return clientSavedPerfMs;
}

export async function redeemInvitation(request, env) {
  requireMethod(request, ["POST"]);
  assertParticipantCollectionConfigured(env);
  const body = await readJson(request);
  const rawToken = String(body.token ?? "");
  if (!/^[A-Za-z0-9_-]{40,100}$/u.test(rawToken)) {
    throw new ApiError(400, "invalid_invitation", "Invitation token format is invalid");
  }
  const expectedVisitType = String(body.expected_visit_type ?? "");
  if (!VALID_VISITS.has(expectedVisitType)) {
    throw new ApiError(400, "invalid_visit_type", "Expected visit type must be pre, immediate, or delayed");
  }
  const clientInstanceId = requireUuid(body.client_instance_id, "client_instance_id");
  const tokenHash = await sha256Hex(rawToken);
  const invitation = await getVisitForInvitation(env.DB, tokenHash);
  if (!invitation || invitation.invitation_status !== "active") {
    throw new ApiError(404, "invitation_not_found", "Invitation is invalid or has been revoked");
  }
  if (invitation.visit_type !== expectedVisitType) {
    throw new ApiError(409, "wrong_visit_route", "This invitation belongs to a different visit", {
      expected: invitation.visit_type,
    });
  }
  if (["completed", "withdrawn"].includes(invitation.visit_status)) {
    throw new ApiError(409, "visit_closed", "This visit is already closed", { status: invitation.visit_status });
  }
  const nowMs = Date.now();
  if (invitation.available_at_ms !== null && Number(invitation.available_at_ms) > nowMs) {
    throw new ApiError(403, "visit_not_available", "This visit is not available yet", {
      available_at_ms: invitation.available_at_ms,
      server_now_ms: nowMs,
    });
  }

  const priorEpoch = Number(invitation.active_session_epoch);
  const epoch = priorEpoch + 1;
  const sessionUuid = crypto.randomUUID();
  const rawSessionToken = randomToken(32);
  const sessionTokenHash = await sha256Hex(rawSessionToken);
  const expiresAtMs = nowMs + numericEnv(env, "SESSION_TTL_SECONDS", 43_200) * 1000;
  try {
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits
        SET active_session_epoch = ?,
            status = CASE WHEN status IN ('planned', 'scheduled', 'invited') THEN 'started' ELSE status END,
            first_started_at_ms = COALESCE(first_started_at_ms, ?),
            last_seen_at_ms = ?, updated_at_ms = ?
        WHERE visit_uuid = ? AND active_session_epoch = ?
          AND status NOT IN ('completed', 'withdrawn')
      `).bind(epoch, nowMs, nowMs, nowMs, invitation.visit_uuid, priorEpoch),
      env.DB.prepare(`
        UPDATE sessions
        SET status = 'superseded', superseded_at_ms = ?
        WHERE visit_uuid = ? AND status = 'active'
      `).bind(nowMs, invitation.visit_uuid),
      env.DB.prepare(`
        INSERT INTO sessions (
          session_uuid, visit_uuid, invite_uuid, epoch, client_instance_id, token_hash,
          status, started_at_ms, last_seen_at_ms, expires_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(
        sessionUuid,
        invitation.visit_uuid,
        invitation.invite_uuid,
        epoch,
        clientInstanceId,
        sessionTokenHash,
        nowMs,
        nowMs,
        expiresAtMs,
      ),
      env.DB.prepare(`
        UPDATE invitations
        SET first_redeemed_at_ms = COALESCE(first_redeemed_at_ms, ?),
            last_redeemed_at_ms = ?, redeem_count = redeem_count + 1
        WHERE invite_uuid = ? AND status = 'active'
      `).bind(nowMs, nowMs, invitation.invite_uuid),
      env.DB.prepare(`
        INSERT INTO audit_log (
          audit_uuid, actor_type, action, participant_uuid, visit_uuid, server_at_ms, details_json
        ) VALUES (?, 'participant', 'invitation_redeemed', ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        invitation.participant_uuid,
        invitation.visit_uuid,
        nowMs,
        stableJson({ epoch, client_instance_id: clientInstanceId }),
      ),
    ]);
  } catch {
    throw new ApiError(409, "invitation_redeem_conflict", "The invitation changed while it was being redeemed; retry the invitation link");
  }
  const session = await env.DB.prepare(`
    SELECT
      s.session_uuid, s.visit_uuid, s.epoch, s.client_instance_id,
      s.status AS session_status, s.expires_at_ms,
      v.visit_type, v.status AS visit_status, v.active_session_epoch,
      v.participant_uuid, v.manifest_hash, v.expected_trial_count,
      v.expected_recording_count, v.first_started_at_ms, v.learning_completed_at_ms,
      v.picture_naming_started_at_ms, v.picture_naming_completed_at_ms,
      v.l2_to_l1_started_at_ms, v.behavioral_completed_at_ms, v.finalized_at_ms,
      v.target_at_ms, v.available_at_ms,
      p.numeric_id, p.assignment_version, p.asset_version
    FROM sessions s
    JOIN visits v ON v.visit_uuid = s.visit_uuid
    JOIN participants p ON p.participant_uuid = v.participant_uuid
    WHERE s.session_uuid = ? LIMIT 1
  `).bind(sessionUuid).first();
  const state = await getVisitState(env.DB, session);
  return jsonResponse({ ok: true, session_token: rawSessionToken, ...state });
}

export async function sessionState(request, env) {
  requireMethod(request, ["GET"]);
  const session = await requireSession(request, env, { allowCompleted: true });
  return jsonResponse({ ok: true, ...(await getVisitState(env.DB, session)) });
}

export async function heartbeat(request, env) {
  requireMethod(request, ["POST"]);
  const session = await requireSession(request, env);
  return jsonResponse({
    ok: true,
    session_id: session.session_uuid,
    epoch: session.epoch,
    server_now_ms: Date.now(),
  });
}

async function assertAssetReady(env, trial) {
  if (Number(trial.placeholder_asset) === 1) {
    const configuration = collectionConfiguration(env);
    if (!placeholderAssetsAllowed(env) || configuration.production) {
      throw new ApiError(503, "placeholder_assets_disabled", "Placeholder assets are disabled for this deployment");
    }
    return;
  }
  const keys = [trial.audio_key, trial.image_key].filter(Boolean);
  const heads = await Promise.all(keys.map((key) => env.STIMULI.head(key)));
  const missingIndex = heads.findIndex((head) => head === null);
  if (missingIndex >= 0) {
    throw new ApiError(503, "stimulus_asset_missing", "A required stimulus is missing");
  }
}

export async function startTrial(request, env, trialUuidInput) {
  requireMethod(request, ["POST"]);
  assertParticipantCollectionConfigured(env);
  const session = await requireSession(request, env);
  const trialUuid = requireUuid(trialUuidInput, "trial_id");
  const body = await readJson(request);
  const startKey = requireUuid(body.start_key, "start_key");
  const clientStartedPerfMs = Number(body.client_started_perf_ms);
  const resumeAfterStimulus = body.resume_after_stimulus === true;
  if (!Number.isFinite(clientStartedPerfMs) || clientStartedPerfMs < 0) {
    throw new ApiError(400, "invalid_timing", "client_started_perf_ms must be a non-negative finite number");
  }
  const expected = await env.DB.prepare(`
    SELECT * FROM trial_manifest
    WHERE visit_uuid = ? AND canonical_attempt_uuid IS NULL
    ORDER BY ordinal LIMIT 1
  `).bind(session.visit_uuid).first();
  if (!expected) throw new ApiError(409, "behavioral_trials_complete", "All behavioral trials already have responses");
  if (expected.trial_uuid !== trialUuid) {
    throw new ApiError(409, "trial_out_of_order", "Requested trial is not the next server-authorized trial", {
      expected_trial_id: expected.trial_uuid,
      expected_ordinal: expected.ordinal,
    });
  }
  const priorSegmentUploads = await env.DB.prepare(`
    SELECT COUNT(*) AS missing_count
    FROM trial_manifest prior
    LEFT JOIN recordings r ON r.attempt_uuid = prior.canonical_attempt_uuid
    WHERE prior.visit_uuid = ?
      AND prior.ordinal < ?
      AND prior.segment != ?
      AND prior.expects_recording = 1
      AND COALESCE(r.state, 'missing') != 'uploaded'
  `).bind(session.visit_uuid, expected.ordinal, expected.segment).first();
  if (Number(priorSegmentUploads?.missing_count ?? 0) > 0) {
    throw new ApiError(
      409,
      "prior_segment_recordings_pending",
      "The preceding task recordings must finish uploading before the next task starts",
      { missing_recordings: Number(priorSegmentUploads.missing_count) },
    );
  }
  await assertAssetReady(env, expected);
  const existingByStartKey = await env.DB.prepare(`
    SELECT attempt_uuid, attempt_no, repeated_after_interruption
    FROM trial_attempts WHERE trial_uuid = ? AND start_key = ? LIMIT 1
  `).bind(trialUuid, startKey).first();
  if (existingByStartKey) {
    if (resumeAfterStimulus) {
      await env.DB.prepare(`
        UPDATE trial_attempts
        SET repeated_after_interruption = 1,
            extra_exposure = CASE
              WHEN (SELECT segment FROM trial_manifest WHERE trial_uuid = ?) = 'learning' THEN 1
              ELSE extra_exposure END
        WHERE attempt_uuid = ?
      `).bind(trialUuid, existingByStartKey.attempt_uuid).run();
    }
    return jsonResponse({
      ok: true,
      duplicate: true,
      attempt_id: existingByStartKey.attempt_uuid,
      attempt_no: existingByStartKey.attempt_no,
      repeated_after_interruption: resumeAfterStimulus || Boolean(existingByStartKey.repeated_after_interruption),
    });
  }
  const existingStart = await env.DB.prepare(`
    SELECT attempt_uuid, attempt_no, session_uuid, start_key, state, repeated_after_interruption
    FROM trial_attempts WHERE trial_uuid = ? AND state = 'started'
    ORDER BY attempt_no DESC LIMIT 1
  `).bind(trialUuid).first();
  if (existingStart && existingStart.session_uuid === session.session_uuid) {
    if (existingStart.start_key === startKey) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        attempt_id: existingStart.attempt_uuid,
        attempt_no: existingStart.attempt_no,
        repeated_after_interruption: Boolean(existingStart.repeated_after_interruption),
      });
    }
    throw new ApiError(409, "trial_already_started", "This trial already has an active attempt in the current session");
  }
  const lastAttempt = await env.DB.prepare(`
    SELECT COALESCE(MAX(attempt_no), 0) AS attempt_no
    FROM trial_attempts WHERE trial_uuid = ?
  `).bind(trialUuid).first();
  const attemptNo = Number(lastAttempt?.attempt_no ?? 0) + 1;
  const repeated = attemptNo > 1 ? 1 : 0;
  const attemptUuid = crypto.randomUUID();
  const nowMs = Date.now();
  const recordingKey = expected.expects_recording
    ? `recordings/${session.participant_uuid}/${session.visit_type}/${expected.segment}/${trialUuid}/${attemptUuid}.wav`
    : null;
  const statements = [
    env.DB.prepare(`
      INSERT INTO trial_attempts (
        attempt_uuid, trial_uuid, attempt_no, session_uuid, start_key, state,
        repeated_after_interruption, extra_exposure, server_started_at_ms,
        client_started_perf_ms
      ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)
    `).bind(
      attemptUuid,
      trialUuid,
      attemptNo,
      session.session_uuid,
      startKey,
      repeated || resumeAfterStimulus ? 1 : 0,
      (repeated || resumeAfterStimulus) && expected.segment === "learning" ? 1 : 0,
      nowMs,
      clientStartedPerfMs,
    ),
    env.DB.prepare(`
      UPDATE segments
      SET status = CASE WHEN status = 'pending' THEN 'started' ELSE status END,
          started_at_ms = COALESCE(started_at_ms, ?)
      WHERE visit_uuid = ? AND segment = ?
    `).bind(nowMs, session.visit_uuid, expected.segment),
    env.DB.prepare(`
      UPDATE visits
      SET picture_naming_started_at_ms = CASE
            WHEN ? = 'picture_naming' THEN COALESCE(picture_naming_started_at_ms, ?)
            ELSE picture_naming_started_at_ms END,
          l2_to_l1_started_at_ms = CASE
            WHEN ? = 'l2_to_l1' THEN COALESCE(l2_to_l1_started_at_ms, ?)
            ELSE l2_to_l1_started_at_ms END,
          last_seen_at_ms = ?, updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(expected.segment, nowMs, expected.segment, nowMs, nowMs, nowMs, session.visit_uuid),
  ];
  if (recordingKey) {
    statements.push(env.DB.prepare(`
      INSERT INTO recordings (attempt_uuid, r2_key, state, updated_at_ms)
      VALUES (?, ?, 'pending', ?)
    `).bind(attemptUuid, recordingKey, nowMs));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const duplicate = await env.DB.prepare(`
      SELECT attempt_uuid, attempt_no, repeated_after_interruption
      FROM trial_attempts WHERE start_key = ? LIMIT 1
    `).bind(startKey).first();
    if (duplicate) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        attempt_id: duplicate.attempt_uuid,
        attempt_no: duplicate.attempt_no,
        repeated_after_interruption: Boolean(duplicate.repeated_after_interruption),
      });
    }
    throw error;
  }
  return jsonResponse({
    ok: true,
    duplicate: false,
    attempt_id: attemptUuid,
    attempt_no: attemptNo,
    repeated_after_interruption: Boolean(repeated),
    server_started_at_ms: nowMs,
  }, 201);
}

export async function saveTrialResponse(request, env, trialUuidInput) {
  requireMethod(request, ["PUT"]);
  const session = await requireSession(request, env);
  const trialUuid = requireUuid(trialUuidInput, "trial_id");
  const body = await readJson(request, 65_536);
  const attemptUuid = requireUuid(body.attempt_id, "attempt_id");
  const responseKey = requireUuid(body.response_key, "response_key");
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new ApiError(400, "invalid_payload", "payload must be a JSON object");
  }
  const attempt = await env.DB.prepare(`
    SELECT
      ta.*, tm.visit_uuid, tm.segment, tm.segment_ordinal, tm.ordinal,
      tm.expects_recording, tm.canonical_attempt_uuid, tm.trial_json,
      v.expected_trial_count, v.visit_type
    FROM trial_attempts ta
    JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
    JOIN visits v ON v.visit_uuid = tm.visit_uuid
    WHERE ta.attempt_uuid = ? AND ta.trial_uuid = ?
    LIMIT 1
  `).bind(attemptUuid, trialUuid).first();
  if (!attempt || attempt.visit_uuid !== session.visit_uuid) {
    throw new ApiError(404, "attempt_not_found", "Trial attempt was not found in this visit");
  }
  const payloadJson = stableJson(body.payload);
  const payloadHash = await sha256Hex(payloadJson);
  if (attempt.state === "response_saved") {
    if (attempt.response_key === responseKey && attempt.payload_hash === payloadHash) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        trial_id: trialUuid,
        attempt_id: attemptUuid,
        payload_sha256: payloadHash,
      });
    }
    throw new ApiError(409, "idempotency_conflict", "Response key or payload conflicts with the saved response");
  }
  const nowMs = Date.now();
  const clientResponseSavedPerfMs = validateResponsePayload(body.payload, attempt, nowMs);
  if (attempt.canonical_attempt_uuid && attempt.canonical_attempt_uuid !== attemptUuid) {
    throw new ApiError(409, "canonical_response_exists", "This trial already has an accepted response");
  }
  const lastSegment = await env.DB.prepare(`
    SELECT NOT EXISTS (
      SELECT 1 FROM trial_manifest later
      WHERE later.visit_uuid = current.visit_uuid
        AND later.segment = current.segment
        AND later.segment_ordinal > current.segment_ordinal
    ) AS is_last_segment_trial
    FROM trial_manifest current WHERE current.trial_uuid = ?
  `).bind(trialUuid).first();
  const isLastSegmentTrial = Boolean(lastSegment?.is_last_segment_trial);
  const isLastVisitTrial = Number(attempt.ordinal) === Number(attempt.expected_trial_count);
  const statements = [
    env.DB.prepare(`
      UPDATE trial_attempts
      SET response_key = ?, state = 'response_saved', server_received_at_ms = ?,
          client_received_perf_ms = ?, payload_hash = ?, payload_json = ?
      WHERE attempt_uuid = ? AND state = 'started'
        AND EXISTS (
          SELECT 1 FROM sessions active_session
          JOIN visits active_visit ON active_visit.visit_uuid = active_session.visit_uuid
          WHERE active_session.session_uuid = ?
            AND active_session.status = 'active'
            AND active_session.epoch = active_visit.active_session_epoch
            AND active_visit.visit_uuid = ?
            AND active_visit.status NOT IN ('completed', 'withdrawn')
        )
        AND EXISTS (
          SELECT 1 FROM trial_manifest current
          WHERE current.trial_uuid = ? AND current.canonical_attempt_uuid IS NULL
        )
    `).bind(
      responseKey,
      nowMs,
      clientResponseSavedPerfMs,
      payloadHash,
      payloadJson,
      attemptUuid,
      session.session_uuid,
      session.visit_uuid,
      trialUuid,
    ),
    env.DB.prepare(`
      UPDATE trial_manifest SET canonical_attempt_uuid = ?
      WHERE trial_uuid = ? AND canonical_attempt_uuid IS NULL
        AND EXISTS (
          SELECT 1 FROM trial_attempts accepted
          WHERE accepted.attempt_uuid = ? AND accepted.state = 'response_saved'
        )
    `).bind(attemptUuid, trialUuid, attemptUuid),
  ];
  if (isLastSegmentTrial) {
    statements.push(env.DB.prepare(`
      UPDATE segments
      SET status = 'completed', completed_at_ms = COALESCE(completed_at_ms, ?)
      WHERE visit_uuid = ? AND segment = ?
        AND EXISTS (
          SELECT 1 FROM trial_manifest accepted
          WHERE accepted.trial_uuid = ? AND accepted.canonical_attempt_uuid = ?
        )
    `).bind(nowMs, session.visit_uuid, attempt.segment, trialUuid, attemptUuid));
  }
  statements.push(env.DB.prepare(`
    UPDATE visits
    SET learning_completed_at_ms = CASE
          WHEN ? = 'learning' AND ? = 1 THEN COALESCE(learning_completed_at_ms, ?)
          ELSE learning_completed_at_ms END,
        picture_naming_completed_at_ms = CASE
          WHEN ? = 'picture_naming' AND ? = 1 THEN COALESCE(picture_naming_completed_at_ms, ?)
          ELSE picture_naming_completed_at_ms END,
        behavioral_completed_at_ms = CASE
          WHEN ? = 1 THEN COALESCE(behavioral_completed_at_ms, ?) ELSE behavioral_completed_at_ms END,
        status = CASE WHEN ? = 1 THEN 'awaiting_uploads' ELSE status END,
        last_seen_at_ms = ?, updated_at_ms = ?
    WHERE visit_uuid = ?
      AND EXISTS (
        SELECT 1 FROM trial_manifest accepted
        WHERE accepted.trial_uuid = ? AND accepted.canonical_attempt_uuid = ?
      )
  `).bind(
    attempt.segment,
    isLastSegmentTrial ? 1 : 0,
    nowMs,
    attempt.segment,
    isLastSegmentTrial ? 1 : 0,
    nowMs,
    isLastVisitTrial ? 1 : 0,
    nowMs,
    isLastVisitTrial ? 1 : 0,
    nowMs,
    nowMs,
    session.visit_uuid,
    trialUuid,
    attemptUuid,
  ));
  if (isLastVisitTrial && session.visit_type === "immediate") {
    const targetMs = nowMs + DELAY_MINIMUM_MS;
    statements.push(env.DB.prepare(`
      UPDATE visits
      SET target_at_ms = COALESCE(target_at_ms, ?),
          available_at_ms = COALESCE(available_at_ms, ?),
          updated_at_ms = ?
      WHERE participant_uuid = ? AND visit_type = 'delayed'
        AND EXISTS (
          SELECT 1 FROM trial_manifest accepted
          WHERE accepted.trial_uuid = ? AND accepted.canonical_attempt_uuid = ?
        )
    `).bind(targetMs, targetMs, nowMs, session.participant_uuid, trialUuid, attemptUuid));
  }
  await env.DB.batch(statements);
  const acceptedAfterWrite = await env.DB.prepare(`
    SELECT
      tm.canonical_attempt_uuid, ta.state, ta.response_key, ta.payload_hash
    FROM trial_manifest tm
    LEFT JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
    WHERE tm.trial_uuid = ? LIMIT 1
  `).bind(trialUuid).first();
  if (acceptedAfterWrite?.canonical_attempt_uuid !== attemptUuid) {
    throw new ApiError(409, "response_race_lost", "A different attempt was accepted for this trial");
  }
  if (acceptedAfterWrite.state !== "response_saved"
      || acceptedAfterWrite.response_key !== responseKey
      || acceptedAfterWrite.payload_hash !== payloadHash) {
    throw new ApiError(409, "idempotency_conflict", "The accepted response differs from this request");
  }
  return jsonResponse({
    ok: true,
    duplicate: false,
    trial_id: trialUuid,
    attempt_id: attemptUuid,
    payload_sha256: payloadHash,
    expects_recording: Boolean(attempt.expects_recording),
    segment_completed: isLastSegmentTrial,
    behavioral_completed: isLastVisitTrial,
    server_received_at_ms: nowMs,
  });
}

function validateRecordingHeaders(request, env) {
  const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "audio/wav" && contentType !== "audio/x-wav") {
    throw new ApiError(415, "invalid_recording_type", "Recording must be audio/wav");
  }
  const contentLengthText = request.headers.get("Content-Length");
  const contentLength = contentLengthText === null ? null : Number(contentLengthText);
  const maximum = numericEnv(env, "MAX_RECORDING_BYTES", 4_194_304);
  if (contentLength !== null
      && (!/^[0-9]+$/u.test(contentLengthText)
        || !Number.isSafeInteger(contentLength)
        || contentLength <= 44
        || contentLength > maximum)) {
    throw new ApiError(413, "invalid_recording_size", "Recording size is outside the accepted range", { maximum });
  }
  const checksum = (request.headers.get("X-Content-SHA256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(checksum)) {
    throw new ApiError(400, "recording_checksum_required", "X-Content-SHA256 must be a SHA-256 hex digest");
  }
  return { contentType, declaredContentLength: contentLength, maximum, checksum };
}

function ascii(view, offset, length) {
  let output = "";
  for (let index = 0; index < length; index += 1) output += String.fromCharCode(view.getUint8(offset + index));
  return output;
}

export function validatePcmWav(bytes, segment) {
  if (bytes.byteLength < 44) throw new ApiError(422, "invalid_wav", "WAV file is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new ApiError(422, "invalid_wav", "Recording must be a RIFF/WAVE file");
  }
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new ApiError(422, "invalid_wav", "RIFF size does not match the uploaded byte count");
  }
  let offset = 12;
  let format = null;
  let dataBytes = null;
  let formatChunks = 0;
  let dataChunks = 0;
  let formatOffset = null;
  let dataOffset = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > bytes.byteLength) throw new ApiError(422, "invalid_wav", "WAV chunk exceeds file bounds");
    if (chunkId === "fmt ") {
      formatChunks += 1;
      formatOffset = offset;
      if (chunkSize !== 16) throw new ApiError(422, "invalid_wav", "WAV fmt chunk must use the canonical PCM layout");
      format = {
        audioFormat: view.getUint16(chunkStart, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        byteRate: view.getUint32(chunkStart + 8, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    }
    if (chunkId === "data") {
      dataChunks += 1;
      dataOffset = offset;
      dataBytes = chunkSize;
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!format || dataBytes === null || dataBytes <= 0 || formatChunks !== 1 || dataChunks !== 1) {
    throw new ApiError(422, "invalid_wav", "WAV fmt and data chunks are required");
  }
  if (offset !== bytes.byteLength) {
    throw new ApiError(422, "invalid_wav", "WAV chunks do not terminate at the file boundary");
  }
  if (formatOffset !== 12 || dataOffset !== 36) {
    throw new ApiError(422, "invalid_wav", "WAV chunks are not in the canonical encoder order");
  }
  if (dataBytes + 44 !== bytes.byteLength) {
    throw new ApiError(422, "invalid_wav", "WAV must end immediately after its canonical PCM data chunk");
  }
  if (format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16
      || format.blockAlign !== 2 || format.byteRate !== format.sampleRate * 2
      || format.sampleRate < 8_000 || format.sampleRate > 192_000 || dataBytes % 2 !== 0) {
    throw new ApiError(422, "invalid_wav_format", "Recording must be mono 16-bit PCM WAV with a supported sample rate");
  }
  const durationSeconds = dataBytes / format.byteRate;
  const minimum = segment === "picture_naming" ? 9 : 9.5;
  const maximum = segment === "picture_naming" ? 12.5 : 18;
  if (durationSeconds < minimum || durationSeconds > maximum) {
    throw new ApiError(422, "invalid_wav_duration", "Recording duration is outside the task window", {
      duration_seconds: durationSeconds,
      minimum_seconds: minimum,
      maximum_seconds: maximum,
    });
  }
  return { ...format, dataBytes, sampleCount: dataBytes / 2, durationSeconds };
}

function recordingAnalysisStartSeconds(responsePayload, segment) {
  return segment === "picture_naming"
    ? Math.max(0, responsePayload.visual_onset_context_s - responsePayload.capture_start_context_s)
    : Math.max(0, responsePayload.audio_scheduled_end_context_s - responsePayload.capture_start_context_s);
}

function analyzePcm16(bytes, wav, analysisStartSeconds) {
  const startIndex = Math.max(
    0,
    Math.min(wav.sampleCount, Math.floor(analysisStartSeconds * wav.sampleRate)),
  );
  const analyzedSampleCount = Math.max(1, wav.sampleCount - startIndex);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  for (let sampleIndex = startIndex; sampleIndex < wav.sampleCount; sampleIndex += 1) {
    const raw = view.getInt16(44 + sampleIndex * 2, true);
    const sample = raw < 0 ? raw / 32_768 : raw / 32_767;
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    if (absolute > peak) peak = absolute;
    if (absolute >= 0.98) clipped += 1;
  }
  return {
    analysisStartSeconds,
    analyzedSampleCount,
    rmsAmplitude: Math.sqrt(sumSquares / analyzedSampleCount),
    peakAmplitude: peak,
    clippingRatio: clipped / analyzedSampleCount,
  };
}

function assertRecordingQualityMatches(responsePayload, serverQuality) {
  const reported = responsePayload.quality;
  const amplitudeTolerance = 0.002;
  const clippingTolerance = Math.max(0.002, 2 / serverQuality.analyzedSampleCount);
  const mismatches = [];
  for (const [key, actual] of [
    ["rms_amplitude", serverQuality.rmsAmplitude],
    ["peak_amplitude", serverQuality.peakAmplitude],
  ]) {
    if (Math.abs(reported[key] - actual) > amplitudeTolerance) {
      mismatches.push({ field: key, reported: reported[key], actual, tolerance: amplitudeTolerance });
    }
  }
  if (Math.abs(reported.clipping_ratio - serverQuality.clippingRatio) > clippingTolerance) {
    mismatches.push({
      field: "clipping_ratio",
      reported: reported.clipping_ratio,
      actual: serverQuality.clippingRatio,
      tolerance: clippingTolerance,
    });
  }
  if (mismatches.length > 0) {
    throw new ApiError(422, "recording_quality_mismatch", "WAV samples do not match the accepted quality metadata", {
      mismatches,
    });
  }
}

async function finalizeRecordingObject(env, recording, headers, object, session, duplicate) {
  const nowMs = Date.now();
  const changed = await env.DB.prepare(`
    UPDATE recordings
    SET state = 'uploaded', sha256 = ?, etag = ?, byte_count = ?, mime_type = ?,
        sample_rate_hz = ?, sample_count = ?, duration_seconds = ?,
        analysis_start_seconds = ?, analyzed_sample_count = ?, rms_amplitude = ?,
        peak_amplitude = ?, clipping_ratio = ?, crc32 = ?,
        uploaded_at_ms = COALESCE(uploaded_at_ms, ?), updated_at_ms = ?
    WHERE attempt_uuid = ? AND state = 'pending'
      AND EXISTS (
        SELECT 1 FROM sessions active_session
        JOIN visits active_visit ON active_visit.visit_uuid = active_session.visit_uuid
        WHERE active_session.session_uuid = ?
          AND active_session.status = 'active'
          AND active_session.epoch = active_visit.active_session_epoch
          AND active_visit.visit_uuid = ?
          AND active_visit.status NOT IN ('completed', 'withdrawn')
      )
  `).bind(
    headers.checksum,
    object.etag,
    headers.contentLength,
    headers.contentType,
    headers.wav.sampleRate,
    headers.wav.sampleCount,
    headers.wav.durationSeconds,
    headers.wav.quality.analysisStartSeconds,
    headers.wav.quality.analyzedSampleCount,
    headers.wav.quality.rmsAmplitude,
    headers.wav.quality.peakAmplitude,
    headers.wav.quality.clippingRatio,
    headers.crc32,
    nowMs,
    nowMs,
    recording.attempt_uuid,
    session.session_uuid,
    session.visit_uuid,
  ).run();
  if (Number(changed.meta.changes ?? 0) !== 1) {
    const canonical = await env.DB.prepare(`
      SELECT state, sha256, byte_count FROM recordings WHERE attempt_uuid = ? LIMIT 1
    `).bind(recording.attempt_uuid).first();
    if (canonical?.state === "uploaded"
        && canonical.sha256 === headers.checksum
        && Number(canonical.byte_count) === headers.contentLength) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        attempt_id: recording.attempt_uuid,
        sha256: headers.checksum,
      });
    }
    throw new ApiError(409, "session_superseded", "Recording was received after this session was superseded");
  }
  return jsonResponse({
    ok: true,
    duplicate,
    attempt_id: recording.attempt_uuid,
    sha256: headers.checksum,
    quality: {
      analysis_start_seconds: headers.wav.quality.analysisStartSeconds,
      analyzed_sample_count: headers.wav.quality.analyzedSampleCount,
      rms_amplitude: headers.wav.quality.rmsAmplitude,
      peak_amplitude: headers.wav.quality.peakAmplitude,
      clipping_ratio: headers.wav.quality.clippingRatio,
    },
  });
}

async function recordingDuplicateOrConflict(env, recording, headers, session) {
  const existingObject = await env.RECORDINGS.head(recording.r2_key);
  if (!existingObject) return null;
  const savedHash = existingObject.customMetadata?.sha256 ?? "";
  const matches = savedHash === headers.checksum && Number(existingObject.size) === headers.contentLength;
  if (!matches) throw new ApiError(409, "recording_object_conflict", "A different recording already exists for this attempt");
  return finalizeRecordingObject(env, recording, headers, existingObject, session, true);
}

export async function uploadRecording(request, env, attemptUuidInput) {
  requireMethod(request, ["PUT"]);
  const session = await requireSession(request, env);
  const attemptUuid = requireUuid(attemptUuidInput, "attempt_id");
  const declaredHeaders = validateRecordingHeaders(request, env);
  const recording = await env.DB.prepare(`
    SELECT
      r.*, tm.visit_uuid, tm.trial_uuid, tm.canonical_attempt_uuid,
      tm.expects_recording, tm.segment, ta.state AS attempt_state, ta.payload_json
    FROM recordings r
    JOIN trial_attempts ta ON ta.attempt_uuid = r.attempt_uuid
    JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
    WHERE r.attempt_uuid = ? LIMIT 1
  `).bind(attemptUuid).first();
  if (!recording || recording.visit_uuid !== session.visit_uuid) {
    throw new ApiError(404, "recording_not_found", "Recording attempt was not found in this visit");
  }
  if (!recording.expects_recording || recording.attempt_state !== "response_saved") {
    throw new ApiError(409, "recording_not_ready", "The behavioral response must be accepted before its recording");
  }
  if (recording.canonical_attempt_uuid !== attemptUuid) {
    throw new ApiError(409, "recording_not_canonical", "Only the accepted attempt recording may be uploaded");
  }
  if (!request.body) throw new ApiError(400, "recording_body_required", "Recording body is empty");
  const bytes = await readBoundedBytes(request, declaredHeaders.maximum);
  if (declaredHeaders.declaredContentLength !== null
      && declaredHeaders.declaredContentLength !== bytes.byteLength) {
    throw new ApiError(400, "recording_length_mismatch", "Content-Length does not match the uploaded recording");
  }
  const wav = validatePcmWav(bytes, recording.segment);
  let responsePayload;
  try {
    responsePayload = JSON.parse(recording.payload_json);
  } catch {
    throw new ApiError(500, "response_payload_invalid", "Stored response payload is invalid");
  }
  if (wav.sampleRate !== responsePayload.sample_rate_hz
      || wav.sampleCount !== responsePayload.sample_count
      || Math.abs(wav.durationSeconds - responsePayload.duration_seconds) > 0.01) {
    throw new ApiError(422, "recording_payload_mismatch", "WAV data do not match the accepted response metadata", {
      wav_sample_rate_hz: wav.sampleRate,
      wav_sample_count: wav.sampleCount,
      wav_duration_seconds: wav.durationSeconds,
    });
  }
  const serverQuality = analyzePcm16(
    bytes,
    wav,
    recordingAnalysisStartSeconds(responsePayload, recording.segment),
  );
  assertRecordingQualityMatches(responsePayload, serverQuality);
  wav.quality = serverQuality;
  const actualChecksum = await sha256Hex(bytes);
  if (actualChecksum !== declaredHeaders.checksum) {
    throw new ApiError(400, "recording_checksum_mismatch", "Recording checksum does not match its contents");
  }
  const headers = {
    contentType: declaredHeaders.contentType,
    contentLength: bytes.byteLength,
    checksum: actualChecksum,
    wav,
    crc32: crc32(bytes),
  };
  const duplicate = await recordingDuplicateOrConflict(env, recording, headers, session);
  if (duplicate) return duplicate;
  const nowMs = Date.now();
  const received = await env.DB.prepare(`
    UPDATE recordings SET received_at_ms = COALESCE(received_at_ms, ?), updated_at_ms = ?
    WHERE attempt_uuid = ? AND state = 'pending'
      AND EXISTS (
        SELECT 1 FROM sessions active_session
        JOIN visits active_visit ON active_visit.visit_uuid = active_session.visit_uuid
        WHERE active_session.session_uuid = ?
          AND active_session.status = 'active'
          AND active_session.epoch = active_visit.active_session_epoch
          AND active_visit.visit_uuid = ?
          AND active_visit.status NOT IN ('completed', 'withdrawn')
      )
  `).bind(nowMs, nowMs, attemptUuid, session.session_uuid, session.visit_uuid).run();
  if (Number(received.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "session_superseded", "Recording upload session is no longer active");
  }
  const object = await env.RECORDINGS.put(recording.r2_key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: headers.checksum,
    httpMetadata: { contentType: "audio/wav", cacheControl: "private, no-store" },
    customMetadata: {
      sha256: headers.checksum,
      attempt_uuid: attemptUuid,
      trial_uuid: recording.trial_uuid,
      visit_type: session.visit_type,
      sample_rate_hz: String(wav.sampleRate),
      sample_count: String(wav.sampleCount),
      duration_seconds: String(wav.durationSeconds),
      analysis_start_seconds: String(wav.quality.analysisStartSeconds),
      analyzed_sample_count: String(wav.quality.analyzedSampleCount),
      rms_amplitude: String(wav.quality.rmsAmplitude),
      peak_amplitude: String(wav.quality.peakAmplitude),
      clipping_ratio: String(wav.quality.clippingRatio),
      crc32: String(headers.crc32),
    },
  });
  if (object === null) {
    const raced = await recordingDuplicateOrConflict(env, recording, headers, session);
    if (raced) return raced;
    throw new ApiError(409, "recording_upload_conflict", "Recording upload precondition failed");
  }
  return finalizeRecordingObject(env, recording, headers, object, session, false);
}

export async function saveEvents(request, env) {
  requireMethod(request, ["POST"]);
  const session = await requireSession(request, env);
  const body = await readJson(request, 262_144);
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
    throw new ApiError(400, "invalid_event_batch", "events must contain between 1 and 50 entries");
  }
  const nowMs = Date.now();
  const records = await Promise.all(body.events.map(async (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new ApiError(400, "invalid_event", "Each event must be an object");
    }
    const eventUuid = requireUuid(event.event_id, "event_id");
    const eventType = String(event.type ?? "");
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new ApiError(400, "invalid_event_type", "Event type is not allowed");
    }
    const trialUuid = event.trial_id ? requireUuid(event.trial_id, "trial_id") : null;
    const attemptUuid = event.attempt_id ? requireUuid(event.attempt_id, "attempt_id") : null;
    const clientEventAtMs = Number(event.client_event_at_ms);
    const payloadJson = stableJson(event.payload ?? {});
    const payloadHash = await sha256Hex(stableJson({
      event_type: eventType,
      trial_uuid: trialUuid,
      attempt_uuid: attemptUuid,
      client_event_at_ms: Number.isFinite(clientEventAtMs) ? clientEventAtMs : null,
      payload: event.payload ?? {},
    }));
    return {
      eventUuid,
      eventType,
      trialUuid,
      attemptUuid,
      clientEventAtMs: Number.isFinite(clientEventAtMs) ? clientEventAtMs : null,
      payloadJson,
      payloadHash,
    };
  }));

  const trialIds = [...new Set(records.map((record) => record.trialUuid).filter(Boolean))];
  const attemptIds = [...new Set(records.map((record) => record.attemptUuid).filter(Boolean))];
  const validTrials = new Set();
  if (trialIds.length) {
    const placeholders = trialIds.map(() => "?").join(",");
    const result = await env.DB.prepare(`
      SELECT trial_uuid FROM trial_manifest
      WHERE visit_uuid = ? AND trial_uuid IN (${placeholders})
    `).bind(session.visit_uuid, ...trialIds).all();
    result.results.forEach((row) => validTrials.add(row.trial_uuid));
  }
  const validAttempts = new Map();
  if (attemptIds.length) {
    const placeholders = attemptIds.map(() => "?").join(",");
    const result = await env.DB.prepare(`
      SELECT ta.attempt_uuid, ta.trial_uuid
      FROM trial_attempts ta
      JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
      WHERE tm.visit_uuid = ? AND ta.attempt_uuid IN (${placeholders})
    `).bind(session.visit_uuid, ...attemptIds).all();
    result.results.forEach((row) => validAttempts.set(row.attempt_uuid, row.trial_uuid));
  }
  records.forEach((record) => {
    if (record.trialUuid && !validTrials.has(record.trialUuid)) {
      throw new ApiError(403, "event_trial_forbidden", "Event trial does not belong to this visit");
    }
    if (record.attemptUuid && !validAttempts.has(record.attemptUuid)) {
      throw new ApiError(403, "event_attempt_forbidden", "Event attempt does not belong to this visit");
    }
    if (record.trialUuid && record.attemptUuid
        && validAttempts.get(record.attemptUuid) !== record.trialUuid) {
      throw new ApiError(422, "event_reference_mismatch", "Event attempt does not belong to its trial");
    }
  });

  const statements = records.map((record) => env.DB.prepare(`
      INSERT OR IGNORE INTO events (
        event_uuid, visit_uuid, session_uuid, trial_uuid, attempt_uuid,
        event_type, client_event_at_ms, server_received_at_ms, payload_hash, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      record.eventUuid,
      session.visit_uuid,
      session.session_uuid,
      record.trialUuid,
      record.attemptUuid,
      record.eventType,
      record.clientEventAtMs,
      nowMs,
      record.payloadHash,
      record.payloadJson,
    ));
  await env.DB.batch(statements);
  const placeholders = records.map(() => "?").join(",");
  const stored = await env.DB.prepare(`
    SELECT event_uuid, payload_hash FROM events WHERE event_uuid IN (${placeholders})
  `).bind(...records.map((record) => record.eventUuid)).all();
  const storedHashes = new Map(stored.results.map((row) => [row.event_uuid, row.payload_hash]));
  for (const record of records) {
    if (storedHashes.get(record.eventUuid) !== record.payloadHash) {
      throw new ApiError(409, "event_idempotency_conflict", "Event ID was already used with different content");
    }
  }
  return jsonResponse({ ok: true, accepted: records.length, server_received_at_ms: nowMs });
}

export async function completeVisit(request, env) {
  requireMethod(request, ["POST"]);
  const session = await requireSession(request, env, { allowCompleted: true });
  const completionPayload = async (finalizedAtMs) => {
    const intervals = session.visit_type === "delayed"
      ? await env.DB.prepare(`
          SELECT retention_interval_ms, target_deviation_ms
          FROM analysis_intervals WHERE participant_uuid = ? LIMIT 1
        `).bind(session.participant_uuid).first()
      : null;
    return {
      ok: true,
      visit_type: session.visit_type,
      finalized_at_ms: Number(finalizedAtMs),
      retention_interval_ms: intervals?.retention_interval_ms ?? null,
      target_deviation_ms: intervals?.target_deviation_ms ?? null,
    };
  };
  const completeness = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN tm.canonical_attempt_uuid IS NULL THEN 1 ELSE 0 END) AS missing_responses,
      SUM(CASE WHEN tm.expects_recording = 1 AND COALESCE(r.state, 'missing') != 'uploaded' THEN 1 ELSE 0 END) AS missing_recordings
    FROM trial_manifest tm
    LEFT JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
    WHERE tm.visit_uuid = ?
  `).bind(session.visit_uuid).first();
  const missingResponses = Number(completeness?.missing_responses ?? 0);
  const missingRecordings = Number(completeness?.missing_recordings ?? 0);
  if (session.visit_status === "completed" && session.finalized_at_ms !== null) {
    return jsonResponse({ ...(await completionPayload(session.finalized_at_ms)), duplicate: true });
  }
  if (missingResponses > 0 || missingRecordings > 0) {
    throw new ApiError(409, "visit_incomplete", "Visit cannot be finalized while data are missing", {
      missing_responses: missingResponses,
      missing_recordings: missingRecordings,
    });
  }
  const nowMs = Date.now();
  const statements = [
    env.DB.prepare(`
      UPDATE visits SET status = 'completed', finalized_at_ms = COALESCE(finalized_at_ms, ?), updated_at_ms = ?
      WHERE visit_uuid = ? AND status != 'completed'
        AND EXISTS (
          SELECT 1 FROM sessions active_session
          WHERE active_session.session_uuid = ?
            AND active_session.visit_uuid = visits.visit_uuid
            AND active_session.status = 'active'
            AND active_session.epoch = visits.active_session_epoch
        )
    `).bind(nowMs, nowMs, session.visit_uuid, session.session_uuid),
    env.DB.prepare(`
      UPDATE sessions SET status = 'closed', closed_at_ms = ?
      WHERE session_uuid = ? AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM visits finalized
          WHERE finalized.visit_uuid = sessions.visit_uuid
            AND finalized.finalized_at_ms = ?
        )
    `).bind(nowMs, session.session_uuid, nowMs),
    env.DB.prepare(`
      UPDATE invitations SET status = 'closed', closed_at_ms = ?
      WHERE visit_uuid = ? AND status = 'active'
        AND EXISTS (
          SELECT 1 FROM visits finalized
          WHERE finalized.visit_uuid = invitations.visit_uuid
            AND finalized.finalized_at_ms = ?
        )
    `).bind(nowMs, session.visit_uuid, nowMs),
    env.DB.prepare(`
      INSERT INTO audit_log (
        audit_uuid, actor_type, action, participant_uuid, visit_uuid, server_at_ms, details_json
      )
      SELECT ?, 'system', 'visit_completed', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM visits finalized
        WHERE finalized.visit_uuid = ? AND finalized.finalized_at_ms = ?
      )
    `).bind(
      crypto.randomUUID(),
      session.participant_uuid,
      session.visit_uuid,
      nowMs,
      stableJson({ visit_type: session.visit_type }),
      session.visit_uuid,
      nowMs,
    ),
  ];
  if (session.visit_type === "delayed") {
    statements.push(env.DB.prepare(`
      UPDATE participants SET status = 'completed', updated_at_ms = ?
      WHERE participant_uuid = ?
        AND EXISTS (
          SELECT 1 FROM visits finalized
          WHERE finalized.participant_uuid = participants.participant_uuid
            AND finalized.visit_type = 'delayed'
            AND finalized.finalized_at_ms = ?
        )
    `).bind(nowMs, session.participant_uuid, nowMs));
  }
  try {
    const results = await env.DB.batch(statements);
    if (Number(results[0]?.meta?.changes ?? 0) === 1) {
      return jsonResponse({ ...(await completionPayload(nowMs)), duplicate: false });
    }
  } catch (error) {
    const completed = await env.DB.prepare(`
      SELECT status, finalized_at_ms FROM visits WHERE visit_uuid = ? LIMIT 1
    `).bind(session.visit_uuid).first();
    if (completed?.status === "completed" && completed.finalized_at_ms !== null) {
      return jsonResponse({ ...(await completionPayload(completed.finalized_at_ms)), duplicate: true });
    }
    throw error;
  }
  const completed = await env.DB.prepare(`
    SELECT status, finalized_at_ms FROM visits WHERE visit_uuid = ? LIMIT 1
  `).bind(session.visit_uuid).first();
  if (completed?.status === "completed" && completed.finalized_at_ms !== null) {
    return jsonResponse({ ...(await completionPayload(completed.finalized_at_ms)), duplicate: true });
  }
  throw new ApiError(409, "session_superseded", "This visit session was superseded before completion");
}

export async function serveStimulus(request, env, trialUuidInput, kind) {
  requireMethod(request, ["GET"]);
  const session = await requireSession(request, env);
  const trialUuid = requireUuid(trialUuidInput, "trial_id");
  if (!new Set(["audio", "image"]).has(kind)) {
    throw new ApiError(404, "stimulus_not_found", "Stimulus type was not found");
  }
  const column = kind === "audio" ? "audio_key" : "image_key";
  const trial = await env.DB.prepare(`
    SELECT current.${column} AS object_key, current.placeholder_asset, current.item_gloss
    FROM trial_manifest current
    WHERE current.trial_uuid = ? AND current.visit_uuid = ?
      AND current.canonical_attempt_uuid IS NULL
      AND (
        current.ordinal = (
          SELECT MIN(next.ordinal) FROM trial_manifest next
          WHERE next.visit_uuid = current.visit_uuid AND next.canonical_attempt_uuid IS NULL
        )
        OR (
          current.ordinal = 1 + (
            SELECT MIN(next.ordinal) FROM trial_manifest next
            WHERE next.visit_uuid = current.visit_uuid AND next.canonical_attempt_uuid IS NULL
          )
          AND EXISTS (
            SELECT 1
            FROM trial_manifest active_trial
            JOIN trial_attempts active_attempt ON active_attempt.trial_uuid = active_trial.trial_uuid
            WHERE active_trial.visit_uuid = current.visit_uuid
              AND active_trial.canonical_attempt_uuid IS NULL
              AND active_trial.ordinal = current.ordinal - 1
              AND active_trial.segment = current.segment
              AND active_attempt.session_uuid = ?
              AND active_attempt.state = 'started'
          )
        )
      )
    LIMIT 1
  `).bind(trialUuid, session.visit_uuid, session.session_uuid).first();
  if (!trial) {
    throw new ApiError(409, "stimulus_not_current", "Only the current stimulus or its one-ahead preload is available");
  }
  if (!trial.object_key) throw new ApiError(404, "stimulus_not_found", "Stimulus is not defined for this trial");
  if (Number(trial.placeholder_asset) === 1) {
    const configuration = collectionConfiguration(env);
    if (!placeholderAssetsAllowed(env) || configuration.production) {
      throw new ApiError(503, "placeholder_assets_disabled", "Placeholder assets are disabled for this deployment");
    }
  }
  const object = await env.STIMULI.get(trial.object_key);
  if (!object) {
    if (kind === "audio" && Number(trial.placeholder_asset) === 1) {
      const fileName = String(trial.object_key).split("/").at(-1);
      if (/^[a-z]+\.wav$/u.test(fileName)) {
        const fallbackUrl = new URL(`/placeholder-audio/${fileName}`, request.url);
        const fallback = await env.ASSETS.fetch(new Request(fallbackUrl, request));
        if (fallback.ok) {
          const fallbackHeaders = new Headers(fallback.headers);
          fallbackHeaders.set("Cache-Control", "private, no-store");
          fallbackHeaders.set("Referrer-Policy", "no-referrer");
          fallbackHeaders.set("X-Content-Type-Options", "nosniff");
          return new Response(fallback.body, { status: fallback.status, headers: fallbackHeaders });
        }
      }
    }
    if (kind === "image" && Number(trial.placeholder_asset) === 1) {
      const escapedGloss = String(trial.item_gloss)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" rx="28" fill="#f7faf8"/><rect x="24" y="24" width="1152" height="752" rx="22" fill="none" stroke="#8fa39a" stroke-width="6" stroke-dasharray="18 14"/><text x="600" y="300" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#596963">画像プレースホルダー</text><text x="600" y="475" text-anchor="middle" font-family="sans-serif" font-size="96" font-weight="800" fill="#17211e">${escapedGloss}</text></svg>`;
      return new Response(svg, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    throw new ApiError(503, "stimulus_asset_missing", "The stimulus file has not been uploaded", {
      placeholder_asset: Boolean(trial.placeholder_asset),
    });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // Storage metadata is not trusted to loosen the participant-facing privacy policy.
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", kind === "audio" ? "audio/wav" : "image/webp");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}
