import {
  bytesToHex,
} from "./crypto.js";
import { buildParticipantDesign } from "./manifest.js";

const TEST_DESIGN_CELL_COUNT = 72;
const UINT32_RANGE = 0x1_0000_0000;
const TEST_DESIGN_CELL_LIMIT = Math.floor(UINT32_RANGE / TEST_DESIGN_CELL_COUNT)
  * TEST_DESIGN_CELL_COUNT;
const TEST_ASSIGNMENT_SUFFIX = "test-mode-v2";
const TEST_ASSET_VERSION = "test-static-placeholder-v1";
const GENERIC_AUDIO_URL = "/placeholder-audio/book.wav";

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

function staticAudioUrl(trial) {
  if (!trial.audioKey) return null;
  const fileName = String(trial.audioKey).split("/").at(-1);
  return /^[a-z]+\.wav$/u.test(fileName)
    ? `/placeholder-audio/${fileName}`
    : GENERIC_AUDIO_URL;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function staticImageUrl(trial) {
  if (!trial.imageKey) return null;
  const escapedGloss = escapeXml(trial.itemGloss);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800"><rect width="1200" height="800" rx="28" fill="#f7faf8"/><rect x="24" y="24" width="1152" height="752" rx="22" fill="none" stroke="#8fa39a" stroke-width="6" stroke-dasharray="18 14"/><text x="600" y="300" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="700" fill="#596963">画像プレースホルダー</text><text x="600" y="475" text-anchor="middle" font-family="sans-serif" font-size="96" font-weight="800" fill="#17211e">${escapedGloss}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function clientSafeTrial(trial, current) {
  return {
    trial_id: trial.trialUuid,
    ordinal: trial.ordinal,
    segment: trial.segment,
    segment_ordinal: trial.segmentOrdinal,
    practice: trial.practice,
    exclude_from_analysis: trial.excludeFromAnalysis,
    placeholder_asset: true,
    expects_recording: trial.expectsRecording,
    has_audio: Boolean(trial.audioKey),
    has_image: Boolean(trial.imageKey),
    audio_endpoint: staticAudioUrl(trial),
    image_endpoint: staticImageUrl(trial),
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

export async function buildTestModeBootstrap({
  visitType,
  segment,
  assignmentVersion,
  seedAlgorithmVersion,
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
    assetVersion: TEST_ASSET_VERSION,
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
    participant: { id: "test" },
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
