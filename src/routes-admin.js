import { buildParticipantDesign, canonicalParticipantId } from "./lib/manifest.js";
import { insertParticipantDesign, findParticipantByNumericId } from "./lib/db.js";
import { randomToken, sha256Hex, stableJson } from "./lib/crypto.js";
import { ApiError, jsonResponse, readJson, requireMethod, requireUuid } from "./lib/http.js";
import { requireAdmin } from "./lib/auth.js";
import { collectionConfiguration } from "./lib/config.js";
import { DELAY_MINIMUM_DAYS } from "./lib/protocol.js";
import {
  ParticipantIdentityError,
  createParticipantIdentityBinding,
  participantIdentityVerifierEqual,
} from "./lib/participant-identity.js";

function assertProductionCollectionSafe(env) {
  const configuration = collectionConfiguration(env);
  if (configuration.blocked) {
    throw new ApiError(
      503,
      "production_collection_blocked",
      "Production participant creation and invitation issuance require real assets, an explicit supported test-token policy, and recipient verification",
      {
        asset_version: env.ASSET_VERSION,
        assignment_version: env.ASSIGNMENT_VERSION,
        allow_placeholder_assets: configuration.placeholderAllowed,
        placeholder_assets: configuration.placeholder,
        test_token_policy: configuration.testTokenPolicy,
        test_token_policy_ready: configuration.tokenPolicyReady,
        admin_authentication_ready: configuration.adminAuthenticationReady,
        randomization_ready: configuration.randomizationReady,
        identity_verification_ready: configuration.identityVerificationReady,
        secrets_independent: configuration.secretsIndependent,
      },
    );
  }
}

async function visitForIssue(db, visitUuid) {
  return db.prepare(`
    SELECT v.*, p.numeric_id, p.status AS participant_status,
      pib.verifier_hex AS identity_verifier_hex
    FROM visits v JOIN participants p ON p.participant_uuid = v.participant_uuid
    LEFT JOIN participant_identity_bindings pib
      ON pib.participant_uuid = p.participant_uuid
    WHERE v.visit_uuid = ? LIMIT 1
  `).bind(visitUuid).first();
}

function mapIdentityError(error) {
  if (!(error instanceof ParticipantIdentityError)) throw error;
  if (error.code === "identity_secret_unconfigured") {
    throw new ApiError(503, "identity_verification_unconfigured", "Participant identity verification is not configured");
  }
  throw new ApiError(400, error.code, error.message);
}

async function identityBindingFor(env, participantUuid, numericId, participantName) {
  try {
    return await createParticipantIdentityBinding({
      identitySecret: env.IDENTITY_SECRET,
      participantUuid,
      participantId: numericId,
      participantName,
    });
  } catch (error) {
    return mapIdentityError(error);
  }
}

async function bindOrVerifyExistingIdentity(env, participant, numericId, participantName, nowMs) {
  const proposed = await identityBindingFor(
    env,
    participant.participant_uuid,
    numericId,
    participantName,
  );
  if (participant.identity_verifier_hex) {
    const matches = participant.identity_normalization_version === proposed.normalization_version
      && participant.identity_verifier_version === proposed.verifier_version
      && await participantIdentityVerifierEqual(
        participant.identity_verifier_hex,
        proposed.verifier_hex,
      );
    if (!matches) {
      throw new ApiError(409, "participant_binding_mismatch", "Participant ID and name do not match the registered recipient");
    }
    return participant;
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO participant_identity_bindings (
          participant_uuid, verifier_hex, normalization_version, verifier_version,
          created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).bind(
        participant.participant_uuid,
        proposed.verifier_hex,
        proposed.normalization_version,
        proposed.verifier_version,
        nowMs,
      ),
      env.DB.prepare(`
        INSERT INTO audit_log (
          audit_uuid, actor_type, action, participant_uuid, server_at_ms, details_json
        ) VALUES (?, 'admin', 'participant_identity_registered', ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        participant.participant_uuid,
        nowMs,
        stableJson({ normalization_version: proposed.normalization_version }),
      ),
    ]);
  } catch {
    const raced = await findParticipantByNumericId(env.DB, numericId);
    if (!raced?.identity_verifier_hex
        || raced.identity_normalization_version !== proposed.normalization_version
        || raced.identity_verifier_version !== proposed.verifier_version
        || !(await participantIdentityVerifierEqual(raced.identity_verifier_hex, proposed.verifier_hex))) {
      throw new ApiError(409, "participant_binding_mismatch", "Participant ID and name do not match the registered recipient");
    }
    return raced;
  }
  return findParticipantByNumericId(env.DB, numericId);
}

async function issueInvitation(env, requestUrl, visitUuid, nowMs) {
  assertProductionCollectionSafe(env);
  const visit = await visitForIssue(env.DB, visitUuid);
  if (!visit) throw new ApiError(404, "visit_not_found", "Visit was not found");
  if (!visit.identity_verifier_hex) {
    throw new ApiError(409, "participant_identity_not_registered", "Register the participant recipient before issuing an invitation");
  }
  if (visit.participant_status === "withdrawn") {
    throw new ApiError(409, "participant_withdrawn", "Cannot issue an invitation after participation has ended");
  }
  if (["completed", "withdrawn"].includes(visit.status)) {
    throw new ApiError(409, "visit_closed", "Cannot issue an invitation for a closed visit");
  }
  const openInterruption = await env.DB.prepare(`
    SELECT mode, state FROM participation_interruptions
    WHERE participant_uuid = ? AND state IN ('requested', 'paused')
    ORDER BY requested_at_ms DESC LIMIT 1
  `).bind(visit.participant_uuid).first();
  if (openInterruption) {
    throw new ApiError(409, "participation_interruption_open", "Resolve the participant's pause or termination request before issuing another invitation");
  }
  if (visit.visit_type === "immediate") {
    const preVisit = await env.DB.prepare(`
      SELECT status FROM visits
      WHERE participant_uuid = ? AND visit_type = 'pre' LIMIT 1
    `).bind(visit.participant_uuid).first();
    if (preVisit?.status !== "completed") {
      throw new ApiError(409, "pre_not_completed", "Pre Picture Naming must be completed before the main experiment invitation is issued");
    }
  }
  if (visit.visit_type === "delayed") {
    const immediateVisit = await env.DB.prepare(`
      SELECT status FROM visits
      WHERE participant_uuid = ? AND visit_type = 'immediate' LIMIT 1
    `).bind(visit.participant_uuid).first();
    if (immediateVisit?.status !== "completed") {
      throw new ApiError(409, "immediate_not_completed", "The immediate visit must be completed before delayed invitation issuance");
    }
    if (visit.available_at_ms === null) {
      throw new ApiError(409, "delayed_not_scheduled", "Immediate testing must finish before delayed invitation issuance");
    }
    if (Number(visit.available_at_ms) > nowMs) {
      throw new ApiError(
        409,
        "delayed_not_available",
        `The ${DELAY_MINIMUM_DAYS}-day minimum has not been reached`,
        {
          available_at_ms: visit.available_at_ms,
          server_now_ms: nowMs,
        },
      );
    }
  }
  const generationRow = await env.DB.prepare(`
    SELECT COALESCE(MAX(generation), 0) + 1 AS generation
    FROM invitations WHERE visit_uuid = ?
  `).bind(visitUuid).first();
  const generation = Number(generationRow?.generation ?? 1);
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const inviteUuid = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE visits
      SET active_session_epoch = active_session_epoch + 1, updated_at_ms = ?
      WHERE visit_uuid = ?
        AND EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.visit_uuid = visits.visit_uuid AND sessions.status = 'active'
        )
    `).bind(nowMs, visitUuid),
    env.DB.prepare(`
      UPDATE sessions SET status = 'superseded', superseded_at_ms = ?
      WHERE visit_uuid = ? AND status = 'active'
    `).bind(nowMs, visitUuid),
    env.DB.prepare(`
      UPDATE invitations SET status = 'revoked', revoked_at_ms = ?
      WHERE visit_uuid = ? AND status = 'active'
    `).bind(nowMs, visitUuid),
    env.DB.prepare(`
      INSERT INTO invitations (
        invite_uuid, visit_uuid, generation, token_hash, status, issued_at_ms
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `).bind(inviteUuid, visitUuid, generation, tokenHash, nowMs),
    env.DB.prepare(`
      UPDATE visits
      SET status = CASE WHEN status IN ('planned', 'scheduled') THEN 'invited' ELSE status END,
          updated_at_ms = ?
      WHERE visit_uuid = ?
    `).bind(nowMs, visitUuid),
    env.DB.prepare(`
      INSERT INTO audit_log (
        audit_uuid, actor_type, action, participant_uuid, visit_uuid, server_at_ms, details_json
      ) VALUES (?, 'admin', 'invitation_issued', ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      visit.participant_uuid,
      visitUuid,
      nowMs,
      stableJson({ generation, visit_type: visit.visit_type }),
    ),
  ]);
  const origin = new URL(requestUrl).origin;
  const route = {
    pre: "/pre-picture-naming/",
    immediate: "/main-experiment/",
    delayed: "/delayed-picture-naming/",
  }[visit.visit_type];
  return {
    invite_id: inviteUuid,
    participant_id: visit.numeric_id,
    visit_id: visitUuid,
    visit_type: visit.visit_type,
    generation,
    invitation_url: `${origin}${route}#t=${rawToken}`,
    issued_at_ms: nowMs,
  };
}

export async function createParticipant(request, env) {
  requireMethod(request, ["POST"]);
  await requireAdmin(request, env);
  assertProductionCollectionSafe(env);
  const body = await readJson(request);
  let numericId;
  try {
    numericId = canonicalParticipantId(body.participant_id);
  } catch (error) {
    throw new ApiError(400, "invalid_participant_id", error.message);
  }
  if (!env.RANDOMIZATION_SECRET || String(env.RANDOMIZATION_SECRET).length < 24) {
    throw new ApiError(503, "randomization_unconfigured", "Randomization secret is not configured");
  }
  let participant = await findParticipantByNumericId(env.DB, numericId);
  let created = false;
  if (!participant) {
    const design = await buildParticipantDesign({
      participantId: numericId,
      assignmentVersion: env.ASSIGNMENT_VERSION,
      seedAlgorithmVersion: env.SEED_ALGORITHM_VERSION,
      assetVersion: env.ASSET_VERSION,
      randomizationSecret: env.RANDOMIZATION_SECRET,
    });
    const nowMs = Date.now();
    const identityBinding = await identityBindingFor(
      env,
      design.assignment.participantUuid,
      numericId,
      body.participant_name,
    );
    const inserted = await insertParticipantDesign(env.DB, design, identityBinding, nowMs);
    participant = await findParticipantByNumericId(env.DB, numericId);
    created = !inserted.existing;
    if (inserted.existing) {
      participant = await bindOrVerifyExistingIdentity(
        env,
        participant,
        numericId,
        body.participant_name,
        nowMs,
      );
    }
  } else {
    participant = await bindOrVerifyExistingIdentity(
      env,
      participant,
      numericId,
      body.participant_name,
      Date.now(),
    );
  }
  let invitation = null;
  if (body.issue_pre_invitation !== false) {
    invitation = await issueInvitation(env, request.url, participant.pre_visit_uuid, Date.now());
  }
  return jsonResponse({
    ok: true,
    created,
    participant: {
      participant_id: numericId,
      participant_uuid: participant.participant_uuid,
      training_accent: participant.training_accent,
      counterbalance_cell: Number(participant.counterbalance_cell),
      pre_visit_id: participant.pre_visit_uuid,
      immediate_visit_id: participant.immediate_visit_uuid,
      delayed_visit_id: participant.delayed_visit_uuid,
      identity_registered: true,
    },
    invitation,
  }, created ? 201 : 200);
}

export async function createInvitation(request, env, visitUuidInput) {
  requireMethod(request, ["POST"]);
  await requireAdmin(request, env);
  const visitUuid = requireUuid(visitUuidInput, "visit_id");
  const invitation = await issueInvitation(env, request.url, visitUuid, Date.now());
  return jsonResponse({ ok: true, invitation }, 201);
}

export async function revokeInvitation(request, env, inviteUuidInput) {
  requireMethod(request, ["POST"]);
  await requireAdmin(request, env);
  const inviteUuid = requireUuid(inviteUuidInput, "invite_id");
  const nowMs = Date.now();
  const openInterruption = await env.DB.prepare(`
    SELECT pi.mode, pi.state
    FROM invitations i
    JOIN visits v ON v.visit_uuid = i.visit_uuid
    JOIN participation_interruptions pi ON pi.participant_uuid = v.participant_uuid
    WHERE i.invite_uuid = ? AND pi.state IN ('requested', 'paused')
    LIMIT 1
  `).bind(inviteUuid).first();
  if (openInterruption) {
    throw new ApiError(409, "participation_interruption_open", "Do not revoke an invitation while participant data are draining or paused");
  }
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE visits
      SET active_session_epoch = active_session_epoch + 1, updated_at_ms = ?
      WHERE visit_uuid = (
        SELECT visit_uuid FROM invitations WHERE invite_uuid = ? AND status = 'active'
      )
        AND EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.visit_uuid = visits.visit_uuid AND sessions.status = 'active'
        )
    `).bind(nowMs, inviteUuid),
    env.DB.prepare(`
      UPDATE sessions SET status = 'superseded', superseded_at_ms = ?
      WHERE status = 'active'
        AND visit_uuid = (
          SELECT visit_uuid FROM invitations WHERE invite_uuid = ? AND status = 'active'
        )
    `).bind(nowMs, inviteUuid),
    env.DB.prepare(`
      UPDATE invitations SET status = 'revoked', revoked_at_ms = ?
      WHERE invite_uuid = ? AND status = 'active'
    `).bind(nowMs, inviteUuid),
  ]);
  if (Number(results[2]?.meta?.changes ?? 0) === 0) {
    throw new ApiError(404, "active_invitation_not_found", "Active invitation was not found");
  }
  return jsonResponse({ ok: true, invite_id: inviteUuid, revoked_at_ms: nowMs });
}

export async function listDueDelayed(request, env) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const nowMs = Date.now();
  const result = await env.DB.prepare(`
    SELECT
      v.visit_uuid, p.numeric_id, v.target_at_ms, v.available_at_ms, v.status,
      MAX(i.issued_at_ms) AS last_invited_at_ms
    FROM visits v
    JOIN participants p ON p.participant_uuid = v.participant_uuid
    JOIN visits immediate_visit
      ON immediate_visit.participant_uuid = v.participant_uuid
      AND immediate_visit.visit_type = 'immediate'
      AND immediate_visit.status = 'completed'
    LEFT JOIN invitations i ON i.visit_uuid = v.visit_uuid
    WHERE v.visit_type = 'delayed'
      AND p.status = 'active'
      AND v.status IN ('scheduled', 'invited', 'started')
      AND v.available_at_ms IS NOT NULL
      AND v.available_at_ms <= ?
      AND NOT EXISTS (
        SELECT 1 FROM participation_interruptions pi
        WHERE pi.participant_uuid = p.participant_uuid
          AND pi.state IN ('requested', 'paused')
      )
    GROUP BY v.visit_uuid, p.numeric_id, v.target_at_ms, v.available_at_ms, v.status
    ORDER BY v.target_at_ms, p.numeric_id
  `).bind(nowMs).all();
  return jsonResponse({ ok: true, server_now_ms: nowMs, visits: result.results });
}

export async function adminSummary(request, env) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const [
    participants,
    visits,
    recordings,
    participantIdSpan,
    assignmentFlow,
    interruptions,
    recordingIntegrity,
  ] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM participants GROUP BY status`).all(),
    env.DB.prepare(`SELECT visit_type, status, COUNT(*) AS count FROM visits GROUP BY visit_type, status`).all(),
    env.DB.prepare(`SELECT state, COUNT(*) AS count FROM recordings GROUP BY state`).all(),
    env.DB.prepare(`
      SELECT
        COUNT(*) AS assigned_count,
        MIN(numeric_id) AS minimum_id,
        MAX(numeric_id) AS maximum_id,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE MAX(numeric_id) - MIN(numeric_id) + 1 - COUNT(*)
        END AS missing_ids_within_span,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE MAX(numeric_id) - COUNT(*)
        END AS missing_ids_through_maximum
      FROM participants
    `).first(),
    env.DB.prepare(`
      WITH invitation_progress AS (
        SELECT
          visit_uuid,
          1 AS issued,
          MAX(CASE WHEN first_redeemed_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS redeemed
        FROM invitations
        GROUP BY visit_uuid
      ), trial_progress AS (
        SELECT tm.visit_uuid, 1 AS first_trial
        FROM trial_attempts ta
        JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
        GROUP BY tm.visit_uuid
      ), participant_interruption_progress AS (
        SELECT
          participant_uuid,
          MAX(CASE WHEN mode = 'pause' THEN 1 ELSE 0 END) AS ever_paused,
          MAX(CASE WHEN mode = 'pause' AND state = 'paused' THEN 1 ELSE 0 END)
            AS currently_paused,
          MAX(CASE WHEN mode = 'terminate' AND state = 'terminated' THEN 1 ELSE 0 END)
            AS terminated
        FROM participation_interruptions
        GROUP BY participant_uuid
      )
      SELECT
        p.training_accent,
        p.counterbalance_cell,
        COUNT(*) AS assigned_count,
        SUM(COALESCE(participant_interruption.ever_paused, 0)) AS ever_paused_count,
        SUM(COALESCE(participant_interruption.currently_paused, 0))
          AS currently_paused_count,
        SUM(COALESCE(participant_interruption.terminated, 0)) AS terminated_count,
        SUM(COALESCE(pre_invitation.issued, 0)) AS pre_issued_count,
        SUM(COALESCE(pre_invitation.redeemed, 0)) AS pre_redeemed_count,
        SUM(COALESCE(pre_trial.first_trial, 0)) AS pre_first_trial_count,
        SUM(CASE WHEN pre.behavioral_completed_at_ms IS NOT NULL THEN 1 ELSE 0 END)
          AS pre_behavioral_completed_count,
        SUM(CASE WHEN pre.finalized_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS pre_finalized_count,
        SUM(COALESCE(immediate_invitation.issued, 0)) AS immediate_issued_count,
        SUM(COALESCE(immediate_invitation.redeemed, 0)) AS immediate_redeemed_count,
        SUM(COALESCE(immediate_trial.first_trial, 0)) AS immediate_first_trial_count,
        SUM(CASE WHEN immediate.behavioral_completed_at_ms IS NOT NULL THEN 1 ELSE 0 END)
          AS immediate_behavioral_completed_count,
        SUM(CASE WHEN immediate.finalized_at_ms IS NOT NULL THEN 1 ELSE 0 END)
          AS immediate_finalized_count,
        SUM(COALESCE(delayed_invitation.issued, 0)) AS delayed_issued_count,
        SUM(COALESCE(delayed_invitation.redeemed, 0)) AS delayed_redeemed_count,
        SUM(COALESCE(delayed_trial.first_trial, 0)) AS delayed_first_trial_count,
        SUM(CASE WHEN delayed.behavioral_completed_at_ms IS NOT NULL THEN 1 ELSE 0 END)
          AS delayed_behavioral_completed_count,
        SUM(CASE WHEN delayed.finalized_at_ms IS NOT NULL THEN 1 ELSE 0 END)
          AS delayed_finalized_count
      FROM participants p
      JOIN visits pre
        ON pre.participant_uuid = p.participant_uuid AND pre.visit_type = 'pre'
      JOIN visits immediate
        ON immediate.participant_uuid = p.participant_uuid AND immediate.visit_type = 'immediate'
      JOIN visits delayed
        ON delayed.participant_uuid = p.participant_uuid AND delayed.visit_type = 'delayed'
      LEFT JOIN invitation_progress pre_invitation ON pre_invitation.visit_uuid = pre.visit_uuid
      LEFT JOIN invitation_progress immediate_invitation ON immediate_invitation.visit_uuid = immediate.visit_uuid
      LEFT JOIN invitation_progress delayed_invitation ON delayed_invitation.visit_uuid = delayed.visit_uuid
      LEFT JOIN trial_progress pre_trial ON pre_trial.visit_uuid = pre.visit_uuid
      LEFT JOIN trial_progress immediate_trial ON immediate_trial.visit_uuid = immediate.visit_uuid
      LEFT JOIN trial_progress delayed_trial ON delayed_trial.visit_uuid = delayed.visit_uuid
      LEFT JOIN participant_interruption_progress participant_interruption
        ON participant_interruption.participant_uuid = p.participant_uuid
      GROUP BY p.training_accent, p.counterbalance_cell
      ORDER BY p.training_accent, p.counterbalance_cell
    `).all(),
    env.DB.prepare(`
      SELECT mode, state, COUNT(*) AS count
      FROM participation_interruptions
      GROUP BY mode, state
      ORDER BY mode, state
    `).all(),
    env.DB.prepare(`
      SELECT
        SUM(CASE
          WHEN r.state = 'pending'
            AND tm.canonical_attempt_uuid = r.attempt_uuid
            AND r.abandoned_at_ms IS NULL
          THEN 1 ELSE 0 END) AS canonical_pending_uploads,
        SUM(CASE
          WHEN r.abandoned_at_ms IS NOT NULL
            AND tm.canonical_attempt_uuid IS NOT r.attempt_uuid
          THEN 1 ELSE 0 END) AS noncanonical_abandoned_slots,
        SUM(CASE
          WHEN r.abandoned_at_ms IS NOT NULL
            AND tm.canonical_attempt_uuid = r.attempt_uuid
          THEN 1 ELSE 0 END) AS canonical_recordings_abandoned_after_termination
      FROM recordings r
      JOIN trial_attempts ta ON ta.attempt_uuid = r.attempt_uuid
      JOIN trial_manifest tm ON tm.trial_uuid = ta.trial_uuid
    `).first(),
  ]);
  return jsonResponse({
    ok: true,
    server_now_ms: Date.now(),
    participants: participants.results,
    visits: visits.results,
    recordings: recordings.results,
    recording_integrity: recordingIntegrity,
    participation_interruptions: interruptions.results,
    participant_id_span: participantIdSpan,
    assignment_flow: assignmentFlow.results,
  });
}
