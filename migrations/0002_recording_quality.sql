ALTER TABLE recordings ADD COLUMN analysis_start_seconds REAL;
ALTER TABLE recordings ADD COLUMN analyzed_sample_count INTEGER;
ALTER TABLE recordings ADD COLUMN rms_amplitude REAL;
ALTER TABLE recordings ADD COLUMN peak_amplitude REAL;
ALTER TABLE recordings ADD COLUMN clipping_ratio REAL;
ALTER TABLE recordings ADD COLUMN crc32 INTEGER;
