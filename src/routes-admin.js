import { buildParticipantDesign, canonicalParticipantId } from "./lib/manifest.js";
import { insertParticipantDesign, findParticipantByNumericId } from "./lib/db.js";
import { randomToken, sha256Hex, stableJson } from "./lib/crypto.js";
import { ApiError, jsonResponse, readJson, requireMethod, requireUuid } from "./lib/http.js";
import { requireAdmin } from "./lib/auth.js";
import { collectionConfiguration } from "./lib/config.js";

function assertProductionCollectionSafe(env) {
  const configuration = collectionConfiguration(env);
  if (configuration.blocked) {
    throw new ApiError(
      503,
      "production_placeholder_blocked",
      "Production participant creation and invitation issuance are blocked while placeholder assets are configured",
      {
        asset_version: env.ASSET_VERSION,
        assignment_version: env.ASSIGNMENT_VERSION,
        allow_placeholder_assets: configuration.placeholderAllowed,
      },
    );
  }
}

async function visitForIssue(db, visitUuid) {
  return db.prepare(`
    SELECT v.*, p.numeric_id
    FROM visits v JOIN participants p ON p.participant_uuid = v.participant_uuid
    WHERE v.visit_uuid = ? LIMIT 1
  `).bind(visitUuid).first();
}

async function issueInvitation(env, requestUrl, visitUuid, nowMs) {
  assertProductionCollectionSafe(env);
  const visit = await visitForIssue(env.DB, visitUuid);
  if (!visit) throw new ApiError(404, "visit_not_found", "Visit was not found");
  if (["completed", "withdrawn"].includes(visit.status)) {
    throw new ApiError(409, "visit_closed", "Cannot issue an invitation for a closed visit");
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
      throw new ApiError(409, "delayed_not_available", "The seven-day target has not been reached", {
        available_at_ms: visit.available_at_ms,
        server_now_ms: nowMs,
      });
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
    const inserted = await insertParticipantDesign(env.DB, design, Date.now());
    participant = inserted.participant;
    created = !inserted.existing;
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
      pre_visit_id: participant.pre_visit_uuid,
      immediate_visit_id: participant.immediate_visit_uuid,
      delayed_visit_id: participant.delayed_visit_uuid,
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
  const result = await env.DB.prepare(`
    UPDATE invitations SET status = 'revoked', revoked_at_ms = ?
    WHERE invite_uuid = ? AND status = 'active'
  `).bind(nowMs, inviteUuid).run();
  if (Number(result.meta.changes ?? 0) === 0) {
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
      MAX(i.issued_at_ms) AS last_invited_at_ms,
      (
        SELECT COUNT(*)
        FROM visits immediate_visit
        JOIN trial_manifest tm ON tm.visit_uuid = immediate_visit.visit_uuid
        LEFT JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
        WHERE immediate_visit.participant_uuid = v.participant_uuid
          AND immediate_visit.visit_type = 'immediate'
          AND tm.expects_recording = 1
          AND COALESCE(r.state, 'missing') != 'uploaded'
      ) AS immediate_missing_recordings
    FROM visits v
    JOIN participants p ON p.participant_uuid = v.participant_uuid
    LEFT JOIN invitations i ON i.visit_uuid = v.visit_uuid
    WHERE v.visit_type = 'delayed'
      AND v.status IN ('scheduled', 'invited', 'started')
      AND v.available_at_ms IS NOT NULL
      AND v.available_at_ms <= ?
    GROUP BY v.visit_uuid, p.numeric_id, v.target_at_ms, v.available_at_ms, v.status
    ORDER BY v.target_at_ms, p.numeric_id
  `).bind(nowMs).all();
  return jsonResponse({ ok: true, server_now_ms: nowMs, visits: result.results });
}

export async function adminSummary(request, env) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const [participants, visits, recordings] = await Promise.all([
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM participants GROUP BY status`).all(),
    env.DB.prepare(`SELECT visit_type, status, COUNT(*) AS count FROM visits GROUP BY visit_type, status`).all(),
    env.DB.prepare(`SELECT state, COUNT(*) AS count FROM recordings GROUP BY state`).all(),
  ]);
  return jsonResponse({
    ok: true,
    server_now_ms: Date.now(),
    participants: participants.results,
    visits: visits.results,
    recordings: recordings.results,
  });
}
