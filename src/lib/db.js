import { stableJson } from "./crypto.js";

const CANONICAL_ROUTES = Object.freeze({
  pre: Object.freeze({ picture_naming: "/pre-picture-naming/" }),
  immediate: Object.freeze({
    learning: "/main-experiment/",
    picture_naming: "/immediate-picture-naming/",
    l2_to_l1: "/immediate-l2-to-l1/",
  }),
  delayed: Object.freeze({
    picture_naming: "/delayed-picture-naming/",
    l2_to_l1: "/delayed-l2-to-l1/",
  }),
});

function trialInsertStatement(db, visitUuid, trial) {
  return db.prepare(`
    INSERT INTO trial_manifest (
      trial_uuid, visit_uuid, ordinal, segment, segment_ordinal, practice,
      exclude_from_analysis, item_id, item_word, item_gloss, list_id, list_rank,
      variability, exposure, cycle, learning_block, miniblock, test_accent,
      talker_id, audio_key, image_key, asset_version, placeholder_asset,
      expects_recording, trial_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    trial.trialUuid,
    visitUuid,
    trial.ordinal,
    trial.segment,
    trial.segmentOrdinal,
    trial.practice ? 1 : 0,
    trial.excludeFromAnalysis ? 1 : 0,
    trial.itemId,
    trial.itemWord,
    trial.itemGloss,
    trial.listId,
    trial.listRank,
    trial.variability,
    trial.exposure,
    trial.cycle,
    trial.learningBlock,
    trial.miniblock,
    trial.testAccent,
    trial.talkerId,
    trial.audioKey,
    trial.imageKey,
    trial.assetVersion,
    trial.placeholderAsset ? 1 : 0,
    trial.expectsRecording ? 1 : 0,
    stableJson(trial),
  );
}

export async function findParticipantByNumericId(db, numericId) {
  return db.prepare(`
    SELECT p.*, vp.visit_uuid AS pre_visit_uuid,
      vi.visit_uuid AS immediate_visit_uuid, vd.visit_uuid AS delayed_visit_uuid
    FROM participants p
    LEFT JOIN visits vp ON vp.participant_uuid = p.participant_uuid AND vp.visit_type = 'pre'
    LEFT JOIN visits vi ON vi.participant_uuid = p.participant_uuid AND vi.visit_type = 'immediate'
    LEFT JOIN visits vd ON vd.participant_uuid = p.participant_uuid AND vd.visit_type = 'delayed'
    WHERE p.numeric_id = ?
    LIMIT 1
  `).bind(numericId).first();
}

export async function insertParticipantDesign(db, design, nowMs) {
  const existing = await findParticipantByNumericId(db, design.assignment.numericId);
  if (existing) return { existing: true, participant: existing };

  const preVisitUuid = crypto.randomUUID();
  const immediateVisitUuid = crypto.randomUUID();
  const delayedVisitUuid = crypto.randomUUID();
  const assignment = design.assignment;
  const statements = [
    db.prepare(`
      INSERT INTO participants (
        participant_uuid, numeric_id, status, training_accent, within_accent_q,
        counterbalance_cycle, counterbalance_cell, list_cell, order_cell, talker_cell,
        assignment_version, seed_algorithm_version, root_seed_hex, asset_version,
        assignment_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      assignment.participantUuid,
      assignment.numericId,
      assignment.trainingAccent,
      assignment.withinAccentQ,
      assignment.counterbalanceCycle,
      assignment.counterbalanceCell,
      assignment.listCell,
      assignment.orderCell,
      assignment.talkerCell,
      assignment.assignmentVersion,
      assignment.seedAlgorithmVersion,
      assignment.rootSeedHex,
      assignment.assetVersion,
      stableJson(assignment),
      nowMs,
      nowMs,
    ),
    db.prepare(`
      INSERT INTO visits (
        visit_uuid, participant_uuid, visit_type, status, expected_trial_count,
        expected_recording_count, manifest_hash, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'pre', 'planned', ?, ?, ?, ?, ?)
    `).bind(
      preVisitUuid,
      assignment.participantUuid,
      design.pre.expectedTrialCount,
      design.pre.expectedRecordingCount,
      design.pre.manifestHash,
      nowMs,
      nowMs,
    ),
    db.prepare(`
      INSERT INTO visits (
        visit_uuid, participant_uuid, visit_type, status, expected_trial_count,
        expected_recording_count, manifest_hash, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'immediate', 'scheduled', ?, ?, ?, ?, ?)
    `).bind(
      immediateVisitUuid,
      assignment.participantUuid,
      design.immediate.expectedTrialCount,
      design.immediate.expectedRecordingCount,
      design.immediate.manifestHash,
      nowMs,
      nowMs,
    ),
    db.prepare(`
      INSERT INTO visits (
        visit_uuid, participant_uuid, visit_type, status, expected_trial_count,
        expected_recording_count, manifest_hash, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'delayed', 'scheduled', ?, ?, ?, ?, ?)
    `).bind(
      delayedVisitUuid,
      assignment.participantUuid,
      design.delayed.expectedTrialCount,
      design.delayed.expectedRecordingCount,
      design.delayed.manifestHash,
      nowMs,
      nowMs,
    ),
  ];

  design.itemAssignments.forEach((item) => {
    statements.push(db.prepare(`
      INSERT INTO item_assignments (
        participant_uuid, item_id, list_id, list_rank, variability, test_accent,
        no_talker_id, test_talker_id, asset_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      assignment.participantUuid,
      item.id,
      item.list,
      item.listRank,
      item.variability,
      item.testAccent,
      item.noTalkerId,
      item.testTalkerId,
      item.assetVersion,
    ));
  });

  [
    [preVisitUuid, "picture_naming", 1],
    [immediateVisitUuid, "learning", 1],
    [immediateVisitUuid, "picture_naming", 2],
    [immediateVisitUuid, "l2_to_l1", 3],
    [delayedVisitUuid, "picture_naming", 1],
    [delayedVisitUuid, "l2_to_l1", 2],
  ].forEach(([visitUuid, segment, segmentOrder]) => {
    statements.push(db.prepare(`
      INSERT INTO segments (visit_uuid, segment, segment_order, status)
      VALUES (?, ?, ?, 'pending')
    `).bind(visitUuid, segment, segmentOrder));
  });

  design.immediate.trials.forEach((trial) => statements.push(
    trialInsertStatement(db, immediateVisitUuid, trial),
  ));
  design.pre.trials.forEach((trial) => statements.push(
    trialInsertStatement(db, preVisitUuid, trial),
  ));
  design.delayed.trials.forEach((trial) => statements.push(
    trialInsertStatement(db, delayedVisitUuid, trial),
  ));
  statements.push(db.prepare(`
    INSERT INTO audit_log (
      audit_uuid, actor_type, action, participant_uuid, server_at_ms, details_json
    ) VALUES (?, 'admin', 'participant_created', ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    assignment.participantUuid,
    nowMs,
    stableJson({
      numeric_id: assignment.numericId,
      assignment_version: assignment.assignmentVersion,
      pre_manifest_hash: design.pre.manifestHash,
      immediate_manifest_hash: design.immediate.manifestHash,
      delayed_manifest_hash: design.delayed.manifestHash,
    }),
  ));

  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await findParticipantByNumericId(db, assignment.numericId);
    if (raced) return { existing: true, participant: raced };
    throw error;
  }
  return {
    existing: false,
    participant: {
      participant_uuid: assignment.participantUuid,
      numeric_id: assignment.numericId,
      training_accent: assignment.trainingAccent,
      counterbalance_cell: assignment.counterbalanceCell,
      pre_visit_uuid: preVisitUuid,
      immediate_visit_uuid: immediateVisitUuid,
      delayed_visit_uuid: delayedVisitUuid,
    },
  };
}

export async function getVisitForInvitation(db, tokenHash) {
  return db.prepare(`
    SELECT
      i.invite_uuid, i.visit_uuid, i.status AS invitation_status, i.generation,
      v.visit_type, v.status AS visit_status, v.target_at_ms, v.available_at_ms,
      v.first_started_at_ms, v.behavioral_completed_at_ms, v.finalized_at_ms,
      v.active_session_epoch, v.participant_uuid, v.manifest_hash,
      p.numeric_id, p.assignment_version, p.asset_version
    FROM invitations i
    JOIN visits v ON v.visit_uuid = i.visit_uuid
    JOIN participants p ON p.participant_uuid = v.participant_uuid
    WHERE i.token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();
}

export async function getSessionByTokenHash(db, tokenHash) {
  return db.prepare(`
    SELECT
      s.session_uuid, s.visit_uuid, s.epoch, s.client_instance_id,
      s.last_seen_at_ms AS session_last_seen_at_ms,
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
    WHERE s.token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();
}

export async function getVisitState(db, session) {
  const [manifestResult, acceptedResult, segmentResult] = await Promise.all([
    db.prepare(`
      SELECT
        trial_uuid, ordinal, segment, segment_ordinal, practice,
        exclude_from_analysis, item_id, item_gloss, placeholder_asset,
        expects_recording, audio_key, image_key, trial_json
      FROM trial_manifest
      WHERE visit_uuid = ?
      ORDER BY ordinal
    `).bind(session.visit_uuid).all(),
    db.prepare(`
      SELECT
        tm.trial_uuid, tm.ordinal, tm.canonical_attempt_uuid AS attempt_uuid,
        ta.response_key, ta.server_received_at_ms,
        COALESCE(r.state, CASE WHEN tm.expects_recording = 1 THEN 'missing' ELSE 'not_required' END) AS recording_state
      FROM trial_manifest tm
      JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
      LEFT JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
      WHERE tm.visit_uuid = ? AND tm.canonical_attempt_uuid IS NOT NULL
      ORDER BY tm.ordinal
    `).bind(session.visit_uuid).all(),
    db.prepare(`
      SELECT segment, segment_order, status, started_at_ms, completed_at_ms
      FROM segments WHERE visit_uuid = ? ORDER BY segment_order
    `).bind(session.visit_uuid).all(),
  ]);

  const accepted = acceptedResult.results.map((row) => ({
    trial_id: row.trial_uuid,
    ordinal: row.ordinal,
    attempt_id: row.attempt_uuid,
    response_key: row.response_key,
    server_received_at_ms: row.server_received_at_ms,
    recording_state: row.recording_state,
  }));
  const acceptedIds = new Set(accepted.map((row) => row.trial_id));
  const nextManifestRow = manifestResult.results.find((row) => !acceptedIds.has(row.trial_uuid)) ?? null;
  const manifest = manifestResult.results.map((row) => {
    const full = JSON.parse(row.trial_json);
    return {
      trial_id: row.trial_uuid,
      ordinal: row.ordinal,
      segment: row.segment,
      segment_ordinal: row.segment_ordinal,
      practice: Boolean(row.practice),
      exclude_from_analysis: Boolean(row.exclude_from_analysis),
      placeholder_asset: Boolean(row.placeholder_asset),
      expects_recording: Boolean(row.expects_recording),
      has_audio: Boolean(row.audio_key),
      has_image: Boolean(row.image_key),
      audio_endpoint: row.audio_key ? `/api/stimuli/${row.trial_uuid}/audio` : null,
      image_endpoint: row.image_key ? `/api/stimuli/${row.trial_uuid}/image` : null,
      protocol: { timing: full.protocol?.timing ?? {} },
      current: row.trial_uuid === nextManifestRow?.trial_uuid,
    };
  });
  const nextTrial = manifest.find((trial) => !acceptedIds.has(trial.trial_id)) ?? null;
  return {
    visit: {
      visit_id: session.visit_uuid,
      visit_type: session.visit_type,
      status: session.visit_status,
      manifest_hash: session.manifest_hash,
      expected_trials: session.expected_trial_count,
      expected_recordings: session.expected_recording_count,
      first_started_at_ms: session.first_started_at_ms,
      learning_completed_at_ms: session.learning_completed_at_ms,
      picture_naming_started_at_ms: session.picture_naming_started_at_ms,
      picture_naming_completed_at_ms: session.picture_naming_completed_at_ms,
      l2_to_l1_started_at_ms: session.l2_to_l1_started_at_ms,
      behavioral_completed_at_ms: session.behavioral_completed_at_ms,
      target_at_ms: session.target_at_ms,
    },
    participant: { id: session.numeric_id },
    session: {
      session_id: session.session_uuid,
      epoch: session.epoch,
      expires_at_ms: session.expires_at_ms,
    },
    segments: segmentResult.results,
    manifest,
    accepted,
    next_trial_id: nextTrial?.trial_id ?? null,
    next_route: nextTrial
      ? (CANONICAL_ROUTES[session.visit_type]?.[nextTrial.segment] ?? null)
      : null,
    server_now_ms: Date.now(),
  };
}
