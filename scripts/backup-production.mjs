#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BACKUP_MARKER_FILENAME,
  PRODUCTION_D1_DATABASE,
  PRODUCTION_R2_BUCKETS,
  assertNoBackupEnvironmentOverrides,
  buildBackupManifest,
  buildFailureRecord,
  buildRcloneCheckArgs,
  buildRcloneCopyArgs,
  buildRcloneListArgs,
  buildRcloneRedactedConfigArgs,
  buildWranglerD1InfoArgs,
  buildWranglerExportArgs,
  createBackupMarker,
  createSnapshotId,
  isValidBackupMarker,
  normalizeRemoteMembershipPaths,
  parseBackupArgs,
  stableManifestJson,
  validateDedicatedRootPath,
  verifyD1Identity,
  verifyRcloneIdentity,
  verifyRcloneVersion,
} from "./lib/backup-plan.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const WRANGLER_EXECUTABLE = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "wrangler");
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CAPTURE_LIMIT_BYTES = 128 * 1024;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function usage() {
  return `Usage:
  node scripts/backup-production.mjs init --destination /absolute/encrypted/backup-root \\
    --confirm-encrypted-storage
  node scripts/backup-production.mjs run --destination /absolute/encrypted/backup-root \\
    --wrangler-profile PROFILE --rclone-remote REMOTE --confirm-d1-quiet-window \\
    --expected-cloudflare-account-id ACCOUNT_ID --expected-d1-database-id D1_UUID \\
    --confirm-encrypted-storage

The run command backs up production D1 and all three production R2 buckets.
Configure Wrangler and rclone outside this repository. Never pass tokens, keys,
passwords, or other credentials as command-line arguments.
`;
}

function pathIsInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveDestination(input, { mayCreate }) {
  if (!path.isAbsolute(input)) {
    throw codedError("backup_root_not_absolute", "Backup destination must be an explicit absolute path");
  }
  const requested = path.resolve(input);
  try {
    const requestedDetails = await lstat(requested);
    if (requestedDetails.isSymbolicLink()) {
      throw codedError("backup_root_symlink", "Backup destination itself must not be a symbolic link");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let resolved;
  try {
    resolved = await realpath(requested);
  } catch (error) {
    if (!mayCreate || error?.code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(requested));
    resolved = path.join(parent, path.basename(requested));
  }
  const repository = await realpath(REPOSITORY_ROOT);
  let homeDirectory = os.homedir();
  try {
    homeDirectory = await realpath(homeDirectory);
  } catch {
    homeDirectory = path.resolve(homeDirectory);
  }
  return validateDedicatedRootPath({
    destinationAbsolute: resolved,
    repositoryRootAbsolute: repository,
    homeDirectoryAbsolute: homeDirectory,
  });
}

async function syncFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(filePath, contents, { exclusive = false } = {}) {
  const handle = await open(filePath, exclusive ? "wx" : "w", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filePath, PRIVATE_FILE_MODE);
}

async function readMarker(destination) {
  const markerPath = path.join(destination, BACKUP_MARKER_FILENAME);
  let marker;
  try {
    const markerStats = await lstat(markerPath);
    if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
      throw codedError("backup_marker_not_plain_file", "Dedicated backup marker must be a regular file");
    }
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    throw codedError("backup_marker_missing_or_invalid", `Dedicated backup marker could not be read: ${error?.code ?? "invalid"}`);
  }
  if (!isValidBackupMarker(marker)) {
    throw codedError("backup_marker_missing_or_invalid", "Dedicated backup marker is invalid");
  }
  return marker;
}

async function assertPrivateRoot(destination) {
  const details = await lstat(destination);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw codedError("backup_root_not_directory", "Backup destination must be a real directory, not a symlink");
  }
  if ((details.mode & 0o077) !== 0) {
    throw codedError(
      "backup_root_permissions_too_broad",
      "Backup root must not grant group or world permissions (expected mode 0700)",
    );
  }
}

async function checkedDirectory(directoryPath, { create = false } = {}) {
  try {
    const details = await lstat(directoryPath);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw codedError("backup_layout_not_plain_directory", "Backup layout contains a symlink or non-directory");
    }
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw error;
    await mkdir(directoryPath, { mode: PRIVATE_DIRECTORY_MODE });
  }
  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  return directoryPath;
}

async function validateFixedLayout(destination, { create = false } = {}) {
  const directories = {};
  for (const name of ["objects", "snapshots", ".staging", "failed"]) {
    directories[name] = await checkedDirectory(path.join(destination, name), { create });
  }
  return directories;
}

async function initializeBackupRoot(destination, options) {
  let created = false;
  let existingDetails = null;
  try {
    existingDetails = await lstat(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  }
  if (existingDetails && (existingDetails.isSymbolicLink() || !existingDetails.isDirectory())) {
    throw codedError("backup_root_not_directory", "Backup destination must be a real directory, not a symlink");
  }
  const markerPath = path.join(destination, BACKUP_MARKER_FILENAME);
  const markerExists = await fileExists(markerPath);
  if (created || !markerExists) {
    const entries = await readdir(destination);
    if (entries.length !== 0) {
      throw codedError(
        "backup_root_not_empty",
        "Refusing to initialize a non-empty directory without the dedicated backup marker",
      );
    }
    const marker = createBackupMarker(new Date().toISOString(), {
      encryptedStorageConfirmed: options.encryptedStorageConfirmed,
    });
    await chmod(destination, PRIVATE_DIRECTORY_MODE);
    await writePrivateFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { exclusive: true });
  } else {
    await readMarker(destination);
    await chmod(destination, PRIVATE_DIRECTORY_MODE);
  }
  await validateFixedLayout(destination, { create: true });
  await assertPrivateRoot(destination);
  await syncDirectory(destination);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function runChild(executable, args, { capture = false, environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        if (stdout.length < CAPTURE_LIMIT_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < CAPTURE_LIMIT_BYTES) stderr += chunk.toString("utf8");
      });
    }
    child.once("error", (error) => {
      reject(codedError("command_start_failed", error?.code ?? "command_start_failed"));
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: stdout.slice(0, CAPTURE_LIMIT_BYTES), stderr: stderr.slice(0, CAPTURE_LIMIT_BYTES) });
        return;
      }
      reject(codedError(
        `command_exit_${Number.isInteger(code) ? code : "signal"}`,
        signal ? "External command ended by a signal" : "External command returned a non-zero status",
      ));
    });
  });
}

async function runChildToPrivateFile(executable, args, outputPath) {
  const handle = await open(outputPath, "wx", PRIVATE_FILE_MODE);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: REPOSITORY_ROOT,
        env: process.env,
        shell: false,
        stdio: ["ignore", handle.fd, "inherit"],
      });
      child.once("error", (error) => {
        reject(codedError("command_start_failed", error?.code ?? "command_start_failed"));
      });
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else {
          reject(codedError(
            `command_exit_${Number.isInteger(code) ? code : "signal"}`,
            signal ? "External command ended by a signal" : "External command returned a non-zero status",
          ));
        }
      });
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(outputPath, PRIVATE_FILE_MODE);
}

function firstNonEmptyLine(value) {
  return String(value).split(/\r?\n/gu).map((line) => line.trim()).find(Boolean) ?? "unknown";
}

async function verifyExternalConfiguration(options, wranglerEnvironment, wranglerEnvFile) {
  const [wranglerResult, rcloneResult, configResult, redactedResult, d1InfoResult] = await Promise.all([
    runChild(WRANGLER_EXECUTABLE, ["--version"], { capture: true }),
    runChild("rclone", ["version"], { capture: true }),
    runChild("rclone", ["config", "file"], { capture: true }),
    runChild("rclone", buildRcloneRedactedConfigArgs({ remote: options.rcloneRemote }), { capture: true }),
    runChild(
      WRANGLER_EXECUTABLE,
      buildWranglerD1InfoArgs({
        profile: options.wranglerProfile,
        envFilePath: wranglerEnvFile,
      }),
      { capture: true, environment: wranglerEnvironment },
    ),
  ]);
  const configCandidates = `${configResult.stdout}\n${configResult.stderr}`
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => path.isAbsolute(line));
  if (configCandidates.length === 0) {
    throw codedError("rclone_config_path_unknown", "Could not determine the external rclone configuration path");
  }
  const configuredPath = await realpath(configCandidates.at(-1));
  const repository = await realpath(REPOSITORY_ROOT);
  if (pathIsInside(configuredPath, repository)) {
    throw codedError("rclone_config_inside_repository", "rclone configuration must be outside the repository");
  }
  const configStats = await stat(configuredPath);
  if (!configStats.isFile() || (configStats.mode & 0o077) !== 0) {
    throw codedError("rclone_config_permissions_too_broad", "rclone configuration must be a private file (mode 0600)");
  }
  const d1Identity = verifyD1Identity(d1InfoResult.stdout, options.expectedD1DatabaseId);
  const r2Identity = verifyRcloneIdentity(
    redactedResult.stdout,
    options.rcloneRemote,
    options.expectedCloudflareAccountId,
  );
  return {
    wranglerVersion: firstNonEmptyLine(wranglerResult.stdout),
    rcloneVersion: verifyRcloneVersion(rcloneResult.stdout),
    d1Identity,
    r2Identity,
  };
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function assertDirectoryTreeSafe(current) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
      throw codedError("symlink_in_object_mirror", "Symbolic links are forbidden in the R2 object mirror");
    }
    if (details.isDirectory()) {
      await chmod(absolute, PRIVATE_DIRECTORY_MODE);
      await assertDirectoryTreeSafe(absolute);
    } else if (!details.isFile()) {
      throw codedError("unsupported_object_mirror_entry", "Only regular files are allowed in the R2 object mirror");
    } else {
      await chmod(absolute, PRIVATE_FILE_MODE);
    }
  }
}

async function inventoryRemoteMembership(root, membershipPaths) {
  const normalizedPaths = normalizeRemoteMembershipPaths(membershipPaths);
  const output = [];
  const directoriesToSync = new Set([root]);
  for (const relativePath of normalizedPaths) {
    const absolute = path.join(root, ...relativePath.split("/"));
    if (!pathIsInside(absolute, root)) {
      throw codedError("unsafe_inventory_path", "Remote membership escaped the local object mirror");
    }
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw codedError("remote_object_not_plain_file", "A current remote object is not a regular local file");
    }
    await syncFile(absolute);
    let containingDirectory = path.dirname(absolute);
    while (pathIsInside(containingDirectory, root)) {
      directoriesToSync.add(containingDirectory);
      if (containingDirectory === root) break;
      containingDirectory = path.dirname(containingDirectory);
    }
    output.push({
      relative_path: relativePath,
      byte_count: details.size,
      sha256: await sha256File(absolute),
    });
  }
  for (const directory of [...directoriesToSync].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory);
  }
  return output;
}

async function repositoryCommit() {
  try {
    const result = await runChild("git", ["rev-parse", "HEAD"], { capture: true });
    const value = firstNonEmptyLine(result.stdout);
    return /^[0-9a-f]{40}$/u.test(value) ? value : "unknown";
  } catch {
    return "unknown";
  }
}

async function acquireLock(destination) {
  const lockPath = path.join(destination, ".backup.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw codedError("backup_lock_exists", "Another backup may be active; inspect the lock before manual removal");
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at_utc: new Date().toISOString() })}\n`);
  await handle.sync();
  await handle.close();
  return async () => {
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  };
}

async function writeAtomicPointer(destination, snapshotId) {
  const temporary = path.join(destination, `.LATEST.${randomUUID()}.tmp`);
  await writePrivateFile(temporary, `${snapshotId}\n`, { exclusive: true });
  await rename(temporary, path.join(destination, "LATEST"));
  await syncDirectory(destination);
}

async function recordFailedStaging({ staging, failed, snapshotId, stage, error }) {
  if (!staging || !(await fileExists(staging))) return;
  const record = buildFailureRecord({
    snapshotId,
    stage,
    failedAtUtc: new Date().toISOString(),
    errorCode: error?.code ?? "backup_failed",
  });
  const failurePath = path.join(staging, "failure.json");
  await writePrivateFile(failurePath, stableManifestJson(record));
  await syncDirectory(staging);
  await rename(staging, failed);
  await syncDirectory(path.dirname(failed));
}

async function runProductionBackup(options, destination) {
  await readMarker(destination);
  await assertPrivateRoot(destination);
  const layout = await validateFixedLayout(destination);
  const releaseLock = await acquireLock(destination);
  const startedAt = new Date();
  const snapshotId = createSnapshotId(startedAt, randomBytes(6).toString("hex"));
  const staging = path.join(layout[".staging"], snapshotId);
  const failed = path.join(layout.failed, snapshotId);
  const finalSnapshot = path.join(layout.snapshots, snapshotId);
  let stage = "preflight";
  let published = false;
  try {
    if (!options.quietWindowConfirmed) {
      throw codedError("d1_quiet_window_confirmation_required", "D1 quiet window was not confirmed");
    }
    if (!options.encryptedStorageConfirmed) {
      throw codedError("encrypted_storage_confirmation_required", "Encrypted storage was not confirmed");
    }
    assertNoBackupEnvironmentOverrides(process.env);
    const wranglerEnvironment = {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: options.expectedCloudflareAccountId,
      CLOUDFLARE_AUTH_USE_KEYRING: "true",
    };
    await mkdir(staging, { mode: PRIVATE_DIRECTORY_MODE });
    // Supplying an explicit empty file prevents Wrangler from automatically
    // loading .env.production and overriding the pinned profile/account.
    const wranglerEnvFile = path.join(staging, "wrangler-empty.env");
    await writePrivateFile(wranglerEnvFile, "# Intentionally empty for pinned backup authentication.\n", {
      exclusive: true,
    });
    const tools = await verifyExternalConfiguration(options, wranglerEnvironment, wranglerEnvFile);

    stage = "d1_export";
    const d1Directory = path.join(staging, "d1");
    await mkdir(d1Directory, { mode: PRIVATE_DIRECTORY_MODE });
    const d1Partial = path.join(d1Directory, `${PRODUCTION_D1_DATABASE}.sql.partial`);
    const d1Final = path.join(d1Directory, `${PRODUCTION_D1_DATABASE}.sql`);
    console.error("[backup] Exporting production D1 during the confirmed quiet window...");
    await runChild(
      WRANGLER_EXECUTABLE,
      buildWranglerExportArgs({
        outputPath: d1Partial,
        profile: options.wranglerProfile,
        envFilePath: wranglerEnvFile,
      }),
      { environment: wranglerEnvironment },
    );
    await unlink(wranglerEnvFile);
    const partialStats = await stat(d1Partial);
    if (!partialStats.isFile() || partialStats.size <= 0) {
      throw codedError("empty_d1_export", "Wrangler produced an empty D1 export");
    }
    await chmod(d1Partial, PRIVATE_FILE_MODE);
    await syncFile(d1Partial);
    await rename(d1Partial, d1Final);
    await syncDirectory(d1Directory);
    const d1 = {
      relative_path: `d1/${PRODUCTION_D1_DATABASE}.sql`,
      byte_count: partialStats.size,
      sha256: await sha256File(d1Final),
    };

    const r2Inventories = [];
    const membershipDirectory = path.join(staging, "r2-membership");
    await mkdir(membershipDirectory, { mode: PRIVATE_DIRECTORY_MODE });
    for (const bucket of PRODUCTION_R2_BUCKETS) {
      stage = `r2_copy_${bucket}`;
      const mirror = await checkedDirectory(path.join(layout.objects, bucket), { create: true });
      await assertDirectoryTreeSafe(mirror);
      console.error(`[backup] Additively copying immutable objects from ${bucket}...`);
      await runChild("rclone", buildRcloneCopyArgs({
        remote: options.rcloneRemote,
        bucket,
        destinationPath: mirror,
      }));
      stage = `r2_check_${bucket}`;
      await runChild("rclone", buildRcloneCheckArgs({
        remote: options.rcloneRemote,
        bucket,
        destinationPath: mirror,
      }));
      await assertDirectoryTreeSafe(mirror);
      stage = `r2_membership_${bucket}`;
      const membershipPath = path.join(membershipDirectory, `${bucket}.txt`);
      await runChildToPrivateFile(
        "rclone",
        buildRcloneListArgs({ remote: options.rcloneRemote, bucket }),
        membershipPath,
      );
      const membershipPaths = normalizeRemoteMembershipPaths(
        (await readFile(membershipPath, "utf8")).split(/\r?\n/gu).filter(Boolean),
      );
      stage = `r2_hash_${bucket}`;
      const entries = await inventoryRemoteMembership(mirror, membershipPaths);
      // Persist the bucket directory entry itself in the shared objects root.
      await syncDirectory(layout.objects);
      r2Inventories.push({
        bucket,
        entries,
      });
    }

    stage = "manifest";
    const manifest = buildBackupManifest({
      snapshotId,
      startedAtUtc: startedAt.toISOString(),
      completedAtUtc: new Date().toISOString(),
      repositoryCommit: await repositoryCommit(),
      nodeVersion: process.version,
      wranglerVersion: tools.wranglerVersion,
      rcloneVersion: tools.rcloneVersion,
      cloudflareAccountId: tools.r2Identity.accountId,
      d1DatabaseId: tools.d1Identity.databaseId,
      d1,
      r2Inventories,
    });
    const manifestJson = stableManifestJson(manifest);
    const manifestHash = createHash("sha256").update(manifestJson).digest("hex");
    const manifestPartial = path.join(staging, "manifest.json.partial");
    const manifestFinal = path.join(staging, "manifest.json");
    await writePrivateFile(manifestPartial, manifestJson, { exclusive: true });
    await rename(manifestPartial, manifestFinal);
    const hashPartial = path.join(staging, "manifest.sha256.partial");
    const hashFinal = path.join(staging, "manifest.sha256");
    await writePrivateFile(hashPartial, `${manifestHash}  manifest.json\n`, { exclusive: true });
    await rename(hashPartial, hashFinal);
    await syncDirectory(staging);

    stage = "publish_snapshot";
    await rename(staging, finalSnapshot);
    published = true;
    await syncDirectory(path.dirname(finalSnapshot));
    stage = "update_latest";
    await writeAtomicPointer(destination, snapshotId);
    console.error(`[backup] Complete snapshot published: ${finalSnapshot}`);
    return { snapshotId, finalSnapshot };
  } catch (error) {
    if (!published) {
      await recordFailedStaging({ staging, failed, snapshotId, stage, error }).catch(() => {});
    } else {
      console.error(`[backup] Snapshot ${snapshotId} is complete, but the LATEST pointer could not be updated.`);
    }
    throw codedError(error?.code ?? "backup_failed", `Backup failed during ${stage}`);
  } finally {
    await releaseLock().catch(() => {});
  }
}

async function main() {
  let options;
  try {
    options = parseBackupArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[backup] ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.mode === "help") {
    process.stdout.write(usage());
    return;
  }
  try {
    const destination = await resolveDestination(options.destination, { mayCreate: options.mode === "init" });
    if (options.mode === "init") {
      await initializeBackupRoot(destination, options);
      console.error(`[backup] Dedicated private backup root initialized: ${destination}`);
      return;
    }
    await runProductionBackup(options, destination);
  } catch (error) {
    console.error(`[backup] ${error?.code ?? "backup_failed"}: ${error?.message ?? "Backup failed"}`);
    process.exitCode = 1;
  }
}

await main();
