#!/usr/bin/env node

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEVELOPMENT_ORIGIN = "https://accentedness-main-experiment.komuro-4121.workers.dev";
const POLL_INTERVAL_MS = 30_000;
const VISIT_ORDER = Object.freeze({ pre: 1, immediate: 2, delayed: 3 });
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function canonicalParticipantId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? String(number) : null;
}

export function latestBackupCheckpoint(payload) {
  if (!payload?.participant || !Array.isArray(payload.visits)) return null;
  const participant = payload.participant;
  const checkpoints = payload.visits
    .filter((visit) => Number.isSafeInteger(Number(visit.finalized_at_ms))
      && Number(visit.finalized_at_ms) > 0
      && Object.hasOwn(VISIT_ORDER, visit.visit_type))
    .sort((left, right) => VISIT_ORDER[left.visit_type] - VISIT_ORDER[right.visit_type])
    .map((visit) => ({
      label: visit.visit_type,
      timestamp: Number(visit.finalized_at_ms),
    }));
  const withdrawnAt = Number(participant.updated_at_ms);
  if (participant.status === "withdrawn"
      && Number.isSafeInteger(withdrawnAt) && withdrawnAt > 0) {
    checkpoints.push({ label: "withdrawn", timestamp: withdrawnAt });
  }
  return checkpoints.at(-1) ?? null;
}

export function backupFilename(participantId, checkpoint) {
  const canonicalId = canonicalParticipantId(participantId);
  if (!canonicalId || !checkpoint || !/^(pre|immediate|delayed|withdrawn)$/u.test(checkpoint.label)
      || !Number.isSafeInteger(checkpoint.timestamp) || checkpoint.timestamp <= 0) {
    throw new TypeError("invalid_backup_checkpoint");
  }
  return `accentedness_p${canonicalId}_${checkpoint.label}_${checkpoint.timestamp}.zip`;
}

async function hasZipMagic(filePath) {
  try {
    const handle = await open(filePath, "r");
    try {
      const bytes = Buffer.alloc(4);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead === 4 && bytes.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function jsonRequest(url, token = "") {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`request_failed_${response.status}`);
    error.status = response.status;
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function assertDevelopmentReady(origin) {
  const health = await jsonRequest(`${origin}/api/health`);
  if (health?.environment !== "development"
      || health.asset_version !== "main-assets-v2"
      || health.placeholder_assets !== false
      || health.development_participants_allowed !== true
      || health.collection_ready !== true) {
    throw new Error("development_not_ready_for_persistent_backup");
  }
}

async function participantStatus(origin, token, participantId) {
  try {
    return await jsonRequest(
      `${origin}/api/admin/participants/${encodeURIComponent(participantId)}`,
      token,
    );
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function downloadZip(origin, token, participantId, destination) {
  if (await hasZipMagic(destination)) return false;
  const response = await fetch(
    `${origin}/api/admin/participants/${encodeURIComponent(participantId)}/results.zip`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!response.ok || !response.body
      || !(response.headers.get("Content-Type") ?? "").includes("application/zip")) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`backup_download_failed_${response.status}`);
  }
  const expectedSize = Number(response.headers.get("Content-Length"));
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    await response.body.cancel().catch(() => {});
    throw new Error("backup_content_length_invalid");
  }
  const temporary = `${destination}.partial-${process.pid}-${Date.now()}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const saved = await stat(temporary);
    if (saved.size !== expectedSize || !(await hasZipMagic(temporary))) {
      throw new Error("backup_integrity_check_failed");
    }
    await rename(temporary, destination);
    return true;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureBackupDirectory(value) {
  if (!value) throw new Error("BACKUP_DIR_is_required");
  const directory = path.resolve(value);
  const [homeDirectory, repositoryRoot] = await Promise.all([
    realpath(homedir()),
    realpath(REPOSITORY_ROOT),
  ]);
  if (!backupDirectoryAllowed(directory, homeDirectory, repositoryRoot)) {
    throw new Error("BACKUP_DIR_must_be_private_home_directory");
  }
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(directory));
    if (parent !== homeDirectory) throw new Error("BACKUP_DIR_parent_not_allowed");
    await mkdir(directory, { mode: 0o700 });
    details = await lstat(directory);
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("BACKUP_DIR_must_be_real_directory");
  }
  const resolved = await realpath(directory);
  if (!backupDirectoryAllowed(resolved, homeDirectory, repositoryRoot)
      || (typeof process.getuid === "function" && details.uid !== process.getuid())
      || (details.mode & 0o777) !== 0o700) {
    throw new Error("BACKUP_DIR_must_be_owned_and_mode_0700");
  }
  return resolved;
}

export function backupDirectoryAllowed(
  value,
  homeDirectory = homedir(),
  repositoryRoot = REPOSITORY_ROOT,
) {
  const directory = path.resolve(value);
  const relativeToRepository = path.relative(path.resolve(repositoryRoot), directory);
  return path.basename(directory) === "Accentedness_Backups"
    && path.dirname(directory) === path.resolve(homeDirectory)
    && !directory.split(path.sep).some((part) => part.toLowerCase() === "dropbox")
    && relativeToRepository !== ""
    && (relativeToRepository.startsWith(`..${path.sep}`) || relativeToRepository === "..");
}

async function backupOnce({ origin, token, participantId, directory }) {
  const payload = await participantStatus(origin, token, participantId);
  if (!payload) return { state: "waiting_for_participant" };
  const checkpoint = latestBackupCheckpoint(payload);
  if (!checkpoint) return { state: "waiting_for_checkpoint" };
  const destination = path.join(directory, backupFilename(participantId, checkpoint));
  const downloaded = await downloadZip(origin, token, participantId, destination);
  return {
    state: downloaded ? "downloaded" : "already_present",
    destinations: downloaded ? [destination] : [],
  };
}

function selfTest() {
  assert.equal(canonicalParticipantId("1"), "1");
  assert.equal(canonicalParticipantId("01"), null);
  assert.equal(latestBackupCheckpoint(null), null);
  assert.equal(latestBackupCheckpoint({
    participant: { status: "active" },
    visits: [{ visit_type: "pre", finalized_at_ms: null }],
  }), null);
  assert.deepEqual(latestBackupCheckpoint({
    participant: { status: "active", updated_at_ms: 9 },
    visits: [
      { visit_type: "pre", finalized_at_ms: 100 },
      { visit_type: "immediate", finalized_at_ms: 200 },
      { visit_type: "delayed", finalized_at_ms: null },
    ],
  }), { label: "immediate", timestamp: 200 });
  assert.deepEqual(latestBackupCheckpoint({
    participant: { status: "withdrawn", updated_at_ms: 300 },
    visits: [{ visit_type: "pre", finalized_at_ms: 100 }],
  }), { label: "withdrawn", timestamp: 300 });
  assert.equal(
    backupFilename("1", { label: "pre", timestamp: 100 }),
    "accentedness_p1_pre_100.zip",
  );
  const home = "/Users/researcher";
  const repository = "/Users/researcher/Dropbox/Accentedness/project";
  assert.equal(backupDirectoryAllowed(`${home}/Accentedness_Backups`, home, repository), true);
  assert.equal(backupDirectoryAllowed(`${home}/Dropbox/Accentedness_Backups`, home, repository), false);
  assert.equal(backupDirectoryAllowed("/tmp/Accentedness_Backups", home, repository), false);
  assert.equal(backupDirectoryAllowed(home, home, repository), false);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    console.log("backup self-check passed");
    return;
  }
  const once = args.includes("--once");
  const participantId = canonicalParticipantId(args.find((arg) => !arg.startsWith("--")));
  const token = process.env.ADMIN_TOKEN;
  if (!participantId) throw new Error("participant_id_is_required");
  if (!token || Array.from(token).length < 24) throw new Error("ADMIN_TOKEN_is_required");
  const directory = await ensureBackupDirectory(process.env.BACKUP_DIR);
  await assertDevelopmentReady(DEVELOPMENT_ORIGIN);
  console.log(`Watching participant ${participantId}; backups: ${directory}`);
  do {
    const result = await backupOnce({
      origin: DEVELOPMENT_ORIGIN,
      token,
      participantId,
      directory,
    });
    for (const destination of result.destinations ?? []) console.log(`Saved ${destination}`);
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (true);
}

const directRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
