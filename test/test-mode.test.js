import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  L2_TO_L1_PRACTICE_STIMULI,
  LEARNING_PRACTICE_STIMULI,
  MAIN_STIMULI,
  PICTURE_NAMING_PRACTICE_STIMULI,
} from "../src/lib/stimuli.js";

const ORIGIN = "https://experiment.test";
const TEST_CONFIG = Object.freeze({
  ENVIRONMENT: "development",
  ASSIGNMENT_VERSION: "test-assignment-v1",
  SEED_ALGORITHM_VERSION: "hmac-sha256+xoshiro128ss-v1",
});
const VALID_SCOPES = Object.freeze([
  ["pre", "picture_naming", 26],
  ["immediate", "learning", 146],
  ["immediate", "picture_naming", 26],
  ["immediate", "l2_to_l1", 27],
  ["delayed", "picture_naming", 26],
  ["delayed", "l2_to_l1", 27],
]);

function request(body, method = "POST") {
  return new Request(`${ORIGIN}/api/test/bootstrap`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : null,
  });
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
        participant_id: "test",
        expected_visit_type: visitType,
        expected_segment: segment,
      });

      expect(response.status).toBe(200);
      expect(json.test_mode).toBe(true);
      expect(json.participant).toEqual({ id: "test" });
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
      expect(json.manifest.every((trial) => trial.placeholder_asset)).toBe(true);

      const serialized = JSON.stringify(json.manifest);
      expect(serialized).not.toContain("/api/stimuli/");
      for (const trial of json.manifest) {
        if (trial.has_audio) {
          expect(trial.audio_endpoint).toMatch(/^\/placeholder-audio\/[a-z]+\.wav$/u);
        } else {
          expect(trial.audio_endpoint).toBeNull();
        }
        if (trial.has_image) {
          expect(trial.image_endpoint).toMatch(/^data:image\/svg\+xml/u);
        } else {
          expect(trial.image_endpoint).toBeNull();
        }
      }

      const forbiddenManifestKeys = new Set([
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

  it("maps every learning and L2 audio to its matching static placeholder file", async () => {
    const learning = await bootstrap({
      participant_id: "test",
      expected_visit_type: "immediate",
      expected_segment: "learning",
    });
    const l2 = await bootstrap({
      participant_id: "test",
      expected_visit_type: "immediate",
      expected_segment: "l2_to_l1",
    });
    const pictureNaming = await bootstrap({
      participant_id: "test",
      expected_visit_type: "immediate",
      expected_segment: "picture_naming",
    });
    expect(learning.response.status).toBe(200);
    expect(l2.response.status).toBe(200);
    expect(pictureNaming.response.status).toBe(200);

    const expectedLearningUrls = new Set(
      [...LEARNING_PRACTICE_STIMULI, ...MAIN_STIMULI]
        .map((item) => `/placeholder-audio/${item.word}.wav`),
    );
    const expectedL2Urls = new Set(
      [...L2_TO_L1_PRACTICE_STIMULI, ...MAIN_STIMULI]
        .map((item) => `/placeholder-audio/${item.word}.wav`),
    );
    expect(new Set(learning.json.manifest.map((trial) => trial.audio_endpoint)))
      .toEqual(expectedLearningUrls);
    expect(new Set(l2.json.manifest.map((trial) => trial.audio_endpoint)))
      .toEqual(expectedL2Urls);

    for (const url of new Set([...expectedLearningUrls, ...expectedL2Urls])) {
      const response = await exports.default.fetch(new Request(`${ORIGIN}${url}`));
      expect(response.status, url).toBe(200);
      expect(response.headers.get("Content-Type"), url).toContain("audio/wav");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 4)), url).toBe("RIFF");
      expect(new TextDecoder().decode(bytes.slice(8, 12)), url).toBe("WAVE");
    }

    const decodedLearningImages = learning.json.manifest
      .filter((trial) => trial.image_endpoint)
      .map((trial) => decodeURIComponent(trial.image_endpoint));
    for (const item of MAIN_STIMULI) {
      expect(decodedLearningImages.some((svg) => svg.includes(item.gloss))).toBe(true);
    }
    const decodedPictureImages = pictureNaming.json.manifest
      .map((trial) => decodeURIComponent(trial.image_endpoint));
    for (const item of [...PICTURE_NAMING_PRACTICE_STIMULI, ...MAIN_STIMULI]) {
      expect(decodedPictureImages.some((svg) => svg.includes(item.gloss))).toBe(true);
    }
  });

  it("draws fresh per-run seed state and never accesses D1 or R2", async () => {
    const body = {
      participant_id: "test",
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
      participant_id: "test",
      expected_visit_type: "pre",
      expected_segment: "picture_naming",
    };
    const getResponse = await exports.default.fetch(request(valid, "GET"));
    expect(getResponse.status).toBe(405);

    for (const invalid of [
      { ...valid, participant_id: "Test" },
      { ...valid, participant_id: " test" },
      { ...valid, participant_id: 1 },
      { ...valid, expected_visit_type: "pre", expected_segment: "l2_to_l1" },
      { ...valid, expected_visit_type: "delayed", expected_segment: "learning" },
    ]) {
      const { response } = await bootstrap(invalid);
      expect(response.status).toBe(422);
    }

    const unexpectedField = await bootstrap({ ...valid, name: "test" });
    expect(unexpectedField.response.status).toBe(400);
    expect(unexpectedField.json.error.code).toBe("unexpected_fields");
  });

  it("is unavailable in production without touching storage bindings", async () => {
    const runtimeEnv = poisonStorageBindings({
      ...TEST_CONFIG,
      ENVIRONMENT: "production",
    });
    const { response, json } = await bootstrap({
      participant_id: "test",
      expected_visit_type: "pre",
      expected_segment: "picture_naming",
    }, runtimeEnv);
    expect(response.status).toBe(404);
    expect(json.error.code).toBe("api_route_not_found");
  });
});
