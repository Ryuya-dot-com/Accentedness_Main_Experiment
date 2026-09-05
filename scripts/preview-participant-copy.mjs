import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { seedVisit, silenceWav } from "../test/helpers/participant-copy-fixture.js";

// Local synthetic ZIP QA only. No remote URLs, credentials, persistent storage, or seed endpoint.
const visitTypes = ["pre", "immediate", "delayed"];
const previewVisit = process.argv[2] ?? "delayed";
assert.ok(visitTypes.includes(previewVisit) && process.argv.length <= 3, "Use pre, immediate, or delayed");
const includedVisits = visitTypes.slice(0, visitTypes.indexOf(previewVisit) + 1);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const previewRoot = mkdtempSync(join(tmpdir(), "accentedness-copy-preview-"));
const localSecrets = {
  ADMIN_TOKEN: "local-fixture-admin-not-a-real-credential",
  RANDOMIZATION_SECRET: "local-fixture-randomization-not-a-real-credential",
};
const server = createTestHarness({
  // Keep Wrangler's .dev.vars/.env discovery outside the repository.
  root: previewRoot,
  workers: [{ config: {
    name: "participant-copy-local-fixture",
    main: `${projectRoot}src/index.js`,
    compatibility_date: "2026-08-25",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: `${projectRoot}public`, binding: "ASSETS", run_worker_first: ["/api/*"],
      html_handling: "auto-trailing-slash", not_found_handling: "404-page",
    },
    d1_databases: [{
      binding: "DB", database_name: "participant-copy-local-fixture",
      database_id: "00000000-0000-4000-8000-000000000901",
      migrations_dir: `${projectRoot}migrations`, remote: false,
    }],
    r2_buckets: [
      { binding: "RECORDINGS", bucket_name: "participant-copy-local-recordings", remote: false },
      { binding: "STIMULI", bucket_name: "participant-copy-local-stimuli", remote: false },
    ],
    vars: {
      ENVIRONMENT: "development",
      ...localSecrets,
      ASSIGNMENT_VERSION: "main-v10-english-practice-placeholder",
      SEED_ALGORITHM_VERSION: "hmac-sha256+xoshiro128ss-v1",
      ASSET_VERSION: "placeholder-v2",
      ALLOW_PLACEHOLDER_ASSETS: "true",
      ALLOW_DEVELOPMENT_PARTICIPANTS: "true",
      TEST_TOKEN_POLICY: "same_token",
      SESSION_TTL_SECONDS: "43200",
      MAX_RECORDING_BYTES: "4194304",
    },
  } }],
});

async function post(path, body, token) {
  const response = await server.fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(json)}`);
  return json;
}

try {
  const { url } = await server.listen();
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Loopback only");
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  for (const [name, value] of Object.entries(localSecrets)) {
    assert.ok(env[name] === value, `Unexpected credential binding: ${name}`);
  }
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM participants").first("n"), 0);
  const recordingBytes = silenceWav();
  assert.equal(recordingBytes.byteLength, 960_044);
  for (const visitType of includedVisits) {
    if (visitType === "delayed") {
      // Only this disposable local fixture bypasses elapsed time; live pilot data is untouched.
      await env.DB.prepare("UPDATE visits SET target_at_ms = 1, available_at_ms = 1 WHERE visit_type = 'delayed'").run();
    }
    const state = await post("/api/participant-access/start", {
      participant_id: 901, participant_id_confirmed: true,
      client_instance_id: crypto.randomUUID(), expected_visit_type: visitType,
    });
    await seedVisit(env, state.visit.visit_id, state.session.session_id, visitType, { recordingBytes });
    const forbidden = await server.fetch("/api/visit/results.zip", {
      headers: { Authorization: `Bearer ${state.session_token}` },
    });
    assert.equal(forbidden.status, 409,
      "Participant ZIP must stay gated before visit finalization");
    await forbidden.body.cancel();
    // Chrome must finalize the selected visit through the unchanged completion API.
    if (visitType !== previewVisit) await post("/api/visit/complete", {}, state.session_token);
  }
  const counts = await env.DB.prepare(`
    SELECT v.visit_type, COUNT(*) AS responses,
      SUM(CASE WHEN r.state = 'uploaded' THEN 1 ELSE 0 END) AS wavs
    FROM visits v JOIN trial_manifest tm ON tm.visit_uuid = v.visit_uuid
    JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
    LEFT JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
    GROUP BY v.visit_type ORDER BY v.visit_type
  `).all();
  const expectedCounts = [
    { visit_type: "delayed", responses: 59, wavs: 54 },
    { visit_type: "immediate", responses: 205, wavs: 54 },
    { visit_type: "pre", responses: 26, wavs: 24 },
  ].filter((row) => includedVisits.includes(row.visit_type));
  assert.deepEqual(counts.results, expectedCounts);
  const responseCount = expectedCounts.reduce((sum, row) => sum + row.responses, 0);
  const recordingCount = expectedCounts.reduce((sum, row) => sum + row.wavs, 0);
  assert.equal(await env.DB.prepare("SELECT SUM(byte_count) AS n FROM recordings").first("n"), recordingCount * recordingBytes.byteLength);
  console.log(`LOCAL SYNTHETIC ONLY — ID 901 — ${responseCount} responses / ${recordingCount} WAV / ${recordingCount * recordingBytes.byteLength} audio bytes`);
  const path = previewVisit === "pre" ? "/pre-picture-naming/" : `/${previewVisit}-l2-to-l1/`;
  console.log(new URL(path, url).href);
  console.log("Use Chrome: ID 901 → confirm → start → automatic ZIP download → manual re-download link. No microphone rehearsal is needed. Ctrl-C closes the disposable fixture.");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} catch (error) {
  server.debug();
  throw error;
} finally {
  try {
    await server.close();
  } finally {
    rmSync(previewRoot, { recursive: true, force: true });
  }
}
