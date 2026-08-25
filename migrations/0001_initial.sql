PRAGMA foreign_keys = ON;

CREATE TABLE participants (
  participant_uuid TEXT PRIMARY KEY,
  numeric_id INTEGER NOT NULL UNIQUE CHECK (numeric_id > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'withdrawn')),
  training_accent TEXT NOT NULL CHECK (training_accent IN ('english', 'chinese', 'japanese')),
  within_accent_q INTEGER NOT NULL CHECK (within_accent_q >= 0),
  counterbalance_cycle INTEGER NOT NULL CHECK (counterbalance_cycle >= 0),
  counterbalance_cell INTEGER NOT NULL CHECK (counterbalance_cell BETWEEN 1 AND 24),
  list_cell INTEGER NOT NULL CHECK (list_cell IN (0, 1)),
  order_cell INTEGER NOT NULL CHECK (order_cell IN (0, 1)),
  talker_cell INTEGER NOT NULL CHECK (talker_cell BETWEEN 0 AND 5),
  assignment_version TEXT NOT NULL,
  seed_algorithm_version TEXT NOT NULL,
  root_seed_hex TEXT NOT NULL,
  asset_version TEXT NOT NULL,
  assignment_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE visits (
  visit_uuid TEXT PRIMARY KEY,
  participant_uuid TEXT NOT NULL REFERENCES participants(participant_uuid),
  visit_type TEXT NOT NULL CHECK (visit_type IN ('pre', 'immediate', 'delayed')),
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'scheduled', 'invited', 'started', 'awaiting_uploads',
    'completed', 'withdrawn'
  )),
  target_at_ms INTEGER,
  available_at_ms INTEGER,
  first_started_at_ms INTEGER,
  learning_completed_at_ms INTEGER,
  picture_naming_started_at_ms INTEGER,
  picture_naming_completed_at_ms INTEGER,
  l2_to_l1_started_at_ms INTEGER,
  behavioral_completed_at_ms INTEGER,
  finalized_at_ms INTEGER,
  last_seen_at_ms INTEGER,
  active_session_epoch INTEGER NOT NULL DEFAULT 0 CHECK (active_session_epoch >= 0),
  expected_trial_count INTEGER NOT NULL CHECK (expected_trial_count > 0),
  expected_recording_count INTEGER NOT NULL CHECK (expected_recording_count >= 0),
  manifest_hash TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (participant_uuid, visit_type)
);

CREATE TABLE item_assignments (
  participant_uuid TEXT NOT NULL REFERENCES participants(participant_uuid),
  item_id INTEGER NOT NULL CHECK (item_id BETWEEN 1 AND 24),
  list_id INTEGER NOT NULL CHECK (list_id IN (1, 2)),
  list_rank INTEGER NOT NULL CHECK (list_rank BETWEEN 0 AND 11),
  variability TEXT NOT NULL CHECK (variability IN ('no', 'high')),
  test_accent TEXT NOT NULL CHECK (test_accent IN ('english', 'chinese', 'japanese')),
  no_talker_id TEXT NOT NULL,
  test_talker_id TEXT NOT NULL,
  asset_version TEXT NOT NULL,
  PRIMARY KEY (participant_uuid, item_id)
);

CREATE TABLE segments (
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  segment TEXT NOT NULL CHECK (segment IN ('learning', 'picture_naming', 'l2_to_l1')),
  segment_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started', 'completed')),
  started_at_ms INTEGER,
  completed_at_ms INTEGER,
  PRIMARY KEY (visit_uuid, segment),
  UNIQUE (visit_uuid, segment_order)
);

CREATE TABLE trial_manifest (
  trial_uuid TEXT PRIMARY KEY,
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  segment TEXT NOT NULL CHECK (segment IN ('learning', 'picture_naming', 'l2_to_l1')),
  segment_ordinal INTEGER NOT NULL CHECK (segment_ordinal > 0),
  practice INTEGER NOT NULL DEFAULT 0 CHECK (practice IN (0, 1)),
  exclude_from_analysis INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_analysis IN (0, 1)),
  item_id INTEGER NOT NULL,
  item_word TEXT NOT NULL,
  item_gloss TEXT NOT NULL,
  list_id INTEGER,
  list_rank INTEGER,
  variability TEXT CHECK (variability IN ('no', 'high') OR variability IS NULL),
  exposure INTEGER,
  cycle INTEGER,
  learning_block INTEGER,
  miniblock INTEGER,
  test_accent TEXT CHECK (test_accent IN ('english', 'chinese', 'japanese') OR test_accent IS NULL),
  talker_id TEXT,
  audio_key TEXT,
  image_key TEXT,
  asset_version TEXT NOT NULL,
  placeholder_asset INTEGER NOT NULL DEFAULT 1 CHECK (placeholder_asset IN (0, 1)),
  expects_recording INTEGER NOT NULL DEFAULT 0 CHECK (expects_recording IN (0, 1)),
  canonical_attempt_uuid TEXT,
  trial_json TEXT NOT NULL,
  UNIQUE (visit_uuid, ordinal),
  UNIQUE (visit_uuid, segment, segment_ordinal)
);

CREATE TABLE invitations (
  invite_uuid TEXT PRIMARY KEY,
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  generation INTEGER NOT NULL CHECK (generation > 0),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'closed')),
  issued_at_ms INTEGER NOT NULL,
  first_redeemed_at_ms INTEGER,
  last_redeemed_at_ms INTEGER,
  redeem_count INTEGER NOT NULL DEFAULT 0 CHECK (redeem_count >= 0),
  revoked_at_ms INTEGER,
  closed_at_ms INTEGER,
  UNIQUE (visit_uuid, generation)
);

CREATE TABLE sessions (
  session_uuid TEXT PRIMARY KEY,
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  invite_uuid TEXT NOT NULL REFERENCES invitations(invite_uuid),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  client_instance_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'closed')),
  started_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  superseded_at_ms INTEGER,
  closed_at_ms INTEGER,
  UNIQUE (visit_uuid, epoch)
);

CREATE TRIGGER sessions_require_active_invitation
BEFORE INSERT ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM invitations i
    WHERE i.invite_uuid = NEW.invite_uuid
      AND i.visit_uuid = NEW.visit_uuid
      AND i.status = 'active'
  )
  OR NOT EXISTS (
    SELECT 1 FROM visits v
    WHERE v.visit_uuid = NEW.visit_uuid
      AND v.active_session_epoch = NEW.epoch
      AND v.status NOT IN ('completed', 'withdrawn')
  )
BEGIN
  SELECT RAISE(ABORT, 'session_requires_active_invitation_and_epoch');
END;

CREATE TABLE trial_attempts (
  attempt_uuid TEXT PRIMARY KEY,
  trial_uuid TEXT NOT NULL REFERENCES trial_manifest(trial_uuid),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  session_uuid TEXT NOT NULL REFERENCES sessions(session_uuid),
  start_key TEXT NOT NULL UNIQUE,
  response_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('started', 'response_saved')),
  repeated_after_interruption INTEGER NOT NULL DEFAULT 0 CHECK (repeated_after_interruption IN (0, 1)),
  extra_exposure INTEGER NOT NULL DEFAULT 0 CHECK (extra_exposure IN (0, 1)),
  server_started_at_ms INTEGER NOT NULL,
  server_received_at_ms INTEGER,
  client_started_perf_ms REAL,
  client_received_perf_ms REAL,
  payload_hash TEXT,
  payload_json TEXT,
  UNIQUE (trial_uuid, attempt_no)
);

CREATE TRIGGER trial_attempts_require_active_session
BEFORE INSERT ON trial_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions s
  JOIN visits v ON v.visit_uuid = s.visit_uuid
  JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
  WHERE s.session_uuid = NEW.session_uuid
    AND tm.trial_uuid = NEW.trial_uuid
    AND s.status = 'active'
    AND s.epoch = v.active_session_epoch
    AND v.status NOT IN ('completed', 'withdrawn')
)
BEGIN
  SELECT RAISE(ABORT, 'trial_attempt_requires_active_session_epoch');
END;

CREATE TABLE recordings (
  attempt_uuid TEXT PRIMARY KEY REFERENCES trial_attempts(attempt_uuid),
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded')),
  sha256 TEXT,
  etag TEXT,
  byte_count INTEGER,
  mime_type TEXT,
  sample_rate_hz INTEGER,
  sample_count INTEGER,
  duration_seconds REAL,
  received_at_ms INTEGER,
  uploaded_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE events (
  event_uuid TEXT PRIMARY KEY,
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  session_uuid TEXT NOT NULL REFERENCES sessions(session_uuid),
  trial_uuid TEXT REFERENCES trial_manifest(trial_uuid),
  attempt_uuid TEXT REFERENCES trial_attempts(attempt_uuid),
  event_type TEXT NOT NULL,
  client_event_at_ms REAL,
  server_received_at_ms INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TRIGGER events_require_active_session
BEFORE INSERT ON events
WHEN NOT EXISTS (
  SELECT 1
  FROM sessions s
  JOIN visits v ON v.visit_uuid = s.visit_uuid
  WHERE s.session_uuid = NEW.session_uuid
    AND s.visit_uuid = NEW.visit_uuid
    AND s.status = 'active'
    AND s.epoch = v.active_session_epoch
    AND v.status NOT IN ('completed', 'withdrawn')
)
BEGIN
  SELECT RAISE(ABORT, 'event_requires_active_session_epoch');
END;

CREATE TABLE audit_log (
  audit_uuid TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin', 'participant', 'system')),
  action TEXT NOT NULL,
  participant_uuid TEXT,
  visit_uuid TEXT,
  server_at_ms INTEGER NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TABLE recording_exports (
  export_uuid TEXT PRIMARY KEY,
  participant_uuid TEXT NOT NULL REFERENCES participants(participant_uuid),
  visit_uuid TEXT NOT NULL REFERENCES visits(visit_uuid),
  segment TEXT NOT NULL CHECK (segment IN ('picture_naming', 'l2_to_l1')),
  phase_code TEXT NOT NULL CHECK (phase_code IN (
    'pre_picture_naming',
    'immediate_picture_naming', 'immediate_l2_to_l1',
    'delayed_picture_naming', 'delayed_l2_to_l1'
  )),
  state TEXT NOT NULL CHECK (state IN ('pending', 'building', 'ready', 'failed')),
  source_snapshot_sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  source_total_bytes INTEGER NOT NULL CHECK (source_total_bytes > 0),
  zip_byte_count INTEGER,
  r2_etag TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  requested_at_ms INTEGER NOT NULL,
  enqueued_at_ms INTEGER,
  started_at_ms INTEGER,
  ready_at_ms INTEGER,
  expires_at_ms INTEGER,
  failed_at_ms INTEGER,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at_ms INTEGER,
  UNIQUE (visit_uuid, segment),
  UNIQUE (participant_uuid, phase_code, source_snapshot_sha256)
);

CREATE TABLE recording_export_members (
  export_uuid TEXT NOT NULL REFERENCES recording_exports(export_uuid),
  attempt_uuid TEXT NOT NULL REFERENCES recordings(attempt_uuid),
  trial_uuid TEXT NOT NULL REFERENCES trial_manifest(trial_uuid),
  segment_ordinal INTEGER NOT NULL CHECK (segment_ordinal > 0),
  practice INTEGER NOT NULL CHECK (practice IN (0, 1)),
  entry_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  crc32 INTEGER NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count > 0),
  uploaded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (export_uuid, attempt_uuid),
  UNIQUE (export_uuid, entry_name)
);

CREATE TABLE recording_export_downloads (
  download_uuid TEXT PRIMARY KEY,
  export_uuid TEXT NOT NULL REFERENCES recording_exports(export_uuid),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('GET', 'HEAD')),
  requested_at_ms INTEGER NOT NULL,
  range_header TEXT,
  response_status INTEGER NOT NULL
);

CREATE INDEX idx_visits_status_target ON visits(status, target_at_ms);
CREATE INDEX idx_invitations_visit_status ON invitations(visit_uuid, status);
CREATE INDEX idx_sessions_visit_status ON sessions(visit_uuid, status);
CREATE INDEX idx_manifest_visit_ordinal ON trial_manifest(visit_uuid, ordinal);
CREATE INDEX idx_attempts_trial_state ON trial_attempts(trial_uuid, state);
CREATE INDEX idx_recordings_state ON recordings(state);
CREATE INDEX idx_events_visit_time ON events(visit_uuid, server_received_at_ms);
CREATE INDEX idx_recording_exports_work ON recording_exports(state, enqueued_at_ms, lease_expires_at_ms);
CREATE INDEX idx_recording_exports_visit_time ON recording_exports(visit_uuid, requested_at_ms);
CREATE INDEX idx_recording_export_downloads_time ON recording_export_downloads(export_uuid, requested_at_ms);
CREATE UNIQUE INDEX idx_single_visit_completion_audit
ON audit_log(visit_uuid, action) WHERE action = 'visit_completed';
