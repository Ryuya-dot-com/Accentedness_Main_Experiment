import { canonicalCollectionParticipantId } from "./lib/manifest.js";
import { ApiError, jsonResponse, requireMethod } from "./lib/http.js";
import { requireAdmin } from "./lib/auth.js";
import { DELAY_MINIMUM_DAYS } from "./lib/protocol.js";

const VISIT_ROUTES = Object.freeze({
  pre: "/pre-picture-naming/",
  immediate: "/main-experiment/",
  delayed: "/delayed-picture-naming/",
});

const VISIT_ORDER = Object.freeze({ pre: 1, immediate: 2, delayed: 3 });

const ACTION_CATEGORIES = Object.freeze({
  start_pre: "ready",
  start_immediate: "ready",
  start_delayed: "ready",
  resume_pre: "in_progress",
  resume_immediate: "in_progress",
  resume_delayed: "in_progress",
  wait_delayed: "waiting",
  wait_pre_recording_upload: "waiting",
  wait_immediate_recording_upload: "waiting",
  wait_delayed_recording_upload: "waiting",
  complete: "completed",
  participation_ended: "ended",
});

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function nextAction(code, {
  visitType = null,
  reason,
  availableAtMs = null,
  path = null,
} = {}) {
  return {
    code,
    category: ACTION_CATEGORIES[code] ?? "attention",
    visit_type: visitType,
    path: path ?? null,
    reason,
    available_at_ms: nullableNumber(availableAtMs),
  };
}

function reviewState(reason = "inconsistent") {
  return nextAction("review_state", { reason, path: null });
}

function completedVisitIntegrityReason(visit) {
  if (visit.status !== "completed") return null;
  if (visit.finalized_at_ms === null) return `${visit.visit_type}_not_finalized`;
  if (visit.accepted_trials !== visit.expected_trials) {
    return `${visit.visit_type}_completed_trial_count_mismatch`;
  }
  if (visit.accepted_recording_trials !== visit.expected_recordings) {
    return `${visit.visit_type}_completed_recording_trial_count_mismatch`;
  }
  if (visit.pending_recordings > 0) return `${visit.visit_type}_completed_recording_pending`;
  if (visit.missing_recordings > 0) return `${visit.visit_type}_completed_recording_missing`;
  if (visit.abandoned_recordings > 0) return `${visit.visit_type}_completed_recording_abandoned`;
  if (visit.uploaded_recordings !== visit.expected_recordings) {
    return `${visit.visit_type}_completed_recording_upload_count_mismatch`;
  }
  return null;
}

function visitNextAction(visit) {
  if (!visit || !Object.hasOwn(VISIT_ROUTES, visit.visit_type)) return reviewState();
  const visitType = visit.visit_type;

  if (visit.missing_recordings > 0) return reviewState("canonical_recording_missing");
  if (visit.abandoned_recordings > 0) return reviewState("canonical_recording_abandoned");
  if (visit.pending_recordings > 0) {
    const behavioralComplete = visit.status === "awaiting_uploads"
      || visit.behavioral_completed_at_ms !== null;
    return nextAction(
      behavioralComplete
        ? `retry_${visitType}_uploads`
        : `wait_${visitType}_recording_upload`,
      {
        visitType,
        reason: behavioralComplete ? "recordings_pending" : "recording_upload_in_progress",
        path: null,
      },
    );
  }

  if (visit.status === "awaiting_uploads" || visit.behavioral_completed_at_ms !== null) {
    if (visit.status === "completed" || visit.finalized_at_ms !== null) return reviewState();
    if (visit.accepted_trials !== visit.expected_trials) {
      return reviewState("accepted_trial_count_incomplete");
    }
    if (visit.accepted_recording_trials !== visit.expected_recordings) {
      return reviewState("accepted_recording_trial_count_incomplete");
    }
    if (visit.uploaded_recordings !== visit.expected_recordings) {
      return reviewState("recording_upload_count_incomplete");
    }
    return nextAction(`finalize_${visitType}`, {
      visitType,
      reason: "finalization_pending",
      path: null,
    });
  }
  if (!["planned", "scheduled", "invited", "started"].includes(visit.status)) {
    return reviewState();
  }
  const started = visit.status === "started"
    || visit.first_started_at_ms !== null
    || visit.accepted_trials > 0;
  return nextAction(`${started ? "resume" : "start"}_${visitType}`, {
    visitType,
    reason: started ? "in_progress" : "not_started",
    path: VISIT_ROUTES[visitType],
  });
}

function participantNextAction(participant, serverNowMs) {
  if (participant.status === "withdrawn") {
    return nextAction("participation_ended", { reason: "withdrawn", path: null });
  }

  const visits = new Map(participant.visits.map((visit) => [visit.visit_type, visit]));
  if (visits.size !== 3 || !["pre", "immediate", "delayed"].every((type) => visits.has(type))) {
    return reviewState("visit_missing");
  }

  if (participant.open_interruption) {
    const interruption = participant.open_interruption;
    if (!visits.has(interruption.visit_type)) return reviewState("interruption_visit_missing");
    if (interruption.state === "requested") {
      return nextAction("finish_interruption", {
        visitType: interruption.visit_type,
        reason: "interruption_requested",
        path: null,
      });
    }
    if (interruption.mode === "pause" && interruption.state === "paused") {
      return nextAction("resume_paused_visit", {
        visitType: interruption.visit_type,
        reason: "paused",
        path: null,
      });
    }
    return reviewState("interruption_state_invalid");
  }

  const pre = visits.get("pre");
  const immediate = visits.get("immediate");
  const delayed = visits.get("delayed");
  for (const visit of [pre, immediate, delayed]) {
    const integrityReason = completedVisitIntegrityReason(visit);
    if (integrityReason) return reviewState(integrityReason);
  }
  if (immediate.status === "completed" && pre.status !== "completed") {
    return reviewState("immediate_completed_before_pre");
  }
  if (delayed.status === "completed" && immediate.status !== "completed") {
    return reviewState("delayed_completed_before_immediate");
  }
  if (participant.status === "completed" && delayed.status !== "completed") {
    return reviewState("participant_completed_early");
  }
  if (pre.status !== "completed") return visitNextAction(pre);

  if (immediate.status !== "completed") return visitNextAction(immediate);

  if (delayed.status === "completed") {
    if (participant.status !== "completed") {
      return reviewState("delayed_completed_participant_not_completed");
    }
    return nextAction("complete", { reason: "completed", path: null });
  }
  if (delayed.available_at_ms === null) return reviewState("delayed_not_scheduled");
  if (delayed.available_at_ms > serverNowMs) {
    return nextAction("wait_delayed", {
      visitType: "delayed",
      reason: "delayed_not_available",
      availableAtMs: delayed.available_at_ms,
      path: null,
    });
  }
  return visitNextAction(delayed);
}

function visitFromParticipantRow(row) {
  return {
    visit_type: row.visit_type,
    status: row.visit_status,
    target_at_ms: nullableNumber(row.target_at_ms),
    available_at_ms: nullableNumber(row.available_at_ms),
    first_started_at_ms: nullableNumber(row.first_started_at_ms),
    last_seen_at_ms: nullableNumber(row.last_seen_at_ms),
    behavioral_completed_at_ms: nullableNumber(row.behavioral_completed_at_ms),
    finalized_at_ms: nullableNumber(row.finalized_at_ms),
    accepted_trials: Number(row.accepted_trials ?? 0),
    expected_trials: Number(row.expected_trial_count),
    accepted_recording_trials: Number(row.accepted_recording_trials ?? 0),
    uploaded_recordings: Number(row.uploaded_recordings ?? 0),
    pending_recordings: Number(row.pending_recordings ?? 0),
    missing_recordings: Number(row.missing_recordings ?? 0),
    abandoned_recordings: Number(row.abandoned_recordings ?? 0),
    expected_recordings: Number(row.expected_recording_count),
    current_segment: null,
    segments: [],
  };
}

function segmentFromParticipantRow(row) {
  return {
    segment: row.segment,
    status: row.segment_status,
    accepted_trials: Number(row.segment_accepted_trials ?? 0),
    expected_trials: Number(row.segment_expected_trials ?? 0),
    started_at_ms: nullableNumber(row.segment_started_at_ms),
    completed_at_ms: nullableNumber(row.segment_completed_at_ms),
  };
}

function deriveCurrentSegment(visit) {
  if (visit.status === "completed" || visit.finalized_at_ms !== null) return null;
  const started = visit.segments.find((segment) => segment.status === "started");
  if (started) return started.segment;
  const visitStarted = visit.status === "started"
    || visit.status === "awaiting_uploads"
    || visit.first_started_at_ms !== null
    || visit.accepted_trials > 0;
  if (!visitStarted) return null;
  return visit.segments.find((segment) => segment.status !== "completed")?.segment ?? null;
}

export async function listParticipants(request, env) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  const serverNowMs = Date.now();
  const rows = await env.DB.prepare(`
    WITH visit_progress AS (
      SELECT
        v.visit_uuid, v.participant_uuid, v.visit_type, v.status,
        v.target_at_ms, v.available_at_ms, v.first_started_at_ms, v.last_seen_at_ms,
        v.behavioral_completed_at_ms, v.finalized_at_ms,
        v.expected_trial_count, v.expected_recording_count,
        SUM(CASE WHEN tm.canonical_attempt_uuid IS NOT NULL THEN 1 ELSE 0 END)
          AS accepted_trials,
        SUM(CASE
          WHEN tm.expects_recording = 1 AND tm.canonical_attempt_uuid IS NOT NULL
          THEN 1 ELSE 0 END) AS accepted_recording_trials,
        SUM(CASE
          WHEN tm.expects_recording = 1
            AND tm.canonical_attempt_uuid IS NOT NULL
            AND r.state = 'uploaded'
            AND r.abandoned_at_ms IS NULL
          THEN 1 ELSE 0 END) AS uploaded_recordings,
        SUM(CASE
          WHEN tm.expects_recording = 1
            AND tm.canonical_attempt_uuid IS NOT NULL
            AND r.state = 'pending'
            AND r.abandoned_at_ms IS NULL
          THEN 1 ELSE 0 END) AS pending_recordings,
        SUM(CASE
          WHEN tm.expects_recording = 1
            AND tm.canonical_attempt_uuid IS NOT NULL
            AND r.attempt_uuid IS NULL
          THEN 1 ELSE 0 END) AS missing_recordings,
        SUM(CASE
          WHEN tm.expects_recording = 1
            AND tm.canonical_attempt_uuid IS NOT NULL
            AND r.abandoned_at_ms IS NOT NULL
          THEN 1 ELSE 0 END) AS abandoned_recordings
      FROM visits v
      LEFT JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
      LEFT JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
      GROUP BY v.visit_uuid
    ), segment_progress AS (
      SELECT
        s.visit_uuid,
        s.segment,
        s.segment_order,
        s.status,
        s.started_at_ms,
        s.completed_at_ms,
        COUNT(tm.trial_uuid) AS expected_trials,
        SUM(CASE WHEN tm.canonical_attempt_uuid IS NOT NULL THEN 1 ELSE 0 END)
          AS accepted_trials
      FROM segments s
      LEFT JOIN trial_manifest tm
        ON tm.visit_uuid = s.visit_uuid AND tm.segment = s.segment
      GROUP BY s.visit_uuid, s.segment
    ), ranked_open_interruptions AS (
      SELECT
        pi.participant_uuid,
        v.visit_type AS interruption_visit_type,
        pi.mode AS interruption_mode,
        pi.state AS interruption_state,
        pi.requested_at_ms AS interruption_requested_at_ms,
        ROW_NUMBER() OVER (
          PARTITION BY pi.participant_uuid
          ORDER BY pi.requested_at_ms DESC, pi.interruption_uuid DESC
        ) AS interruption_rank
      FROM participation_interruptions pi
      JOIN visits v ON v.visit_uuid = pi.visit_uuid
      WHERE pi.state IN ('requested', 'paused')
    )
    SELECT
      p.numeric_id,
      p.status AS participant_status,
      p.created_at_ms AS participant_created_at_ms,
      p.updated_at_ms AS participant_updated_at_ms,
      vp.visit_type,
      vp.status AS visit_status,
      vp.target_at_ms,
      vp.available_at_ms,
      vp.first_started_at_ms,
      vp.last_seen_at_ms,
      vp.behavioral_completed_at_ms,
      vp.finalized_at_ms,
      vp.expected_trial_count,
      vp.expected_recording_count,
      vp.accepted_trials,
      vp.accepted_recording_trials,
      vp.uploaded_recordings,
      vp.pending_recordings,
      vp.missing_recordings,
      vp.abandoned_recordings,
      segment.segment,
      segment.segment_order,
      segment.status AS segment_status,
      segment.started_at_ms AS segment_started_at_ms,
      segment.completed_at_ms AS segment_completed_at_ms,
      segment.expected_trials AS segment_expected_trials,
      segment.accepted_trials AS segment_accepted_trials,
      interruption.interruption_visit_type,
      interruption.interruption_mode,
      interruption.interruption_state,
      interruption.interruption_requested_at_ms
    FROM participants p
    LEFT JOIN visit_progress vp ON vp.participant_uuid = p.participant_uuid
    LEFT JOIN segment_progress segment ON segment.visit_uuid = vp.visit_uuid
    LEFT JOIN ranked_open_interruptions interruption
      ON interruption.participant_uuid = p.participant_uuid
      AND interruption.interruption_rank = 1
    ORDER BY p.numeric_id,
      CASE vp.visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END,
      segment.segment_order
  `).all();

  const participantsById = new Map();
  for (const row of rows.results) {
    const participantId = Number(row.numeric_id);
    let record = participantsById.get(participantId);
    if (!record) {
      record = {
        visitsByType: new Map(),
        participant: {
          participant_id: participantId,
          status: row.participant_status,
          created_at_ms: Number(row.participant_created_at_ms),
          updated_at_ms: Number(row.participant_updated_at_ms),
          open_interruption: row.interruption_state ? {
            visit_type: row.interruption_visit_type,
            mode: row.interruption_mode,
            state: row.interruption_state,
            requested_at_ms: Number(row.interruption_requested_at_ms),
          } : null,
          visits: [],
        },
      };
      participantsById.set(participantId, record);
    }
    if (row.visit_type !== null && row.visit_type !== undefined) {
      let visit = record.visitsByType.get(row.visit_type);
      if (!visit) {
        visit = visitFromParticipantRow(row);
        record.visitsByType.set(row.visit_type, visit);
      }
      if (row.segment !== null && row.segment !== undefined) {
        visit.segments.push(segmentFromParticipantRow(row));
      }
    }
  }

  const participants = [...participantsById.values()].map((record) => {
    const { participant } = record;
    participant.visits = [...record.visitsByType.values()];
    participant.visits.sort(
      (left, right) => VISIT_ORDER[left.visit_type] - VISIT_ORDER[right.visit_type],
    );
    for (const visit of participant.visits) {
      visit.current_segment = deriveCurrentSegment(visit);
    }
    return {
      ...participant,
      next_action: participantNextAction(participant, serverNowMs),
    };
  });
  return jsonResponse({ ok: true, server_now_ms: serverNowMs, participants });
}

export async function getParticipantStatus(request, env, participantIdInput) {
  requireMethod(request, ["GET"]);
  await requireAdmin(request, env);
  let numericId;
  try {
    numericId = canonicalCollectionParticipantId(participantIdInput);
  } catch (error) {
    throw new ApiError(400, "invalid_participant_id", error.message);
  }
  const participant = await env.DB.prepare(`
    SELECT
      p.numeric_id, p.status, p.created_at_ms, p.updated_at_ms
    FROM participants p
    WHERE p.numeric_id = ? LIMIT 1
  `).bind(numericId).first();
  if (!participant) {
    throw new ApiError(404, "participant_not_found", "Participant was not found");
  }
  const visits = await env.DB.prepare(`
    SELECT
      v.visit_uuid, v.visit_type, v.status, v.target_at_ms, v.available_at_ms,
      v.first_started_at_ms, v.last_seen_at_ms, v.behavioral_completed_at_ms,
      v.finalized_at_ms, v.expected_trial_count, v.expected_recording_count,
      SUM(CASE WHEN tm.canonical_attempt_uuid IS NOT NULL THEN 1 ELSE 0 END) AS accepted_trials,
      SUM(CASE WHEN r.state = 'uploaded' THEN 1 ELSE 0 END) AS uploaded_recordings,
      SUM(CASE WHEN r.state = 'pending' THEN 1 ELSE 0 END) AS pending_recordings
    FROM visits v
    LEFT JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
    LEFT JOIN recordings r ON r.attempt_uuid = tm.canonical_attempt_uuid
    WHERE v.participant_uuid = (
      SELECT participant_uuid FROM participants WHERE numeric_id = ? LIMIT 1
    )
    GROUP BY v.visit_uuid
    ORDER BY CASE v.visit_type WHEN 'pre' THEN 1 WHEN 'immediate' THEN 2 ELSE 3 END
  `).bind(numericId).all();
  return jsonResponse({
    ok: true,
    participant: {
      participant_id: numericId,
      status: participant.status,
      created_at_ms: participant.created_at_ms,
      updated_at_ms: participant.updated_at_ms,
    },
    visits: visits.results.map((visit) => ({
      visit_id: visit.visit_uuid,
      visit_type: visit.visit_type,
      status: visit.status,
      target_at_ms: visit.target_at_ms,
      available_at_ms: visit.available_at_ms,
      first_started_at_ms: visit.first_started_at_ms,
      last_seen_at_ms: visit.last_seen_at_ms,
      behavioral_completed_at_ms: visit.behavioral_completed_at_ms,
      finalized_at_ms: visit.finalized_at_ms,
      accepted_trials: Number(visit.accepted_trials ?? 0),
      expected_trials: Number(visit.expected_trial_count),
      uploaded_recordings: Number(visit.uploaded_recordings ?? 0),
      pending_recordings: Number(visit.pending_recordings ?? 0),
      expected_recordings: Number(visit.expected_recording_count),
    })),
  });
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
