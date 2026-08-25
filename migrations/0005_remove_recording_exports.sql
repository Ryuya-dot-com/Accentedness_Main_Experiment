-- The queued export pipeline stored only derived ZIP metadata. Canonical responses
-- and recording metadata remain in D1; canonical WAV files remain in RECORDINGS.
DROP TABLE IF EXISTS recording_export_downloads;
DROP TABLE IF EXISTS recording_export_members;
DROP TABLE IF EXISTS recording_exports;
