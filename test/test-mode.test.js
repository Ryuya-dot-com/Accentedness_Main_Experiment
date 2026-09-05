import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const TEST_CONFIG = Object.freeze({
  ENVIRONMENT: "development",
  ASSIGNMENT_VERSION: "test-assignment-v1",
  SEED_ALGORITHM_VERSION: "hmac-sha256+xoshiro128ss-v1",
  RESEARCHER_TEST_ASSET_VERSION: "main-assets-v2",
  ADMIN_TOKEN,
});
const VALID_SCOPES = Object.freeze([
  ["pre", "picture_naming", 26],
  ["immediate", "learning", 146],
  ["immediate", "picture_naming", 26],
  ["immediate", "l2_to_l1", 33],
  ["delayed", "picture_naming", 26],
  ["delayed", "l2_to_l1", 33],
]);

function request(body, method = "POST", token = ADMIN_TOKEN) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request(`${ORIGIN}/api/test/bootstrap`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : null,
  });
}

function assetKey(endpoint) {
  return new URL(endpoint, ORIGIN).searchParams.get("key");
}

async function bootstrap(body, runtimeEnv = null) {
  const response = runtimeEnv
    ? await worker.fetch(request(body), runtimeEnv)
    : await exports.default.fetch(request(body));
  return { response, json: await response.json() };
}

function poisonStorageBindings(configuration = TEST_CONFIG) {
  const runtimeEnv = { ...configuration };
  for (const binding of ["DB", "RECORDINGS", "STIMULI"]) {
    Object.defineProperty(runtimeEnv, binding, {
      enumerable: true,
      get() {
        throw new Error(`${binding} binding must not be accessed by test mode`);
      },
    });
  }
  return runtimeEnv;
}

function allObjectKeys(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry) => allObjectKeys(entry, output));
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    output.push(key);
    allObjectKeys(entry, output);
  }
  return output;
}

describe("non-persistent test-mode bootstrap", () => {
  it.each(VALID_SCOPES)(
    "returns only the requested %s/%s manifest",
    async (visitType, segment, trialCount) => {
      const { response, json } = await bootstrap({
        participant_id: "999",
        expected_visit_type: visitType,
        expected_segment: segment,
      });

      expect(response.status).toBe(200);
      expect(json.test_mode).toBe(true);
      expect(json.participant).toEqual({ id: "999" });
      expect(json.test_run).toEqual({
        training_accent: expect.stringMatching(/^(?:english|chinese|japanese)$/u),
        visit_type: visitType,
        segment,
        persistence: "none",
      });
      expect(json.visit.visit_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(json.manifest).toHaveLength(trialCount);
      expect(new Set(json.manifest.map((trial) => trial.segment))).toEqual(new Set([segment]));
      expect(json.accepted).toEqual([]);
      expect(json.next_trial_id).toBe(json.manifest[0].trial_id);
      expect(json.next_route).toBeNull();
      expect(json.manifest.filter((trial) => trial.current)).toEqual([json.manifest[0]]);
      expect(json.manifest.every((trial) => trial.placeholder_asset === false)).toBe(true);

      const serialized = JSON.stringify(json.manifest);
      expect(serialized).not.toContain("/api/stimuli/");
      for (const trial of json.manifest) {
        if (trial.has_audio) {
          expect(trial.audio_endpoint).toMatch(/^\/api\/test\/stimuli\/audio\?key=/u);
        } else {
          expect(trial.audio_endpoint).toBeNull();
        }
        if (trial.has_image) {
          expect(trial.image_endpoint).toMatch(/^\/api\/test\/stimuli\/image\?key=/u);
        } else {
          expect(trial.image_endpoint).toBeNull();
        }
      }

      const forbiddenManifestKeys = new Set([
        "exclude_from_analysis",
        "item_id",
        "item_word",
        "item_gloss",
        "list_id",
        "list_rank",
        "variability",
        "exposure",
        "cycle",
        "learning_block",
        "miniblock",
        "test_accent",
        "talker_id",
        "audio_key",
        "image_key",
        "asset_version",
      ]);
      expect(allObjectKeys(json.manifest).filter((key) => forbiddenManifestKeys.has(key))).toEqual([]);
    },
  );

  it("maps every test-mode trial to its real versioned R2 asset category", async () => {
    const learning = await bootstrap({
      participant_id: "999",
      expected_visit_type: "immediate",
      expected_segment: "learning",
    });
    const l2 = await bootstrap({
      participant_id: "999",
      expected_visit_type: "immediate",
      expected_segment: "l2_to_l1",
    });
    const pictureNaming = await bootstrap({
      participant_id: "999",
      expected_visit_type: "immediate",
      expected_segment: "picture_naming",
    });
    expect(learning.response.status).toBe(200);
    expect(l2.response.status).toBe(200);
    expect(pictureNaming.response.status).toBe(200);

    const learningKeys = learning.json.manifest.map((trial) => assetKey(trial.audio_endpoint));
    expect(learningKeys.filter((key) => key.includes("/learning-practice/"))).toHaveLength(2);
    expect(learningKeys.filter((key) => key.includes("/learning/"))).toHaveLength(144);
    expect(learningKeys.every((key) => key.startsWith("stimuli/main-assets-v2/"))).toBe(true);

    const l2Keys = l2.json.manifest.map((trial) => assetKey(trial.audio_endpoint));
    expect(l2Keys.filter((key) => key.includes("/practice/"))).toHaveLength(3);
    expect(l2Keys.filter((key) => key.includes("/test/"))).toHaveLength(24);
    expect(l2Keys.filter((key) => key.includes("/test-control/"))).toHaveLength(6);

    const imageKeys = pictureNaming.json.manifest.map((trial) => assetKey(trial.image_endpoint));
    expect(imageKeys).toHaveLength(26);
    expect(imageKeys.every((key) => /^stimuli\/main-assets-v2\/images\/[a-z]+\.webp$/u.test(key)))
      .toBe(true);
  });

  it("draws fresh per-run seed state and never accesses D1 or R2", async () => {
    const body = {
      participant_id: "999",
      expected_visit_type: "immediate",
      expected_segment: "learning",
    };
    const runtimeEnv = poisonStorageBindings();
    const first = await bootstrap(body, runtimeEnv);
    const second = await bootstrap(body, runtimeEnv);

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.json.visit.visit_id).not.toBe(second.json.visit.visit_id);
    expect(first.json.manifest.map((trial) => trial.trial_id)).not.toEqual(
      second.json.manifest.map((trial) => trial.trial_id),
    );
    expect(first.json.manifest.map((trial) => trial.audio_endpoint)).not.toEqual(
      second.json.manifest.map((trial) => trial.audio_endpoint),
    );

    const serialized = JSON.stringify([first.json, second.json]);
    expect(serialized).not.toMatch(/rootSeed|root_seed|randomizationSecret|randomization_secret/u);
  });

  it("is POST-only, validates exact trigger fields, and rejects invalid scopes", async () => {
    const valid = {
      participant_id: "999",
      expected_visit_type: "pre",
      expected_segment: "picture_naming",
    };
    const getResponse = await exports.default.fetch(request(valid, "GET"));
    expect(getResponse.status).toBe(405);

    for (const invalid of [
      { ...valid, participant_id: "test" },
      { ...valid, participant_id: "999 " },
      { ...valid, participant_id: 1 },
      { ...valid, expected_visit_type: "pre", expected_segment: "l2_to_l1" },
      { ...valid, expected_visit_type: "delayed", expected_segment: "learning" },
    ]) {
      const { response } = await bootstrap(invalid);
      expect(response.status).toBe(422);
    }

    const unexpectedField = await bootstrap({ ...valid, name: "999" });
    expect(unexpectedField.response.status).toBe(400);
    expect(unexpectedField.json.error.code).toBe("unexpected_fields");
  });

  it("requires admin authorization for bootstrap without touching storage", async () => {
    const body = {
      participant_id: "999",
      expected_visit_type: "pre",
      expected_segment: "picture_naming",
    };
    const runtimeEnv = poisonStorageBindings();
    const missing = await worker.fetch(request(body, "POST", null), runtimeEnv);
    expect(missing.status).toBe(401);
    const wrong = await worker.fetch(
      request(body, "POST", "wrong-token-that-is-long-enough"),
      runtimeEnv,
    );
    expect(wrong.status).toBe(403);
  });

  it("streams only canonical real test assets from STIMULI with admin authorization", async () => {
    const calls = [];
    const body = new Uint8Array([1, 2, 3, 4]);
    const runtimeEnv = {
      ...TEST_CONFIG,
      STIMULI: {
        async get(key) {
          calls.push(key);
          return {
            body,
            httpEtag: '"test-etag"',
            writeHttpMetadata(headers) {
              headers.set("Content-Language", "en");
            },
          };
        },
      },
    };
    const key = "stimuli/main-assets-v2/images/dog.webp";
    const response = await worker.fetch(new Request(
      `${ORIGIN}/api/test/stimuli/image?key=${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    ), runtimeEnv);

    expect(response.status).toBe(200);
    expect(calls).toEqual([key]);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("ETag")).toBe('"test-etag"');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("rejects unauthenticated, noncanonical, and missing test assets", async () => {
    let reads = 0;
    const runtimeEnv = {
      ...TEST_CONFIG,
      STIMULI: {
        async get() {
          reads += 1;
          return null;
        },
      },
    };
    const validKey = "stimuli/main-assets-v2/practice/english/tts_us_bella/book.wav";
    const validUrl = `${ORIGIN}/api/test/stimuli/audio?key=${encodeURIComponent(validKey)}`;
    const unauthenticated = await worker.fetch(new Request(validUrl), runtimeEnv);
    expect(unauthenticated.status).toBe(401);
    expect(reads).toBe(0);

    for (const key of [
      "stimuli/other-version/images/dog.webp",
      "stimuli/main-assets-v2/images/not-a-stimulus.webp",
      "recordings/private.wav",
    ]) {
      const response = await worker.fetch(new Request(
        `${ORIGIN}/api/test/stimuli/image?key=${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
      ), runtimeEnv);
      expect(response.status).toBe(404);
    }
    expect(reads).toBe(0);

    const missing = await worker.fetch(new Request(validUrl, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    }), runtimeEnv);
    expect(missing.status).toBe(503);
    expect(reads).toBe(1);
  });

  it("is unavailable in production without touching storage bindings", async () => {
    const runtimeEnv = poisonStorageBindings({
      ...TEST_CONFIG,
      ENVIRONMENT: "production",
    });
    const response = await worker.fetch(request({
      participant_id: "999",
      expected_visit_type: "pre",
      expected_segment: "picture_naming",
    }, "POST", null), runtimeEnv);
    const json = await response.json();
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("api_route_not_found");
  });
});
