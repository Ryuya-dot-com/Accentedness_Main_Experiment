#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_MARKER_FILENAME,
  BACKUP_MARKER_KIND,
  PRODUCTION_D1_DATABASE,
  PRODUCTION_R2_BUCKETS,
  isValidBackupMarker,
} from "./lib/backup-plan.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const BACKUP_CLI = path.join(SCRIPT_DIRECTORY, "backup-production.mjs");
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TEST_CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const TEST_D1_DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const TEST_RCLONE_REMOTE = "research-r2";
const TEST_WRANGLER_PROFILE = "research-production";
const CURRENT_REMOTE_OBJECTS = Object.freeze({
  "main-experiment-recordings-production": Object.freeze({
    "audio/p001/trial.wav": "fake-wave-data\n",
  }),
  "main-experiment-exports-production": Object.freeze({
    "exports/session.zip": "fake-export-archive\n",
  }),
  "main-experiment-stimuli-production": Object.freeze({
    "stimuli/word.wav": "fake-stimulus-wave\n",
  }),
});

function permissions(details) {
  return details.mode & 0o777;
}

function runBackupCli(args, {
  env = process.env,
  backupCli = BACKUP_CLI,
  cwd = REPOSITORY_ROOT,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupCli, ...args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function initialize(destination, runnerOptions = {}) {
  return runBackupCli([
    "init",
    "--destination",
    destination,
    "--confirm-encrypted-storage",
  ], runnerOptions);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), { code: "ENOENT" });
}

async function createExecutable(filePath, source) {
  await writeFile(filePath, source, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(filePath, PRIVATE_DIRECTORY_MODE);
}

function copiedRunArguments(destination) {
  return [
    "run",
    "--destination",
    destination,
    "--wrangler-profile",
    TEST_WRANGLER_PROFILE,
    "--rclone-remote",
    TEST_RCLONE_REMOTE,
    "--expected-cloudflare-account-id",
    TEST_CLOUDFLARE_ACCOUNT_ID,
    "--expected-d1-database-id",
    TEST_D1_DATABASE_ID,
    "--confirm-d1-quiet-window",
    "--confirm-encrypted-storage",
  ];
}

async function createRunHarness(caseRoot) {
  const copiedRepository = path.join(caseRoot, "copied-repository");
  const copiedScripts = path.join(copiedRepository, "scripts");
  const copiedLibrary = path.join(copiedScripts, "lib");
  const fakeBin = path.join(caseRoot, "fake-bin");
  const fakeWranglerDirectory = path.join(copiedRepository, "node_modules", ".bin");
  const externalConfigurationDirectory = path.join(caseRoot, "external-configuration");
  await Promise.all([
    mkdir(copiedLibrary, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(fakeBin, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(fakeWranglerDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(externalConfigurationDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE }),
  ]);

  const copiedBackupCli = path.join(copiedScripts, "backup-production.mjs");
  await copyFile(BACKUP_CLI, copiedBackupCli);
  await copyFile(
    path.join(SCRIPT_DIRECTORY, "lib", "backup-plan.mjs"),
    path.join(copiedLibrary, "backup-plan.mjs"),
  );

  const rcloneConfigPath = path.join(externalConfigurationDirectory, "rclone.conf");
  await writeFile(rcloneConfigPath, "# Private fake configuration outside the copied repository.\n", {
    mode: PRIVATE_FILE_MODE,
  });
  await chmod(rcloneConfigPath, PRIVATE_FILE_MODE);

  const fakeWrangler = `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("wrangler 4.125.0\\n");
} else if (args[0] === "d1" && args[1] === "info") {
  process.stdout.write(JSON.stringify({
    uuid: ${JSON.stringify(TEST_D1_DATABASE_ID)},
    name: ${JSON.stringify(PRODUCTION_D1_DATABASE)},
  }) + "\\n");
} else if (args[0] === "d1" && args[1] === "export") {
  const outputIndex = args.indexOf("--output");
  if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(64);
  await writeFile(args[outputIndex + 1], "PRAGMA foreign_keys=OFF;\\nCREATE TABLE fake_backup (id INTEGER);\\n");
} else {
  process.stderr.write("unexpected fake Wrangler invocation\\n");
  process.exit(64);
}
`;
  await createExecutable(path.join(fakeWranglerDirectory, "wrangler"), fakeWrangler);

  const fakeRclone = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const command = args[0] ?? "";
const source = args[1] ?? "";
const separator = source.indexOf(":");
const bucket = separator >= 0 ? source.slice(separator + 1) : "";
const objects = ${JSON.stringify(CURRENT_REMOTE_OBJECTS)};
const failureTarget = command + (bucket ? ":" + bucket : "");
if (process.env.FAKE_BACKUP_FAIL_COMMAND === failureTarget) {
  process.stderr.write("controlled child failure: " + (process.env.FAKE_BACKUP_SENSITIVE_VALUE ?? "redacted") + "\\n");
  process.exit(73);
}

if (command === "version") {
  process.stdout.write("rclone v1.75.0\\n- os/version: fake\\n");
} else if (command === "config" && args[1] === "file") {
  process.stdout.write("Configuration file is stored at:\\n" + ${JSON.stringify(rcloneConfigPath)} + "\\n");
} else if (command === "config" && args[1] === "redacted" && args[2] === ${JSON.stringify(TEST_RCLONE_REMOTE)}) {
  process.stdout.write([
    "[${TEST_RCLONE_REMOTE}]",
    "type = s3",
    "provider = Cloudflare",
    "env_auth = false",
    "endpoint = https://${TEST_CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com",
    "access_key_id = XXX",
    "secret_access_key = XXX",
    "",
  ].join("\\n"));
} else if (command === "copy" && objects[bucket]) {
  const destination = args[2];
  if (!destination || !args.includes("--immutable")) process.exit(64);
  for (const [relativePath, contents] of Object.entries(objects[bucket])) {
    const output = path.join(destination, ...relativePath.split("/"));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
} else if (command === "check" && objects[bucket]) {
  if (!args[2] || !args.includes("--one-way") || !args.includes("--download")) process.exit(64);
} else if (command === "lsf" && objects[bucket]) {
  if (!args.includes("--recursive") || !args.includes("--files-only")) process.exit(64);
  process.stdout.write(Object.keys(objects[bucket]).sort().join("\\n") + "\\n");
} else {
  process.stderr.write("unexpected fake rclone invocation\\n");
  process.exit(64);
}
`;
  await createExecutable(path.join(fakeBin, "rclone"), fakeRclone);

  const pathEntries = [fakeBin, path.dirname(process.execPath), process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  const environment = {
    HOME: process.env.HOME ?? os.homedir(),
    LANG: "C.UTF-8",
    PATH: pathEntries,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
  const runnerOptions = {
    backupCli: copiedBackupCli,
    cwd: copiedRepository,
    env: environment,
  };
  return {
    copiedRepository,
    environment,
    runnerOptions,
    rcloneConfigPath,
  };
}

async function testPrivateInitialization(caseRoot) {
  const destination = path.join(caseRoot, "private-backup");
  const result = await initialize(destination);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);

  const rootDetails = await lstat(destination);
  assert.equal(rootDetails.isDirectory(), true);
  assert.equal(rootDetails.isSymbolicLink(), false);
  assert.equal(permissions(rootDetails), PRIVATE_DIRECTORY_MODE);

  const markerPath = path.join(destination, BACKUP_MARKER_FILENAME);
  const markerDetails = await lstat(markerPath);
  assert.equal(markerDetails.isFile(), true);
  assert.equal(markerDetails.isSymbolicLink(), false);
  assert.equal(permissions(markerDetails), PRIVATE_FILE_MODE);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.kind, BACKUP_MARKER_KIND);
  assert.equal(marker.encrypted_storage_attested, true);
  assert.equal(isValidBackupMarker(marker), true);

  const expectedEntries = [
    BACKUP_MARKER_FILENAME,
    ".staging",
    "failed",
    "objects",
    "snapshots",
  ].sort();
  assert.deepEqual((await readdir(destination)).sort(), expectedEntries);
  for (const directory of ["objects", "snapshots", ".staging", "failed"]) {
    const details = await lstat(path.join(destination, directory));
    assert.equal(details.isDirectory(), true, `${directory} must be a directory`);
    assert.equal(details.isSymbolicLink(), false, `${directory} must not be a symlink`);
    assert.equal(permissions(details), PRIVATE_DIRECTORY_MODE, `${directory} must use mode 0700`);
  }
}

async function testNonEmptyDirectoryIsUntouched(caseRoot) {
  const destination = path.join(caseRoot, "non-empty-unmarked");
  const sentinelPath = path.join(destination, "do-not-touch.txt");
  await mkdir(destination, { mode: 0o755 });
  await chmod(destination, 0o755);
  await writeFile(sentinelPath, "preserve exactly\n", { mode: 0o644 });
  await chmod(sentinelPath, 0o644);

  const beforeRoot = await stat(destination);
  const beforeSentinel = await stat(sentinelPath);
  const beforeContents = await readFile(sentinelPath);
  const beforeEntries = await readdir(destination);

  const result = await initialize(destination);
  assert.notEqual(result.code, 0, "initialization must reject an unmarked non-empty directory");
  assert.match(result.stderr, /backup_root_not_empty/u);

  const afterRoot = await stat(destination);
  const afterSentinel = await stat(sentinelPath);
  assert.equal(permissions(afterRoot), permissions(beforeRoot));
  assert.equal(permissions(afterSentinel), permissions(beforeSentinel));
  assert.equal(afterRoot.mtimeMs, beforeRoot.mtimeMs);
  assert.equal(afterSentinel.mtimeMs, beforeSentinel.mtimeMs);
  assert.deepEqual(await readFile(sentinelPath), beforeContents);
  assert.deepEqual(await readdir(destination), beforeEntries);
}

async function testRootSymlinkIsRejected(caseRoot) {
  const target = path.join(caseRoot, "root-target");
  const destination = path.join(caseRoot, "root-link");
  await mkdir(target, { mode: PRIVATE_DIRECTORY_MODE });
  const before = await stat(target);
  await symlink(target, destination, "dir");

  const result = await initialize(destination);
  assert.notEqual(result.code, 0, "initialization must reject a destination symlink");
  assert.match(result.stderr, /backup_root_symlink/u);
  assert.equal((await lstat(destination)).isSymbolicLink(), true);
  assert.deepEqual(await readdir(target), []);
  const after = await stat(target);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(permissions(after), permissions(before));
}

async function testFixedLayoutSymlinkIsRejectedBeforeExternalCommands(caseRoot) {
  const destination = path.join(caseRoot, "symlinked-layout");
  const initialized = await initialize(destination);
  assert.equal(initialized.code, 0, initialized.stderr);

  const outside = path.join(caseRoot, "outside-target");
  const outsideSentinel = path.join(outside, "must-remain.txt");
  await mkdir(outside, { mode: PRIVATE_DIRECTORY_MODE });
  await writeFile(outsideSentinel, "outside remains untouched\n", { mode: PRIVATE_FILE_MODE });
  const outsideBefore = await stat(outside);
  const sentinelBefore = await stat(outsideSentinel);
  const outsideEntriesBefore = await readdir(outside);
  const sentinelContentsBefore = await readFile(outsideSentinel);

  const objects = path.join(destination, "objects");
  await rmdir(objects);
  await symlink(outside, objects, "dir");

  // With no executable search path, reaching the external preflight would fail
  // with command_start_failed. The layout error therefore proves rejection
  // occurred before Wrangler, rclone, or git could be invoked.
  const emptyPath = path.join(caseRoot, "empty-path");
  await mkdir(emptyPath, { mode: PRIVATE_DIRECTORY_MODE });
  const result = await runBackupCli([
    "run",
    "--destination",
    destination,
    "--wrangler-profile",
    "research-production",
    "--rclone-remote",
    "research-r2",
    "--expected-cloudflare-account-id",
    "a".repeat(32),
    "--expected-d1-database-id",
    "11111111-2222-3333-4444-555555555555",
    "--confirm-d1-quiet-window",
    "--confirm-encrypted-storage",
  ], {
    env: { ...process.env, PATH: emptyPath },
  });

  assert.notEqual(result.code, 0, "run must reject a symlinked fixed-layout directory");
  assert.match(result.stderr, /backup_layout_not_plain_directory/u);
  assert.doesNotMatch(result.stderr, /command_(?:start_failed|exit_)/u);
  assert.equal(await lstat(objects).then((details) => details.isSymbolicLink()), true);
  assert.deepEqual(await readdir(outside), outsideEntriesBefore);
  assert.deepEqual(await readFile(outsideSentinel), sentinelContentsBefore);
  const outsideAfter = await stat(outside);
  const sentinelAfter = await stat(outsideSentinel);
  assert.equal(outsideAfter.mtimeMs, outsideBefore.mtimeMs);
  assert.equal(sentinelAfter.mtimeMs, sentinelBefore.mtimeMs);
  assert.equal(permissions(outsideAfter), permissions(outsideBefore));
  assert.equal(permissions(sentinelAfter), permissions(sentinelBefore));
  await assert.rejects(stat(path.join(destination, ".backup.lock")), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.join(destination, ".staging")), []);
  assert.deepEqual(await readdir(path.join(destination, "failed")), []);
}

async function testCopiedCliPublishesCompleteSnapshot(caseRoot) {
  const harness = await createRunHarness(caseRoot);
  const destination = path.join(caseRoot, "successful-backup");
  const initialized = await initialize(destination, harness.runnerOptions);
  assert.equal(initialized.code, 0, initialized.stderr);

  // The additive mirror may retain objects that are no longer remote. The
  // snapshot manifest must describe only the membership returned by `lsf`.
  const staleObject = path.join(
    destination,
    "objects",
    PRODUCTION_R2_BUCKETS[0],
    "retained-but-not-current.wav",
  );
  await mkdir(path.dirname(staleObject), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await writeFile(staleObject, "historical object retained additively\n", { mode: PRIVATE_FILE_MODE });

  const result = await runBackupCli(copiedRunArguments(destination), harness.runnerOptions);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Complete snapshot published/u);

  const snapshotId = (await readFile(path.join(destination, "LATEST"), "utf8")).trim();
  assert.match(snapshotId, /^\d{8}T\d{9}Z-[0-9a-f]{12}$/u);
  assert.deepEqual(await readdir(path.join(destination, "snapshots")), [snapshotId]);
  assert.deepEqual(await readdir(path.join(destination, ".staging")), []);
  assert.deepEqual(await readdir(path.join(destination, "failed")), []);
  await assertMissing(path.join(destination, ".backup.lock"));

  const snapshot = path.join(destination, "snapshots", snapshotId);
  const manifestText = await readFile(path.join(snapshot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.snapshot_id, snapshotId);
  assert.equal(manifest.source.cloudflare_account_id, TEST_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(manifest.source.d1_database_id, TEST_D1_DATABASE_ID);
  assert.equal(manifest.tools.rclone, "rclone v1.75.0");
  assert.equal(manifest.tools.wrangler, "wrangler 4.125.0");
  assert.equal(manifest.r2.length, PRODUCTION_R2_BUCKETS.length);

  const manifestBuckets = new Map(manifest.r2.map((bucket) => [bucket.bucket, bucket]));
  for (const bucket of PRODUCTION_R2_BUCKETS) {
    const inventory = manifestBuckets.get(bucket);
    assert.ok(inventory, `manifest is missing ${bucket}`);
    assert.equal(inventory.membership_scope, "current_remote_objects_at_snapshot");
    assert.equal(inventory.remote_verification, "rclone_check_one_way_download");
    const expectedPaths = Object.keys(CURRENT_REMOTE_OBJECTS[bucket]).sort();
    assert.deepEqual(inventory.objects.map((object) => object.relative_path), expectedPaths);
    assert.equal(inventory.object_count, expectedPaths.length);
    for (const object of inventory.objects) {
      const expectedContents = CURRENT_REMOTE_OBJECTS[bucket][object.relative_path];
      assert.equal(object.byte_count, Buffer.byteLength(expectedContents));
      assert.equal(object.sha256, sha256(expectedContents));
    }

    const membershipText = await readFile(
      path.join(snapshot, "r2-membership", `${bucket}.txt`),
      "utf8",
    );
    assert.deepEqual(membershipText.trim().split(/\r?\n/gu), expectedPaths);
  }
  assert.equal(await readFile(staleObject, "utf8"), "historical object retained additively\n");
  assert.equal(
    manifestBuckets.get(PRODUCTION_R2_BUCKETS[0]).objects.some(
      (object) => object.relative_path === path.basename(staleObject),
    ),
    false,
  );

  const d1Export = await readFile(
    path.join(snapshot, "d1", `${PRODUCTION_D1_DATABASE}.sql`),
  );
  assert.ok(d1Export.length > 0);
  assert.equal(manifest.d1.byte_count, d1Export.length);
  assert.equal(manifest.d1.sha256, sha256(d1Export));
  assert.equal(
    await readFile(path.join(snapshot, "manifest.sha256"), "utf8"),
    `${sha256(manifestText)}  manifest.json\n`,
  );
  const configDetails = await stat(harness.rcloneConfigPath);
  assert.equal(permissions(configDetails), PRIVATE_FILE_MODE);
}

async function testCopiedCliRecordsSanitizedChildFailure(caseRoot) {
  const harness = await createRunHarness(caseRoot);
  const destination = path.join(caseRoot, "failed-backup");
  const initialized = await initialize(destination, harness.runnerOptions);
  assert.equal(initialized.code, 0, initialized.stderr);

  const sensitiveValue = "DO-NOT-PERSIST-THIS-FAKE-CREDENTIAL";
  const failedBucket = PRODUCTION_R2_BUCKETS[1];
  const runnerOptions = {
    ...harness.runnerOptions,
    env: {
      ...harness.environment,
      FAKE_BACKUP_FAIL_COMMAND: `copy:${failedBucket}`,
      FAKE_BACKUP_SENSITIVE_VALUE: sensitiveValue,
    },
  };
  const result = await runBackupCli(copiedRunArguments(destination), runnerOptions);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /Backup failed during r2_copy_/u);
  assert.match(result.stderr, new RegExp(sensitiveValue, "u"));

  assert.deepEqual(await readdir(path.join(destination, "snapshots")), []);
  assert.deepEqual(await readdir(path.join(destination, ".staging")), []);
  await assertMissing(path.join(destination, "LATEST"));
  await assertMissing(path.join(destination, ".backup.lock"));

  const failedEntries = await readdir(path.join(destination, "failed"));
  assert.equal(failedEntries.length, 1);
  const failureText = await readFile(
    path.join(destination, "failed", failedEntries[0], "failure.json"),
    "utf8",
  );
  const failure = JSON.parse(failureText);
  assert.deepEqual(Object.keys(failure).sort(), [
    "error_code",
    "failed_at_utc",
    "schema_version",
    "snapshot_id",
    "stage",
    "status",
  ]);
  assert.equal(failure.status, "failed");
  assert.equal(failure.snapshot_id, failedEntries[0]);
  assert.equal(failure.stage, `r2_copy_${failedBucket}`);
  assert.equal(failure.error_code, "command_exit_73");
  assert.equal(Number.isNaN(Date.parse(failure.failed_at_utc)), false);
  assert.doesNotMatch(failureText, new RegExp(sensitiveValue, "u"));
  assert.doesNotMatch(failureText, /controlled child failure/u);
  assert.doesNotMatch(failureText, /cloudflarestorage\.com/u);
}

const suiteRoot = await mkdtemp(path.join(os.tmpdir(), "accentedness-backup-cli-test-"));
const tests = [
  ["init creates a private marker and fixed layout", testPrivateInitialization],
  ["init refusal leaves a non-empty unmarked directory unchanged", testNonEmptyDirectoryIsUntouched],
  ["init rejects a destination symlink without touching its target", testRootSymlinkIsRejected],
  ["fixed-layout symlink is rejected before external commands", testFixedLayoutSymlinkIsRejectedBeforeExternalCommands],
  ["copied CLI publishes a complete current-membership snapshot", testCopiedCliPublishesCompleteSnapshot],
  ["copied CLI records a sanitized child-command failure", testCopiedCliRecordsSanitizedChildFailure],
];

try {
  for (const [name, test] of tests) {
    const caseRoot = path.join(suiteRoot, name.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase());
    await mkdir(caseRoot, { mode: PRIVATE_DIRECTORY_MODE });
    await test(caseRoot);
    process.stdout.write(`ok - ${name}\n`);
  }
  process.stdout.write(`${tests.length} backup CLI orchestration tests passed\n`);
} finally {
  await rm(suiteRoot, { recursive: true, force: true });
}
