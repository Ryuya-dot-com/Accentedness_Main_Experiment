export const BACKUP_SCHEMA_VERSION = 2;
export const BACKUP_MARKER_FILENAME = ".accentedness-backup-root.json";
export const BACKUP_MARKER_KIND = "accentedness-main-experiment-backup-root";
export const PRODUCTION_ENVIRONMENT = "production";
export const PRODUCTION_D1_DATABASE = "main-experiment-production";
export const PRODUCTION_R2_BUCKETS = Object.freeze([
  "main-experiment-recordings-production",
  "main-experiment-exports-production",
  "main-experiment-stimuli-production",
]);
export const MINIMUM_RCLONE_VERSION = Object.freeze([1, 75, 0]);

const FORBIDDEN_SECRET_OPTION = /(?:token|secret|password|access[-_]?key|credential)/iu;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CLOUDFLARE_ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const D1_DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KNOWN_SYNC_ROOT = /\/(?:dropbox(?: \([^/]+\))?|onedrive(?: - [^/]+)?|google drive|icloud drive|library\/cloudstorage|library\/mobile documents)(?:\/|$)/iu;
const FORBIDDEN_BACKUP_ENVIRONMENT_KEYS = new Set([
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CF_API_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_AUTH_DOMAIN",
  "WRANGLER_AUTH_URL",
  "WRANGLER_TOKEN_URL",
  "WRANGLER_REVOKE_URL",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "RCLONE_CONFIG",
  "RCLONE_CONFIG_PASS",
  "RCLONE_PASSWORD_COMMAND",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_ENDPOINT_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requireSingleValue(options, name) {
  const values = options.get(name) ?? [];
  if (values.length !== 1 || typeof values[0] !== "string" || values[0].length === 0) {
    fail("invalid_cli_option", `${name} must be provided exactly once with a value`);
  }
  return values[0];
}

function assertSafeName(value, label) {
  if (!SAFE_NAME.test(value)) {
    fail("invalid_cli_option", `${label} must be a simple profile or remote name`);
  }
  return value;
}

function assertCloudflareAccountId(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (!CLOUDFLARE_ACCOUNT_ID.test(normalized)) {
    fail("invalid_cli_option", "Expected Cloudflare account ID must be 32 lowercase hexadecimal characters");
  }
  return normalized;
}

function assertD1DatabaseId(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (!D1_DATABASE_ID.test(normalized)) {
    fail("invalid_cli_option", "Expected D1 database ID must be a lowercase UUID");
  }
  return normalized;
}

/**
 * Parse the intentionally small backup CLI surface. Secrets are never accepted
 * as command-line options, because argv is commonly retained in shell history
 * and process listings.
 */
export function parseBackupArgs(argv) {
  if (!Array.isArray(argv)) fail("invalid_cli", "argv must be an array");
  const [mode, ...tokens] = argv;
  if (mode === "--help" || mode === "-h" || mode === "help") return { mode: "help" };
  if (!new Set(["init", "run"]).has(mode)) {
    fail("invalid_cli_mode", "mode must be init or run");
  }

  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      fail("invalid_cli_option", "Every argument after the mode must be a named option");
    }
    if (FORBIDDEN_SECRET_OPTION.test(token)) {
      fail("secret_cli_option_forbidden", "Secret values must not be supplied on the command line");
    }
    if (new Set(["--confirm-d1-quiet-window", "--confirm-encrypted-storage"]).has(token)) {
      const current = options.get(token) ?? [];
      current.push(true);
      options.set(token, current);
      continue;
    }
    if (index + 1 >= tokens.length || String(tokens[index + 1]).startsWith("--")) {
      fail("invalid_cli_option", `${token} requires a value`);
    }
    const value = String(tokens[index + 1]);
    if (value.includes("\0") || /[\r\n]/u.test(value)) {
      fail("invalid_cli_option", `${token} contains a forbidden control character`);
    }
    const current = options.get(token) ?? [];
    current.push(value);
    options.set(token, current);
    index += 1;
  }

  const allowed = mode === "init"
    ? new Set(["--destination", "--confirm-encrypted-storage"])
    : new Set([
        "--destination",
        "--rclone-remote",
        "--wrangler-profile",
        "--expected-cloudflare-account-id",
        "--expected-d1-database-id",
        "--confirm-d1-quiet-window",
        "--confirm-encrypted-storage",
      ]);
  for (const option of options.keys()) {
    if (!allowed.has(option)) fail("unknown_cli_option", `Unknown option: ${option}`);
  }

  const destination = requireSingleValue(options, "--destination");
  const encryptionConfirmations = options.get("--confirm-encrypted-storage") ?? [];
  if (encryptionConfirmations.length !== 1) {
    fail(
      "encrypted_storage_confirmation_required",
      "Sensitive research backup requires exactly one --confirm-encrypted-storage flag",
    );
  }
  if (mode === "init") return { mode, destination, encryptedStorageConfirmed: true };
  const confirmations = options.get("--confirm-d1-quiet-window") ?? [];
  if (confirmations.length !== 1) {
    fail(
      "d1_quiet_window_confirmation_required",
      "Production D1 export requires exactly one --confirm-d1-quiet-window flag",
    );
  }
  return {
    mode,
    destination,
    rcloneRemote: assertSafeName(requireSingleValue(options, "--rclone-remote"), "rclone remote"),
    wranglerProfile: assertSafeName(
      requireSingleValue(options, "--wrangler-profile"),
      "Wrangler profile",
    ),
    expectedCloudflareAccountId: assertCloudflareAccountId(
      requireSingleValue(options, "--expected-cloudflare-account-id"),
    ),
    expectedD1DatabaseId: assertD1DatabaseId(
      requireSingleValue(options, "--expected-d1-database-id"),
    ),
    quietWindowConfirmed: true,
    encryptedStorageConfirmed: true,
  };
}

/**
 * Refuse ambient settings that can silently override the named Wrangler or
 * rclone profiles. Values are never included in the error.
 */
export function assertNoBackupEnvironmentOverrides(environment) {
  const present = Object.keys(environment ?? {}).filter((key) => {
    if (!String(environment[key] ?? "").trim()) return false;
    return FORBIDDEN_BACKUP_ENVIRONMENT_KEYS.has(key) || key.startsWith("RCLONE_");
  });
  if (present.length > 0) {
    fail(
      "ambient_backup_configuration_forbidden",
      `Unset environment overrides before backup: ${present.sort().join(", ")}`,
    );
  }
}

function normalizedBoundaryPath(value) {
  if (value === "/") return value;
  return value.replace(/\/+$/u, "");
}

function sameOrDescendant(candidate, parent) {
  const cleanCandidate = normalizedBoundaryPath(candidate);
  const cleanParent = normalizedBoundaryPath(parent);
  return cleanCandidate === cleanParent || cleanCandidate.startsWith(`${cleanParent}/`);
}

/**
 * Inputs must already be resolved/realpathed by the Node orchestration layer.
 */
export function validateDedicatedRootPath({
  destinationAbsolute,
  repositoryRootAbsolute,
  homeDirectoryAbsolute,
}) {
  const destination = normalizedBoundaryPath(String(destinationAbsolute ?? ""));
  const repository = normalizedBoundaryPath(String(repositoryRootAbsolute ?? ""));
  const home = normalizedBoundaryPath(String(homeDirectoryAbsolute ?? ""));
  if (!destination.startsWith("/")) fail("backup_root_not_absolute", "Backup destination must be absolute");
  if (destination === "/") fail("backup_root_too_broad", "Filesystem root cannot be a backup destination");
  if (home && destination === home) fail("backup_root_too_broad", "Home directory cannot be a backup destination");
  if (repository && sameOrDescendant(destination, repository)) {
    fail("backup_root_inside_repository", "Backup destination must be outside the repository");
  }
  if (repository && sameOrDescendant(repository, destination)) {
    fail("backup_root_contains_repository", "A repository ancestor cannot be a backup destination");
  }
  if (KNOWN_SYNC_ROOT.test(destination)) {
    fail(
      "backup_root_in_known_sync_storage",
      "Known consumer cloud-sync roots cannot store the sensitive local backup",
    );
  }
  return destination;
}

export function createBackupMarker(createdAtUtc, { encryptedStorageConfirmed = false } = {}) {
  if (Number.isNaN(Date.parse(createdAtUtc))) fail("invalid_timestamp", "Marker timestamp is invalid");
  if (!encryptedStorageConfirmed) {
    fail("encrypted_storage_confirmation_required", "Encrypted storage must be explicitly confirmed");
  }
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    kind: BACKUP_MARKER_KIND,
    created_at_utc: createdAtUtc,
    data_classification: "sensitive_research_data",
    encrypted_storage_attested: true,
    encrypted_storage_attested_at_utc: createdAtUtc,
    r2_copy_policy: "additive_immutable",
  };
}

export function isValidBackupMarker(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && value.schema_version === BACKUP_SCHEMA_VERSION
    && value.kind === BACKUP_MARKER_KIND
    && value.data_classification === "sensitive_research_data"
    && value.encrypted_storage_attested === true
    && typeof value.encrypted_storage_attested_at_utc === "string"
    && !Number.isNaN(Date.parse(value.encrypted_storage_attested_at_utc))
    && value.r2_copy_policy === "additive_immutable"
    && typeof value.created_at_utc === "string"
    && !Number.isNaN(Date.parse(value.created_at_utc));
}

export function createSnapshotId(date, randomHex) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    fail("invalid_timestamp", "Snapshot date is invalid");
  }
  if (!/^[0-9a-f]{12}$/u.test(randomHex)) {
    fail("invalid_snapshot_suffix", "Snapshot suffix must contain 12 lowercase hexadecimal characters");
  }
  const timestamp = date.toISOString().replace(/[-:]/gu, "").replace(".", "");
  return `${timestamp}-${randomHex}`;
}

export function buildWranglerExportArgs({ outputPath, profile, envFilePath }) {
  if (!String(outputPath ?? "").startsWith("/")) {
    fail("invalid_export_path", "D1 export output path must be absolute");
  }
  if (!String(envFilePath ?? "").startsWith("/")) {
    fail("invalid_env_file_path", "Wrangler env-file path must be absolute");
  }
  assertSafeName(profile, "Wrangler profile");
  return [
    "d1",
    "export",
    PRODUCTION_D1_DATABASE,
    "--remote",
    "--env",
    PRODUCTION_ENVIRONMENT,
    "--skip-confirmation",
    "--output",
    outputPath,
    "--env-file",
    envFilePath,
    "--profile",
    profile,
  ];
}

export function buildWranglerD1InfoArgs({ profile, envFilePath }) {
  assertSafeName(profile, "Wrangler profile");
  if (!String(envFilePath ?? "").startsWith("/")) {
    fail("invalid_env_file_path", "Wrangler env-file path must be absolute");
  }
  return [
    "d1",
    "info",
    PRODUCTION_D1_DATABASE,
    "--env",
    PRODUCTION_ENVIRONMENT,
    "--json",
    "--env-file",
    envFilePath,
    "--profile",
    profile,
  ];
}

export function buildRcloneCopyArgs({ remote, bucket, destinationPath }) {
  assertSafeName(remote, "rclone remote");
  if (!PRODUCTION_R2_BUCKETS.includes(bucket)) fail("invalid_r2_bucket", "Unexpected R2 bucket");
  if (!String(destinationPath ?? "").startsWith("/")) {
    fail("invalid_r2_destination", "R2 destination path must be absolute");
  }
  return ["copy", `${remote}:${bucket}`, destinationPath, "--immutable"];
}

export function buildRcloneCheckArgs({ remote, bucket, destinationPath }) {
  assertSafeName(remote, "rclone remote");
  if (!PRODUCTION_R2_BUCKETS.includes(bucket)) fail("invalid_r2_bucket", "Unexpected R2 bucket");
  if (!String(destinationPath ?? "").startsWith("/")) {
    fail("invalid_r2_destination", "R2 destination path must be absolute");
  }
  // One-way verification requires every current remote object to exist locally,
  // while allowing the additive mirror to retain objects removed by lifecycle.
  // --download avoids silently degrading to size-only verification when an R2
  // object has no comparable remote hash (for example, a multipart object).
  return ["check", `${remote}:${bucket}`, destinationPath, "--one-way", "--download"];
}

export function buildRcloneListArgs({ remote, bucket }) {
  assertSafeName(remote, "rclone remote");
  if (!PRODUCTION_R2_BUCKETS.includes(bucket)) fail("invalid_r2_bucket", "Unexpected R2 bucket");
  return ["lsf", `${remote}:${bucket}`, "--recursive", "--files-only", "--format", "p"];
}

export function buildRcloneRedactedConfigArgs({ remote }) {
  assertSafeName(remote, "rclone remote");
  return ["config", "redacted", remote];
}

export function verifyD1Identity(jsonText, expectedDatabaseId) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText));
  } catch {
    fail("d1_identity_invalid", "Wrangler D1 identity output was not valid JSON");
  }
  const expected = assertD1DatabaseId(expectedDatabaseId);
  if (String(parsed?.uuid ?? "").toLowerCase() !== expected
      || parsed?.name !== PRODUCTION_D1_DATABASE) {
    fail("d1_identity_mismatch", "Resolved D1 database does not match the pinned production identity");
  }
  return { databaseId: expected, databaseName: PRODUCTION_D1_DATABASE };
}

function parseRedactedIni(text) {
  const sections = new Map();
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/u.exec(line);
    if (section) {
      current = new Map();
      sections.set(section[1], current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator <= 0) continue;
    current.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return sections;
}

export function verifyRcloneIdentity(redactedConfig, remote, expectedAccountId) {
  assertSafeName(remote, "rclone remote");
  const expected = assertCloudflareAccountId(expectedAccountId);
  const section = parseRedactedIni(redactedConfig).get(remote);
  const unsafeGlobalKeys = [...(section?.keys() ?? [])].filter(
    (key) => key.startsWith("global.") || key.startsWith("override."),
  );
  if (unsafeGlobalKeys.length > 0) {
    fail(
      "rclone_global_override_forbidden",
      `rclone remote contains forbidden global/override keys: ${unsafeGlobalKeys.sort().join(", ")}`,
    );
  }
  const envAuth = section?.get("env_auth")?.toLowerCase();
  if (!section
      || section.get("type")?.toLowerCase() !== "s3"
      || section.get("provider")?.toLowerCase() !== "cloudflare"
      || (envAuth !== undefined && envAuth !== "false")) {
    fail("rclone_identity_invalid", "rclone remote must be a fixed Cloudflare R2 S3 profile without env_auth");
  }
  let endpoint;
  try {
    endpoint = new URL(section.get("endpoint"));
  } catch {
    fail("rclone_identity_invalid", "rclone remote has no valid Cloudflare R2 endpoint");
  }
  if (endpoint.protocol !== "https:"
      || endpoint.username
      || endpoint.password
      || endpoint.port
      || endpoint.search
      || endpoint.hash
      || !new Set(["", "/"]).has(endpoint.pathname)
      || endpoint.hostname !== `${expected}.r2.cloudflarestorage.com`) {
    fail("rclone_identity_mismatch", "rclone endpoint does not match the pinned Cloudflare account");
  }
  return { accountId: expected, endpointOrigin: endpoint.origin };
}

export function verifyRcloneVersion(versionOutput) {
  const match = /^rclone v(\d+)\.(\d+)\.(\d+)(?:\s|$)/mu.exec(String(versionOutput));
  if (!match) {
    fail("rclone_version_invalid", "Could not parse a stable rclone version");
  }
  const actual = match.slice(1, 4).map(Number);
  const acceptable = actual.some((value, index) => (
    value > MINIMUM_RCLONE_VERSION[index]
      && actual.slice(0, index).every((prior, priorIndex) => prior === MINIMUM_RCLONE_VERSION[priorIndex])
  )) || actual.every((value, index) => value === MINIMUM_RCLONE_VERSION[index]);
  if (!acceptable) {
    fail("rclone_version_unsupported", "rclone 1.75.0 or newer is required for safe local backup");
  }
  return `rclone v${actual.join(".")}`;
}

function assertSafeRelativePath(relativePath) {
  const value = String(relativePath ?? "");
  const parts = value.split("/");
  if (!value || value.startsWith("/") || value.includes("\\") || parts.includes("..") || parts.includes(".")) {
    fail("unsafe_inventory_path", "Inventory paths must be safe, slash-separated relative paths");
  }
  return value;
}

export function normalizeRemoteMembershipPaths(paths) {
  if (!Array.isArray(paths)) fail("invalid_remote_membership", "Remote membership must be an array");
  const normalized = paths.map(assertSafeRelativePath);
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    fail("duplicate_remote_membership_path", "Remote membership paths must be unique");
  }
  return [...unique].sort((left, right) => left.localeCompare(right, "en"));
}

export function normalizeInventoryEntries(entries) {
  if (!Array.isArray(entries)) fail("invalid_inventory", "Inventory must be an array");
  const seen = new Set();
  const normalized = entries.map((entry) => {
    const relativePath = assertSafeRelativePath(entry?.relative_path);
    const byteCount = Number(entry?.byte_count);
    const sha256 = String(entry?.sha256 ?? "");
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      fail("invalid_inventory_size", "Inventory byte counts must be non-negative safe integers");
    }
    if (!SHA256.test(sha256)) fail("invalid_inventory_hash", "Inventory SHA-256 is invalid");
    if (seen.has(relativePath)) fail("duplicate_inventory_path", "Inventory paths must be unique");
    seen.add(relativePath);
    return { relative_path: relativePath, byte_count: byteCount, sha256 };
  });
  return normalized.sort((left, right) => left.relative_path.localeCompare(right.relative_path, "en"));
}

function validIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("invalid_timestamp", `${label} is not a valid timestamp`);
  }
  return value;
}

export function buildBackupManifest({
  snapshotId,
  startedAtUtc,
  completedAtUtc,
  repositoryCommit,
  nodeVersion,
  wranglerVersion,
  rcloneVersion,
  cloudflareAccountId,
  d1DatabaseId,
  d1,
  r2Inventories,
}) {
  if (!/^\d{8}T\d{9}Z-[0-9a-f]{12}$/u.test(snapshotId)) {
    fail("invalid_snapshot_id", "Snapshot ID is invalid");
  }
  if (!/^[0-9a-f]{40}$/u.test(repositoryCommit) && repositoryCommit !== "unknown") {
    fail("invalid_repository_commit", "Repository commit must be a full SHA-1 or unknown");
  }
  const sourceAccountId = assertCloudflareAccountId(cloudflareAccountId);
  const sourceD1DatabaseId = assertD1DatabaseId(d1DatabaseId);
  if (!d1 || !SHA256.test(String(d1.sha256 ?? ""))) {
    fail("invalid_d1_hash", "D1 export SHA-256 is invalid");
  }
  if (!Number.isSafeInteger(Number(d1.byte_count)) || Number(d1.byte_count) <= 0) {
    fail("invalid_d1_size", "D1 export must be non-empty");
  }
  const inventories = new Map(
    (r2Inventories ?? []).map((inventory) => [inventory.bucket, inventory.entries]),
  );
  const buckets = PRODUCTION_R2_BUCKETS.map((bucket) => {
    if (!inventories.has(bucket)) fail("missing_r2_inventory", `Missing inventory for ${bucket}`);
    const objects = normalizeInventoryEntries(inventories.get(bucket));
    return {
      bucket,
      copy_policy: "additive_immutable",
      membership_scope: "current_remote_objects_at_snapshot",
      remote_verification: "rclone_check_one_way_download",
      local_durability: "fsync_current_objects_and_directories_before_publish",
      object_count: objects.length,
      total_bytes: objects.reduce((sum, object) => sum + object.byte_count, 0),
      objects,
    };
  });
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    status: "complete",
    snapshot_id: snapshotId,
    started_at_utc: validIsoTimestamp(startedAtUtc, "started_at_utc"),
    completed_at_utc: validIsoTimestamp(completedAtUtc, "completed_at_utc"),
    source: {
      environment: PRODUCTION_ENVIRONMENT,
      cloudflare_account_id: sourceAccountId,
      d1_database: PRODUCTION_D1_DATABASE,
      d1_database_id: sourceD1DatabaseId,
      r2_buckets: [...PRODUCTION_R2_BUCKETS],
      d1_quiet_window_confirmed: true,
      encrypted_storage_attested: true,
      consistency_note: "D1 export completed before additive R2 copies; later R2 objects may be included.",
    },
    repository_commit: repositoryCommit,
    tools: {
      node: String(nodeVersion),
      wrangler: String(wranglerVersion),
      rclone: String(rcloneVersion),
    },
    d1: {
      relative_path: assertSafeRelativePath(d1.relative_path),
      byte_count: Number(d1.byte_count),
      sha256: d1.sha256,
    },
    r2: buckets,
  };
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortRecursively(value[key])]),
  );
}

export function stableManifestJson(manifest) {
  return `${JSON.stringify(sortRecursively(manifest), null, 2)}\n`;
}

export function buildFailureRecord({ snapshotId, stage, failedAtUtc, errorCode }) {
  const rawStage = String(stage ?? "unknown");
  const rawCode = String(errorCode ?? "backup_failed");
  const safeStage = FORBIDDEN_SECRET_OPTION.test(rawStage)
    ? "redacted"
    : rawStage.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  const safeCode = FORBIDDEN_SECRET_OPTION.test(rawCode)
    ? "redacted"
    : rawCode.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 80);
  return {
    schema_version: BACKUP_SCHEMA_VERSION,
    status: "failed",
    snapshot_id: snapshotId,
    failed_at_utc: validIsoTimestamp(failedAtUtc, "failed_at_utc"),
    stage: safeStage || "unknown",
    error_code: safeCode || "backup_failed",
  };
}
