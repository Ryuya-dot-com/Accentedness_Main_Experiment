-- The participant's first successful invitation redemption binds the name verifier.
-- Later redemptions confirm that the participant supplies the same normalized name.
-- The plaintext name is deliberately never stored: only a domain-separated HMAC
-- verifier created with IDENTITY_SECRET is persisted.
CREATE TABLE participant_identity_bindings (
  participant_uuid TEXT PRIMARY KEY REFERENCES participants(participant_uuid),
  verifier_hex TEXT NOT NULL CHECK (
    length(verifier_hex) = 64
    AND verifier_hex NOT GLOB '*[^0-9a-f]*'
  ),
  normalization_version TEXT NOT NULL,
  verifier_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_confirmed_at_ms INTEGER,
  confirmation_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0)
);

ALTER TABLE participants ADD COLUMN withdrawn_at_ms INTEGER;
ALTER TABLE visits ADD COLUMN withdrawn_at_ms INTEGER;
ALTER TABLE trial_attempts ADD COLUMN abandoned_at_ms INTEGER;
ALTER TABLE trial_attempts ADD COLUMN abandon_reason TEXT CHECK (
  abandon_reason IN ('superseded_on_resume', 'participant_terminated')
  OR abandon_reason IS NULL
);
ALTER TABLE recordings ADD COLUMN abandoned_at_ms INTEGER;
ALTER TABLE recordings ADD COLUMN abandon_reason TEXT CHECK (
  abandon_reason IN ('superseded_on_resume', 'participant_terminated')
  OR abandon_reason IS NULL
);

CREATE TABLE participation_interruptions (
  interruption_uuid TEXT PRIMARY KEY,
  request_uuid TEXT NOT NULL UNIQUE,
  participant_uuid TEXT NOT NULL REFERENCES participants(participant_uuid),
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  requested_session_uuid TEXT NOT NULL REFERENCES sessions(session_uuid),
  mode TEXT NOT NULL CHECK (mode IN ('pause', 'terminate')),
  state TEXT NOT NULL CHECK (
    state IN ('requested', 'paused', 'resumed', 'cancelled', 'terminated')
  ),
  requested_at_ms INTEGER NOT NULL,
  finalized_at_ms INTEGER,
  resumed_at_ms INTEGER,
  accepted_trial_count INTEGER NOT NULL CHECK (accepted_trial_count >= 0),
  next_ordinal INTEGER,
  CHECK (next_ordinal IS NULL OR next_ordinal > 0),
  CHECK (finalized_at_ms IS NULL OR finalized_at_ms >= requested_at_ms),
  CHECK (resumed_at_ms IS NULL OR resumed_at_ms >= requested_at_ms),
  CHECK (
    (mode = 'pause' AND state IN ('requested', 'paused', 'resumed', 'cancelled'))
    OR (mode = 'terminate' AND state IN ('requested', 'terminated'))
  )
);

CREATE UNIQUE INDEX idx_one_open_interruption_per_visit
ON participation_interruptions(visit_uuid)
WHERE state IN ('requested', 'paused');

CREATE UNIQUE INDEX idx_one_open_termination_per_participant
ON participation_interruptions(participant_uuid)
WHERE mode = 'terminate' AND state = 'requested';

CREATE INDEX idx_interruptions_participant_time
ON participation_interruptions(participant_uuid, requested_at_ms);

CREATE INDEX idx_attempts_abandoned
ON trial_attempts(abandoned_at_ms);

CREATE INDEX idx_recordings_abandoned
ON recordings(abandoned_at_ms);

-- The API authenticates before it computes interruption progress. Re-check the
-- visit and session at INSERT time so a concurrent visit completion cannot leave
-- an open interruption attached to a completed visit.
CREATE TRIGGER interruptions_require_open_visit_and_current_session
BEFORE INSERT ON participation_interruptions
WHEN NOT EXISTS (
  SELECT 1
  FROM visits v
  JOIN sessions s ON s.session_uuid = NEW.requested_session_uuid
  WHERE v.visit_uuid = NEW.visit_uuid
    AND v.participant_uuid = NEW.participant_uuid
    AND v.status NOT IN ('completed', 'withdrawn')
    AND s.visit_uuid = v.visit_uuid
    AND s.status = 'active'
    AND s.epoch = v.active_session_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'interruption_blocked_by_visit_or_session_state');
END;

-- This is the race-condition backstop. A request accepted first prevents any
-- later trial INSERT; a trial INSERT accepted first is the one current trial
-- that the client is allowed to finish and upload before finalization.
CREATE TRIGGER trial_attempts_block_open_interruption
BEFORE INSERT ON trial_attempts
WHEN EXISTS (
  SELECT 1
  FROM trial_manifest tm
  JOIN participation_interruptions pi ON pi.visit_uuid = tm.visit_uuid
  WHERE tm.trial_uuid = NEW.trial_uuid
    AND pi.state IN ('requested', 'paused')
)
BEGIN
  SELECT RAISE(ABORT, 'trial_start_blocked_by_participation_interruption');
END;

CREATE TRIGGER invitations_block_issue_during_open_interruption
BEFORE INSERT ON invitations
WHEN EXISTS (
  SELECT 1
  FROM visits v
  JOIN participation_interruptions pi
    ON pi.participant_uuid = v.participant_uuid
  WHERE v.visit_uuid = NEW.visit_uuid
    AND pi.state IN ('requested', 'paused')
)
BEGIN
  SELECT RAISE(ABORT, 'invitation_blocked_by_participation_interruption');
END;

CREATE TRIGGER invitations_block_admin_revoke_during_open_interruption
BEFORE UPDATE OF status ON invitations
WHEN OLD.status = 'active'
  AND NEW.status = 'revoked'
  AND EXISTS (
    SELECT 1
    FROM visits v
    JOIN participation_interruptions pi
      ON pi.participant_uuid = v.participant_uuid
    WHERE v.visit_uuid = OLD.visit_uuid
      AND pi.state IN ('requested', 'paused')
  )
BEGIN
  SELECT RAISE(ABORT, 'invitation_revoke_blocked_by_participation_interruption');
END;
