import {
  bytesToHex,
} from "./crypto.js";
import { buildParticipantDesign } from "./manifest.js";
import {
  ACCENTS,
  LEARNING_PRACTICE_STIMULI,
  L2_TO_L1_CONTROL_STIMULI,
  L2_TO_L1_CONTROL_TALKER,
  L2_TO_L1_PRACTICE_STIMULI,
  MAIN_STIMULI,
  PICTURE_NAMING_PRACTICE_STIMULI,
  PRACTICE_TALKER,
  TEST_TALKERS,
  TRAINING_TALKERS,
} from "./stimuli.js";

const TEST_DESIGN_CELL_COUNT = 72;
const UINT32_RANGE = 0x1_0000_0000;
const TEST_DESIGN_CELL_LIMIT = Math.floor(UINT32_RANGE / TEST_DESIGN_CELL_COUNT)
  * TEST_DESIGN_CELL_COUNT;
const TEST_ASSIGNMENT_SUFFIX = "test-mode-v2";

const MAIN_WORDS = new Set(MAIN_STIMULI.map((item) => item.word));
const IMAGE_WORDS = new Set([
  ...MAIN_STIMULI,
  ...PICTURE_NAMING_PRACTICE_STIMULI,
].map((item) => item.word));
const LEARNING_PRACTICE_WORDS = new Set(LEARNING_PRACTICE_STIMULI.map((item) => item.word));
const L2_PRACTICE_WORDS = new Set(L2_TO_L1_PRACTICE_STIMULI.map((item) => item.word));
const L2_CONTROL_WORDS = new Set(L2_TO_L1_CONTROL_STIMULI.map((item) => item.word));

export const TEST_MODE_SCOPES = Object.freeze({
  pre: Object.freeze(["picture_naming"]),
  immediate: Object.freeze(["learning", "picture_naming", "l2_to_l1"]),
  delayed: Object.freeze(["picture_naming", "l2_to_l1"]),
});

function createTestRunEntropy() {
  const cellWord = new Uint32Array(1);
  do {
    crypto.getRandomValues(cellWord);
  } while (cellWord[0] >= TEST_DESIGN_CELL_LIMIT);

  const designSecretBytes = new Uint8Array(32);
  crypto.getRandomValues(designSecretBytes);
  return {
    cellId: (cellWord[0] % TEST_DESIGN_CELL_COUNT) + 1,
    designSecret: bytesToHex(designSecretBytes),
    runId: crypto.randomUUID(),
  };
}

export function isAllowedTestModeScope(visitType, segment) {
  return TEST_MODE_SCOPES[visitType]?.includes(segment) === true;
}

function testStimulusUrl(key, kind) {
  return key
    ? `/api/test/stimuli/${kind}?key=${encodeURIComponent(key)}`
    : null;
}

function clientSafeTrial(trial, current) {
  return {
    trial_id: trial.trialUuid,
    ordinal: trial.ordinal,
    segment: trial.segment,
    segment_ordinal: trial.segmentOrdinal,
    practice: trial.practice,
    placeholder_asset: false,
    expects_recording: trial.expectsRecording,
    has_audio: Boolean(trial.audioKey),
    has_image: Boolean(trial.imageKey),
    audio_endpoint: testStimulusUrl(trial.audioKey, "audio"),
    image_endpoint: testStimulusUrl(trial.imageKey, "image"),
    protocol: {
      timing: trial.protocol?.timing ?? {},
      ...(trial.protocol?.visualEmoji
        ? {
            visualEmoji: trial.protocol.visualEmoji,
            visualLabel: trial.protocol?.visualLabel ?? "",
          }
        : {}),
    },
    current,
  };
}

export function isCanonicalTestModeAssetKey(keyInput, kind, assetVersion) {
  const key = String(keyInput ?? "");
  const version = String(assetVersion ?? "");
  const parts = key.split("/");
  if (!version || parts[0] !== "stimuli" || parts[1] !== version) return false;

  if (kind === "image") {
    return parts.length === 4
      && parts[2] === "images"
      && /^[a-z]+\.webp$/u.test(parts[3])
      && IMAGE_WORDS.has(parts[3].slice(0, -5));
  }
  if (kind !== "audio" || parts.length !== 6 || !/^[a-z]+\.wav$/u.test(parts[5])) {
    return false;
  }

  const [, , category, accent, talker, fileName] = parts;
  const word = fileName.slice(0, -4);
  if (!ACCENTS.includes(accent)) return false;
  if (category === "learning") {
    return MAIN_WORDS.has(word) && TRAINING_TALKERS[accent]?.includes(talker) === true;
  }
  if (category === "learning-practice") {
    return accent === "english" && talker === PRACTICE_TALKER
      && LEARNING_PRACTICE_WORDS.has(word);
  }
  if (category === "test") {
    return MAIN_WORDS.has(word) && TEST_TALKERS[accent] === talker;
  }
  if (category === "test-control") {
    return accent === "english" && talker === L2_TO_L1_CONTROL_TALKER
      && L2_CONTROL_WORDS.has(word);
  }
  return category === "practice"
    && accent === "english"
    && talker === PRACTICE_TALKER
    && L2_PRACTICE_WORDS.has(word);
}

export async function buildTestModeBootstrap({
  visitType,
  segment,
  assignmentVersion,
  seedAlgorithmVersion,
  assetVersion,
}) {
  if (!isAllowedTestModeScope(visitType, segment)) {
    throw new TypeError("Unsupported test-mode visit and segment scope");
  }

  const entropy = createTestRunEntropy();
  const testAssignmentVersion = `${assignmentVersion}:${TEST_ASSIGNMENT_SUFFIX}`;
  const design = await buildParticipantDesign({
    participantId: entropy.cellId,
    participantUuid: entropy.runId,
    assignmentVersion: testAssignmentVersion,
    seedAlgorithmVersion,
    assetVersion,
    randomizationSecret: entropy.designSecret,
  });
  const scopedTrials = design[visitType].trials.filter((trial) => trial.segment === segment);
  if (scopedTrials.length === 0) throw new Error("Test-mode scope produced no trials");

  const manifest = scopedTrials.map((trial, index) => clientSafeTrial(trial, index === 0));

  return {
    test_mode: true,
    test_run: {
      training_accent: design.assignment.trainingAccent,
      visit_type: visitType,
      segment,
      persistence: "none",
    },
    visit: {
      visit_id: entropy.runId,
      visit_type: visitType,
      status: "active",
    },
    participant: { id: "999" },
    manifest,
    accepted: [],
    participation_control: {
      trial_start_allowed: true,
      interruption: null,
    },
    next_trial_id: manifest[0].trial_id,
    next_route: null,
  };
}
