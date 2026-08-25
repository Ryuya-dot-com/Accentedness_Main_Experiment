import { describe, expect, it } from "vitest";
import {
  BACKUP_MARKER_KIND,
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
  normalizeInventoryEntries,
  normalizeRemoteMembershipPaths,
  parseBackupArgs,
  stableManifestJson,
  validateDedicatedRootPath,
  verifyD1Identity,
  verifyRcloneIdentity,
  verifyRcloneVersion,
} from "../scripts/lib/backup-plan.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SNAPSHOT_ID = "20260825T120102003Z-abcdef012345";
const ACCOUNT_ID = "a".repeat(32);
const D1_DATABASE_ID = "11111111-2222-3333-4444-555555555555";
const WRANGLER_ENV_FILE = "/secure/.staging/id/wrangler-empty.env";

describe("backup CLI plan", () => {
  it("parses init with one explicit destination and no credentials", () => {
    expect(parseBackupArgs([
      "init",
      "--destination",
      "/Volumes/Encrypted/backup",
      "--confirm-encrypted-storage",
    ])).toEqual({
      mode: "init",
      destination: "/Volumes/Encrypted/backup",
      encryptedStorageConfirmed: true,
    });
    expect(() => parseBackupArgs(["init", "--destination", "/Volumes/Encrypted/backup"]))
      .toThrowError(expect.objectContaining({ code: "encrypted_storage_confirmation_required" }));
  });

  it("requires explicit production controls for a full run", () => {
    expect(parseBackupArgs([
      "run",
      "--destination",
      "/Volumes/Encrypted/backup",
      "--wrangler-profile",
      "research-production",
      "--rclone-remote",
      "accentedness-r2",
      "--expected-cloudflare-account-id",
      ACCOUNT_ID,
      "--expected-d1-database-id",
      D1_DATABASE_ID,
      "--confirm-d1-quiet-window",
      "--confirm-encrypted-storage",
    ])).toEqual({
      mode: "run",
      destination: "/Volumes/Encrypted/backup",
      wranglerProfile: "research-production",
      rcloneRemote: "accentedness-r2",
      expectedCloudflareAccountId: ACCOUNT_ID,
      expectedD1DatabaseId: D1_DATABASE_ID,
      quietWindowConfirmed: true,
      encryptedStorageConfirmed: true,
    });

    expect(() => parseBackupArgs([
      "run",
      "--destination",
      "/Volumes/Encrypted/backup",
      "--wrangler-profile",
      "research-production",
      "--rclone-remote",
      "accentedness-r2",
      "--expected-cloudflare-account-id",
      ACCOUNT_ID,
      "--expected-d1-database-id",
      D1_DATABASE_ID,
      "--confirm-encrypted-storage",
    ])).toThrowError(expect.objectContaining({ code: "d1_quiet_window_confirmation_required" }));
  });

  it("rejects ambient profile overrides without exposing their values", () => {
    expect(() => assertNoBackupEnvironmentOverrides({
      CLOUDFLARE_API_TOKEN: "do-not-report",
    })).toThrowError(expect.objectContaining({
      code: "ambient_backup_configuration_forbidden",
      message: expect.not.stringContaining("do-not-report"),
    }));
    expect(() => assertNoBackupEnvironmentOverrides({
      RCLONE_S3_ENDPOINT: "https://wrong.invalid",
    })).toThrowError(expect.objectContaining({ code: "ambient_backup_configuration_forbidden" }));
    expect(assertNoBackupEnvironmentOverrides({ CLOUDFLARE_AUTH_USE_KEYRING: "true" }))
      .toBeUndefined();
  });

  it("rejects secret-bearing, duplicate, and unknown CLI options", () => {
    expect(() => parseBackupArgs([
      "run",
      "--destination",
      "/private/backup",
      "--api-token",
      "must-not-enter-argv",
    ])).toThrowError(expect.objectContaining({ code: "secret_cli_option_forbidden" }));
    expect(() => parseBackupArgs([
      "init",
      "--destination",
      "/private/one",
      "--destination",
      "/private/two",
    ])).toThrowError(expect.objectContaining({ code: "invalid_cli_option" }));
    expect(() => parseBackupArgs([
      "init",
      "--destination",
      "/private/backup",
      "--force",
      "yes",
    ])).toThrowError(expect.objectContaining({ code: "unknown_cli_option" }));
  });

  it("keeps the backup root absolute, narrow, and outside the repository", () => {
    const context = {
      repositoryRootAbsolute: "/Users/research/project",
      homeDirectoryAbsolute: "/Users/research",
    };
    expect(validateDedicatedRootPath({
      ...context,
      destinationAbsolute: "/Volumes/Encrypted/accentedness-backup/",
    })).toBe("/Volumes/Encrypted/accentedness-backup");
    for (const destinationAbsolute of [
      "relative/backup",
      "/",
      "/Users/research",
      "/Users/research/project",
      "/Users/research/project/private-backup",
      "/Users",
      "/Users/research/Dropbox/accentedness-backup",
      "/Users/research/Dropbox (Personal)/accentedness-backup",
      "/Users/research/OneDrive - University/accentedness-backup",
      "/Users/research/Library/CloudStorage/provider/accentedness-backup",
      "/Users/research/Library/Mobile Documents/com~apple~CloudDocs/accentedness-backup",
    ]) {
      expect(() => validateDedicatedRootPath({ ...context, destinationAbsolute })).toThrow();
    }
  });

  it("creates and validates a dedicated sensitive-data marker", () => {
    const marker = createBackupMarker("2026-08-25T12:01:02.003Z", {
      encryptedStorageConfirmed: true,
    });
    expect(marker.kind).toBe(BACKUP_MARKER_KIND);
    expect(marker.r2_copy_policy).toBe("additive_immutable");
    expect(marker.encrypted_storage_attested).toBe(true);
    expect(isValidBackupMarker(marker)).toBe(true);
    expect(isValidBackupMarker({ ...marker, r2_copy_policy: "sync" })).toBe(false);
    expect(() => createBackupMarker("2026-08-25T12:01:02.003Z"))
      .toThrowError(expect.objectContaining({ code: "encrypted_storage_confirmation_required" }));
  });

  it("builds collision-resistant sortable snapshot identifiers", () => {
    expect(createSnapshotId(new Date("2026-08-25T12:01:02.003Z"), "abcdef012345"))
      .toBe(SNAPSHOT_ID);
    expect(() => createSnapshotId(new Date("invalid"), "abcdef012345")).toThrow();
    expect(() => createSnapshotId(new Date(), "not-hex")).toThrow();
  });

  it("builds fixed production commands without destructive R2 verbs or credentials", () => {
    const wrangler = buildWranglerExportArgs({
      outputPath: "/secure/.staging/id/d1/database.sql.partial",
      profile: "research-production",
      envFilePath: WRANGLER_ENV_FILE,
    });
    expect(wrangler).toEqual([
      "d1",
      "export",
      PRODUCTION_D1_DATABASE,
      "--remote",
      "--env",
      "production",
      "--skip-confirmation",
      "--output",
      "/secure/.staging/id/d1/database.sql.partial",
      "--env-file",
      WRANGLER_ENV_FILE,
      "--profile",
      "research-production",
    ]);
    const rclone = buildRcloneCopyArgs({
      remote: "accentedness-r2",
      bucket: PRODUCTION_R2_BUCKETS[0],
      destinationPath: "/secure/objects/recordings",
    });
    expect(rclone).toEqual([
      "copy",
      `accentedness-r2:${PRODUCTION_R2_BUCKETS[0]}`,
      "/secure/objects/recordings",
      "--immutable",
    ]);
    expect(rclone).not.toContain("sync");
    expect(rclone).not.toContain("delete");
    const check = buildRcloneCheckArgs({
      remote: "accentedness-r2",
      bucket: PRODUCTION_R2_BUCKETS[0],
      destinationPath: "/secure/objects/recordings",
    });
    expect(check).toEqual([
      "check",
      `accentedness-r2:${PRODUCTION_R2_BUCKETS[0]}`,
      "/secure/objects/recordings",
      "--one-way",
      "--download",
    ]);
    const list = buildRcloneListArgs({
      remote: "accentedness-r2",
      bucket: PRODUCTION_R2_BUCKETS[0],
    });
    expect(list).toEqual([
      "lsf",
      `accentedness-r2:${PRODUCTION_R2_BUCKETS[0]}`,
      "--recursive",
      "--files-only",
      "--format",
      "p",
    ]);
    const info = buildWranglerD1InfoArgs({
      profile: "research-production",
      envFilePath: WRANGLER_ENV_FILE,
    });
    expect(info).toEqual([
      "d1",
      "info",
      PRODUCTION_D1_DATABASE,
      "--env",
      "production",
      "--json",
      "--env-file",
      WRANGLER_ENV_FILE,
      "--profile",
      "research-production",
    ]);
    const redacted = buildRcloneRedactedConfigArgs({ remote: "accentedness-r2" });
    expect(redacted).toEqual(["config", "redacted", "accentedness-r2"]);
    expect([...wrangler, ...rclone, ...check, ...list, ...info, ...redacted].join(" "))
      .not.toMatch(/token|password|access.key/iu);
  });

  it("pins the resolved D1 and R2 identities", () => {
    expect(verifyD1Identity(JSON.stringify({
      uuid: D1_DATABASE_ID,
      name: PRODUCTION_D1_DATABASE,
    }), D1_DATABASE_ID)).toEqual({
      databaseId: D1_DATABASE_ID,
      databaseName: PRODUCTION_D1_DATABASE,
    });
    expect(() => verifyD1Identity(JSON.stringify({
      uuid: "99999999-2222-3333-4444-555555555555",
      name: PRODUCTION_D1_DATABASE,
    }), D1_DATABASE_ID)).toThrowError(expect.objectContaining({ code: "d1_identity_mismatch" }));

    const redacted = `[accentedness-r2]\ntype = s3\nprovider = Cloudflare\nenv_auth = false\nendpoint = https://${ACCOUNT_ID}.r2.cloudflarestorage.com\naccess_key_id = XXX\nsecret_access_key = XXX\n`;
    expect(verifyRcloneIdentity(redacted, "accentedness-r2", ACCOUNT_ID)).toEqual({
      accountId: ACCOUNT_ID,
      endpointOrigin: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    });
    expect(() => verifyRcloneIdentity(
      redacted.replace(ACCOUNT_ID, "b".repeat(32)),
      "accentedness-r2",
      ACCOUNT_ID,
    )).toThrowError(expect.objectContaining({ code: "rclone_identity_mismatch" }));
    expect(() => verifyRcloneIdentity(
      redacted.replace("env_auth = false", "env_auth = true"),
      "accentedness-r2",
      ACCOUNT_ID,
    )).toThrowError(expect.objectContaining({ code: "rclone_identity_invalid" }));
    expect(() => verifyRcloneIdentity(
      redacted.replace("env_auth = false", "env_auth = 1"),
      "accentedness-r2",
      ACCOUNT_ID,
    )).toThrowError(expect.objectContaining({ code: "rclone_identity_invalid" }));
    expect(() => verifyRcloneIdentity(
      `${redacted}global.exclude = recordings/**\n`,
      "accentedness-r2",
      ACCOUNT_ID,
    )).toThrowError(expect.objectContaining({ code: "rclone_global_override_forbidden" }));
  });

  it("requires the patched rclone release line", () => {
    expect(verifyRcloneVersion("rclone v1.75.0\n- os/version: test\n")).toBe("rclone v1.75.0");
    expect(verifyRcloneVersion("rclone v2.0.1\n")).toBe("rclone v2.0.1");
    expect(() => verifyRcloneVersion("rclone v1.74.4\n"))
      .toThrowError(expect.objectContaining({ code: "rclone_version_unsupported" }));
    expect(() => verifyRcloneVersion("rclone v1.75.0-beta.1\n"))
      .toThrowError(expect.objectContaining({ code: "rclone_version_invalid" }));
  });
});

describe("backup integrity manifest", () => {
  it("normalizes entries deterministically and rejects unsafe paths", () => {
    expect(normalizeRemoteMembershipPaths(["z/file.wav", "a/file.wav"]))
      .toEqual(["a/file.wav", "z/file.wav"]);
    expect(() => normalizeRemoteMembershipPaths(["same.wav", "same.wav"]))
      .toThrowError(expect.objectContaining({ code: "duplicate_remote_membership_path" }));
    expect(normalizeInventoryEntries([
      { relative_path: "z/file.wav", byte_count: 8, sha256: HASH_B },
      { relative_path: "a/file.wav", byte_count: 4, sha256: HASH_A },
    ])).toEqual([
      { relative_path: "a/file.wav", byte_count: 4, sha256: HASH_A },
      { relative_path: "z/file.wav", byte_count: 8, sha256: HASH_B },
    ]);
    for (const relative_path of ["/absolute.wav", "../escape.wav", "a/../escape.wav", "a\\file.wav"]) {
      expect(() => normalizeInventoryEntries([
        { relative_path, byte_count: 1, sha256: HASH_A },
      ])).toThrowError(expect.objectContaining({ code: "unsafe_inventory_path" }));
    }
  });

  it("records D1 and every production R2 bucket with SHA-256 inventories", () => {
    const manifest = buildBackupManifest({
      snapshotId: SNAPSHOT_ID,
      startedAtUtc: "2026-08-25T12:01:02.003Z",
      completedAtUtc: "2026-08-25T12:05:02.003Z",
      repositoryCommit: "1".repeat(40),
      nodeVersion: "v24.9.0",
      wranglerVersion: "4.125.0",
      rcloneVersion: "rclone v1.75.0",
      cloudflareAccountId: ACCOUNT_ID,
      d1DatabaseId: D1_DATABASE_ID,
      d1: {
        relative_path: `d1/${PRODUCTION_D1_DATABASE}.sql`,
        byte_count: 100,
        sha256: HASH_A,
      },
      r2Inventories: PRODUCTION_R2_BUCKETS.map((bucket, index) => ({
        bucket,
        entries: [{
          relative_path: `${index}/object.bin`,
          byte_count: index + 1,
          sha256: index % 2 === 0 ? HASH_A : HASH_B,
        }],
      })),
    });
    expect(manifest.status).toBe("complete");
    expect(manifest.source.d1_quiet_window_confirmed).toBe(true);
    expect(manifest.source.encrypted_storage_attested).toBe(true);
    expect(manifest.source.cloudflare_account_id).toBe(ACCOUNT_ID);
    expect(manifest.source.d1_database_id).toBe(D1_DATABASE_ID);
    expect(manifest.d1.sha256).toBe(HASH_A);
    expect(manifest.r2.map((entry) => entry.bucket)).toEqual(PRODUCTION_R2_BUCKETS);
    expect(manifest.r2.map((entry) => entry.object_count)).toEqual([1, 1, 1]);
    expect(manifest.r2.every((entry) => (
      entry.membership_scope === "current_remote_objects_at_snapshot"
    ))).toBe(true);
    expect(manifest.r2.every((entry) => (
      entry.remote_verification === "rclone_check_one_way_download"
    ))).toBe(true);
    expect(manifest.r2.every((entry) => (
      entry.local_durability === "fsync_current_objects_and_directories_before_publish"
    ))).toBe(true);
    expect(stableManifestJson(manifest)).toBe(stableManifestJson(structuredClone(manifest)));
  });

  it("refuses incomplete bucket inventories and sanitizes failure records", () => {
    expect(() => buildBackupManifest({
      snapshotId: SNAPSHOT_ID,
      startedAtUtc: "2026-08-25T12:01:02.003Z",
      completedAtUtc: "2026-08-25T12:05:02.003Z",
      repositoryCommit: "unknown",
      nodeVersion: "v24.9.0",
      wranglerVersion: "4.125.0",
      rcloneVersion: "rclone v1.75.0",
      cloudflareAccountId: ACCOUNT_ID,
      d1DatabaseId: D1_DATABASE_ID,
      d1: { relative_path: "d1/database.sql", byte_count: 1, sha256: HASH_A },
      r2Inventories: [],
    })).toThrowError(expect.objectContaining({ code: "missing_r2_inventory" }));

    expect(buildFailureRecord({
      snapshotId: SNAPSHOT_ID,
      stage: "r2 copy; token=do-not-store",
      failedAtUtc: "2026-08-25T12:05:02.003Z",
      errorCode: "command failed: password=do-not-store",
    })).toMatchObject({
      status: "failed",
      stage: "redacted",
      error_code: "redacted",
    });
  });
});
