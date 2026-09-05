#!/usr/bin/env python3
"""Finalize acoustic word offsets from staged PCM WAV waveforms."""

import argparse
import csv
import hashlib
import math
import os
import sys
import tempfile
import wave
from array import array
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


FRAME_MS = 20
HOP_MS = 5
MAX_GAP_MS = 25
MIN_REGION_MS = 30
TOP_DB = 40
FLOOR_DBFS = -55
REVIEWER = "waveform_endpoint_v1"
STATUS = "approved_automatic"
EXPECTED_CATEGORIES_BY_ASSET_VERSION = {
    "main-assets-v1": {"test": 72, "test-control": 6, "practice": 9},
    "main-assets-v2": {"test": 72, "test-control": 6, "practice": 3},
}


def ms_to_samples(milliseconds, rate):
    return (milliseconds * rate + 500) // 1000


def samples_to_ms(samples, rate):
    value = Decimal(samples * 1000) / Decimal(rate)
    return str(value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP))


def merge_regions(intervals, max_gap, min_length):
    merged = []
    for start, end in intervals:
        if merged and start - merged[-1][1] <= max_gap:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return [region for region in merged if region[1] - region[0] >= min_length]


def acoustic_offset(samples, rate):
    frame = ms_to_samples(FRAME_MS, rate)
    hop = ms_to_samples(HOP_MS, rate)
    if len(samples) < frame:
        raise ValueError("WAV is shorter than one analysis frame")

    starts = list(range(0, len(samples) - frame + 1, hop))
    last_start = len(samples) - frame
    if starts[-1] != last_start:
        starts.append(last_start)

    levels = []
    for start in starts:
        rms = math.sqrt(sum(sample * sample for sample in samples[start : start + frame]) / frame)
        levels.append(20 * math.log10(max(rms / 32768, 1e-12)))
    threshold = max(max(levels) - TOP_DB, FLOOR_DBFS)
    intervals = [
        (start, start + frame)
        for start, level in zip(starts, levels)
        if level >= threshold
    ]
    regions = merge_regions(
        intervals,
        ms_to_samples(MAX_GAP_MS, rate),
        ms_to_samples(MIN_REGION_MS, rate),
    )
    if not regions:
        raise ValueError("no acoustic region passed the endpoint rule")
    return regions[-1][1]


def read_wav(path):
    with wave.open(str(path), "rb") as wav:
        if wav.getcomptype() != "NONE" or wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError(f"{path}: expected PCM16 mono WAV")
        rate = wav.getframerate()
        frames = wav.getnframes()
        samples = array("h", wav.readframes(frames))
    if sys.byteorder == "big":
        samples.byteswap()
    return samples, rate, frames


def row_values(root, row):
    prefix = f"stimuli/{row['asset_version']}/"
    if not row["r2_key"].startswith(prefix):
        raise ValueError(f"{row['r2_key']}: asset version/key mismatch")
    path = root / row["r2_key"][len(prefix) :]
    if not path.is_file():
        raise ValueError(f"missing WAV: {path}")
    if hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
        raise ValueError(f"{row['r2_key']}: SHA-256 mismatch")

    samples, rate, frames = read_wav(path)
    if rate != 44100 or row["sample_rate_hz"] != "44100":
        raise ValueError(f"{row['r2_key']}: expected 44100 Hz")
    if row["channels"] != "1" or row["bit_depth"] != "16":
        raise ValueError(f"{row['r2_key']}: ledger format mismatch")
    if row["duration_ms"] != samples_to_ms(frames, rate):
        raise ValueError(f"{row['r2_key']}: duration mismatch")

    offset = acoustic_offset(samples, rate)
    if not 0 <= offset <= frames:
        raise ValueError(f"{row['r2_key']}: offset outside WAV")
    return samples_to_ms(offset, rate), samples_to_ms(frames - offset, rate)


def self_check():
    rate = 44100
    assert ms_to_samples(5, rate) == 221
    assert ms_to_samples(20, rate) == 882
    assert ms_to_samples(25, rate) == 1103
    assert ms_to_samples(30, rate) == 1323
    minimum = ms_to_samples(MIN_REGION_MS, rate)
    assert merge_regions([(0, 882)], 1103, minimum) == []
    assert merge_regions([(0, 882), (1764, 2646)], 1103, minimum) == [(0, 2646)]
    assert merge_regions([(0, 1323), (3088, 4411)], 1103, minimum) == [(0, 1323), (3088, 4411)]
    samples = array("h", [0] * 882 + [6000] * 2646)
    assert acoustic_offset(samples, rate) == len(samples)


def process(root, check):
    ledger = root / "audio_offset_review.csv"
    with ledger.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fields = reader.fieldnames
    asset_versions = {row["asset_version"] for row in rows}
    if len(asset_versions) != 1:
        raise ValueError("offset ledger must contain exactly one asset version")
    asset_version = next(iter(asset_versions))
    expected_categories = EXPECTED_CATEGORIES_BY_ASSET_VERSION.get(asset_version)
    if expected_categories is None:
        raise ValueError(f"unsupported asset version: {asset_version}")
    if Counter(row["category"] for row in rows) != Counter(expected_categories):
        expected = ", ".join(f"{count} {category}" for category, count in expected_categories.items())
        raise ValueError(f"offset ledger must contain the expected {expected} rows")

    for row in rows:
        offset, buffer_after = row_values(root, row)
        expected = (offset, buffer_after, REVIEWER, STATUS)
        current = (
            row["acoustic_word_offset_ms"],
            row["buffer_end_minus_word_offset_ms"],
            row["reviewer"],
            row["review_status"],
        )
        if check:
            if current != expected:
                raise ValueError(f"{row['r2_key']}: automatic offset is not current")
        elif current == ("", "", "", "pending_human_verification") or current == expected:
            row["acoustic_word_offset_ms"], row["buffer_end_minus_word_offset_ms"], row["reviewer"], row["review_status"] = expected
        else:
            raise ValueError(f"{row['r2_key']}: refusing to overwrite existing review data")

    if not check:
        fd, temporary = tempfile.mkstemp(prefix=ledger.name, suffix=".tmp", dir=ledger.parent)
        try:
            with os.fdopen(fd, "w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
                writer.writeheader()
                writer.writerows(rows)
            os.replace(temporary, ledger)
        except BaseException:
            os.unlink(temporary)
            raise
    print(f"{'checked' if check else 'updated'} {len(rows)} automatic offsets")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("staging_root", nargs="?", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        print("self-check passed")
    if args.staging_root:
        process(args.staging_root, args.check)
    elif not args.self_check:
        parser.error("staging_root is required unless --self-check is used")


if __name__ == "__main__":
    main()
