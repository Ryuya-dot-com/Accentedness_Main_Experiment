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
import { deterministicUuid, hmacSha256, bytesToHex, sha256Hex, stableJson } from "./crypto.js";
import { maxRun, permutations, scopedShuffle } from "./randomization.js";

export const CELL_PERMUTATION = Object.freeze([
  1, 8, 15, 22, 5, 12, 13, 20, 3, 10, 17, 24,
  2, 7, 16, 21, 6, 11, 14, 19, 4, 9, 18, 23,
]);

export const RESEARCHER_TEST_PARTICIPANT_ID = 999;

const LEARNING_CYCLES = 6;
const TEST_RESPONSE_WINDOW_MS = 10_000;
const LEARNING_VISUAL_MS = 5_000;
const VISUAL_TO_AUDIO_MS = 750;
const INTER_TRIAL_MS = 650;
const TEST_ACCENT_BASE = Object.freeze([0, 1, 2, 0, 1, 2, 1, 2, 0, 1, 2, 0]);

export function canonicalParticipantId(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("participant_id must be a positive safe integer");
    return value;
  }
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new Error("participant_id must use canonical positive decimal notation");
  }
  const numericId = Number(text);
  if (!Number.isSafeInteger(numericId)) throw new Error("participant_id exceeds the JavaScript safe integer range");
  return numericId;
}

export function canonicalCollectionParticipantId(value) {
  const numericId = canonicalParticipantId(value);
  if (numericId === RESEARCHER_TEST_PARTICIPANT_ID) {
    throw new Error("participant_id 999 is reserved for non-persistent researcher testing");
  }
  return numericId;
}

export function deriveCounterbalance(numericIdInput) {
  const numericId = canonicalParticipantId(numericIdInput);
  const trainingAccent = ACCENTS[(numericId - 1) % 3];
  const q = Math.floor((numericId - 1) / 3);
  const counterbalanceCycle = Math.floor(q / 24);
  const permutationIndex = q % 24;
  const cell1 = CELL_PERMUTATION[permutationIndex];
  const cell0 = cell1 - 1;
  const listCell = Math.floor(cell0 / 6) % 2;
  const orderCell = Math.floor(cell0 / 12) % 2;
  const talkerCell = cell0 % 6;
  return {
    numericId,
    trainingAccent,
    q,
    counterbalanceCycle,
    permutationIndex,
    cell1,
    cell0,
    listCell,
    orderCell,
    talkerCell,
    noList: listCell === 0 ? 1 : 2,
    highList: listCell === 0 ? 2 : 1,
  };
}

function audioKey(assetVersion, category, accent, talker, word) {
  return `stimuli/${assetVersion}/${category}/${accent}/${talker}/${word}.wav`;
}

function imageKey(assetVersion, word) {
  return `stimuli/${assetVersion}/images/${word}.webp`;
}

function itemSequence(trials) {
  return trials.map((trial) => trial.itemId).join(",");
}

function ensureDifferentOrder(immediate, delayed, label) {
  if (itemSequence(immediate) === itemSequence(delayed)) {
    throw new Error(`${label} immediate and delayed orders unexpectedly match`);
  }
}

async function createItemAssignments(counterbalance, assetVersion) {
  const rotation = (
    counterbalance.talkerCell
    + counterbalance.orderCell
    + (counterbalance.counterbalanceCycle % 3)
  ) % 3;
  const noTalkerId = TRAINING_TALKERS[counterbalance.trainingAccent][counterbalance.talkerCell];
  const provisional = MAIN_STIMULI.map((item) => {
    const variability = item.list === counterbalance.noList ? "no" : "high";
    const testAccent = ACCENTS[(TEST_ACCENT_BASE[item.listRank] + rotation) % ACCENTS.length];
    return {
      ...item,
      variability,
      testAccent,
      noTalkerId,
      assetVersion,
    };
  });
  return provisional.map((item) => {
    const testTalkerId = TEST_TALKERS[item.testAccent];
    if (typeof testTalkerId !== "string" || testTalkerId.length === 0) {
      throw new Error(`Exactly one fixed test talker is required for ${item.testAccent}`);
    }
    return {
      ...item,
      testTalkerId,
    };
  });
}

async function buildLearningTrials(itemAssignments, counterbalance, rootSeedHex, assetVersion) {
  const itemsByVariability = new Map();
  for (const variability of ["no", "high"]) {
    itemsByVariability.set(
      variability,
      await scopedShuffle(
        itemAssignments.filter((item) => item.variability === variability),
        rootSeedHex,
        `learning/condition/${variability}/item_order`,
      ),
    );
  }
  const highTalkersByItem = new Map();
  for (const item of itemsByVariability.get("high")) {
    highTalkersByItem.set(
      item.id,
      await scopedShuffle(
        TRAINING_TALKERS[counterbalance.trainingAccent],
        rootSeedHex,
        `learning/condition/high/item/${item.id}/talker_order`,
      ),
    );
  }

  const trials = [];
  let globalBlock = 0;
  const conditionOrder = counterbalance.orderCell === 0 ? ["no", "high"] : ["high", "no"];

  for (let exposureIndex = 0; exposureIndex < LEARNING_CYCLES; exposureIndex += 1) {
    for (const variability of conditionOrder) {
      const ordered = itemsByVariability.get(variability);
      globalBlock += 1;
      ordered.forEach((item, blockIndex) => {
        const talkerId = variability === "no"
          ? item.noTalkerId
          : highTalkersByItem.get(item.id)[exposureIndex];
        trials.push({
          segment: "learning",
          practice: false,
          excludeFromAnalysis: false,
          itemId: item.id,
          itemWord: item.word,
          itemGloss: item.gloss,
          listId: item.list,
          listRank: item.listRank,
          variability,
          exposure: exposureIndex + 1,
          cycle: exposureIndex + 1,
          learningBlock: globalBlock,
          blockIndex: blockIndex + 1,
          miniblock: null,
          testAccent: null,
          talkerId,
          audioKey: audioKey(assetVersion, "learning", counterbalance.trainingAccent, talkerId, item.word),
          imageKey: imageKey(assetVersion, item.word),
          expectsRecording: false,
          timing: {
            visualDurationMs: LEARNING_VISUAL_MS,
            audioOnsetMs: VISUAL_TO_AUDIO_MS,
            interTrialMs: INTER_TRIAL_MS,
          },
        });
      });
    }
  }
  return trials;
}

function buildLearningPracticeTrials(assetVersion) {
  return LEARNING_PRACTICE_STIMULI.map((item) => ({
    segment: "learning",
    practice: true,
    excludeFromAnalysis: true,
    itemId: item.id,
    itemWord: item.word,
    itemGloss: item.gloss,
    listId: null,
    listRank: null,
    variability: null,
    exposure: null,
    cycle: null,
    learningBlock: null,
    blockIndex: null,
    miniblock: null,
    testAccent: "english",
    talkerId: PRACTICE_TALKER,
    audioKey: audioKey(
      assetVersion,
      "learning-practice",
      "english",
      PRACTICE_TALKER,
      item.word,
    ),
    imageKey: null,
    expectsRecording: false,
    visualEmoji: item.emoji,
    visualLabel: item.gloss,
    timing: {
      visualDurationMs: LEARNING_VISUAL_MS,
      audioOnsetMs: VISUAL_TO_AUDIO_MS,
      interTrialMs: INTER_TRIAL_MS,
    },
  }));
}

async function buildPictureNamingOrder(itemAssignments, rootSeedHex, timepoint, alternate = 0) {
  const suffix = alternate ? `/alternate/${alternate}` : "";
  const noItems = await scopedShuffle(
    itemAssignments.filter((item) => item.variability === "no"),
    rootSeedHex,
    `picture_naming/${timepoint}/no/order${suffix}`,
  );
  const highItems = await scopedShuffle(
    itemAssignments.filter((item) => item.variability === "high"),
    rootSeedHex,
    `picture_naming/${timepoint}/high/order${suffix}`,
  );
  const orientations = await scopedShuffle(
    [...Array(6).fill("no_first"), ...Array(6).fill("high_first")],
    rootSeedHex,
    `picture_naming/${timepoint}/pair_orientation${suffix}`,
  );
  const trials = [];
  orientations.forEach((orientation, pairIndex) => {
    const pair = orientation === "no_first"
      ? [noItems[pairIndex], highItems[pairIndex]]
      : [highItems[pairIndex], noItems[pairIndex]];
    pair.forEach((item, withinPair) => {
      trials.push({
        segment: "picture_naming",
        practice: false,
        excludeFromAnalysis: false,
        itemId: item.id,
        itemWord: item.word,
        itemGloss: item.gloss,
        listId: item.list,
        listRank: item.listRank,
        variability: item.variability,
        exposure: null,
        cycle: null,
        learningBlock: null,
        miniblock: pairIndex + 1,
        pairOrientation: orientation,
        withinPair: withinPair + 1,
        testAccent: null,
        talkerId: null,
        audioKey: null,
        imageKey: imageKey(item.assetVersion, item.word),
        expectsRecording: true,
        timing: { responseWindowMs: TEST_RESPONSE_WINDOW_MS, interTrialMs: INTER_TRIAL_MS },
      });
    });
  });
  if (maxRun(trials.map((trial) => trial.variability)) > 2) {
    throw new Error(`Picture Naming variability run constraint failed: ${timepoint}`);
  }
  return trials;
}

const STRATUM_LABELS = Object.freeze(
  ["no", "high"].flatMap((variability) => ACCENTS.map((accent) => `${variability}|${accent}`)),
);
const STRATUM_PERMUTATIONS = permutations(STRATUM_LABELS);

function l2SequenceValid(sequence) {
  return maxRun(sequence.map((label) => label.split("|")[0])) <= 2
    && maxRun(sequence.map((label) => label.split("|")[1])) <= 2;
}

async function selectL2Patterns(rootSeedHex, timepoint, alternate = 0) {
  const suffix = alternate ? `/alternate/${alternate}` : "";
  const candidateOrders = await Promise.all(
    Array.from({ length: 4 }, (_, blockIndex) => scopedShuffle(
      STRATUM_PERMUTATIONS,
      rootSeedHex,
      `l2_to_l1/${timepoint}/miniblock/${blockIndex}/pattern${suffix}`,
    )),
  );
  const selected = [];
  const search = (blockIndex, sequence) => {
    if (blockIndex === 4) return true;
    for (const candidate of candidateOrders[blockIndex]) {
      const combined = sequence.concat(candidate);
      if (!l2SequenceValid(combined)) continue;
      selected.push(candidate);
      if (search(blockIndex + 1, combined)) return true;
      selected.pop();
    }
    return false;
  };
  if (!search(0, [])) throw new Error(`No valid L2-to-L1 pattern sequence: ${timepoint}`);
  return selected;
}

async function buildL2Order(itemAssignments, rootSeedHex, timepoint, alternate = 0) {
  const suffix = alternate ? `/alternate/${alternate}` : "";
  const strata = new Map();
  for (const label of STRATUM_LABELS) {
    const [variability, accent] = label.split("|");
    const items = itemAssignments.filter(
      (item) => item.variability === variability && item.testAccent === accent,
    );
    if (items.length !== 4) throw new Error(`L2 stratum must contain four items: ${label}`);
    strata.set(label, await scopedShuffle(
      items,
      rootSeedHex,
      `l2_to_l1/${timepoint}/stratum/${label}/items${suffix}`,
    ));
  }
  const patterns = await selectL2Patterns(rootSeedHex, timepoint, alternate);
  const trials = [];
  patterns.forEach((pattern, blockIndex) => {
    pattern.forEach((label, withinBlock) => {
      const item = strata.get(label)[blockIndex];
      trials.push({
        segment: "l2_to_l1",
        practice: false,
        excludeFromAnalysis: false,
        itemId: item.id,
        itemWord: item.word,
        itemGloss: item.gloss,
        listId: item.list,
        listRank: item.listRank,
        variability: item.variability,
        exposure: null,
        cycle: null,
        learningBlock: null,
        miniblock: blockIndex + 1,
        withinMiniblock: withinBlock + 1,
        testAccent: item.testAccent,
        talkerId: item.testTalkerId,
        audioKey: audioKey(item.assetVersion, "test", item.testAccent, item.testTalkerId, item.word),
        imageKey: null,
        expectsRecording: true,
        timing: {
          preAudioRecordingMs: 150,
          responseWindowAfterAudioMs: TEST_RESPONSE_WINDOW_MS,
          interTrialMs: INTER_TRIAL_MS,
        },
      });
    });
  });
  if (!l2SequenceValid(trials.map((trial) => `${trial.variability}|${trial.testAccent}`))) {
    throw new Error(`L2-to-L1 run constraint failed: ${timepoint}`);
  }
  return trials;
}

async function addL2Controls(experimentalTrials, rootSeedHex, timepoint, assetVersion, alternate = 0) {
  const suffix = alternate ? `/alternate/${alternate}` : "";
  const controls = await scopedShuffle(
    L2_TO_L1_CONTROL_STIMULI,
    rootSeedHex,
    `l2_to_l1/${timepoint}/controls/order${suffix}`,
  );
  const controlTrials = controls.map((item) => ({
    segment: "l2_to_l1",
    practice: false,
    excludeFromAnalysis: true,
    itemId: item.id,
    itemWord: item.word,
    itemGloss: item.gloss,
    listId: null,
    listRank: null,
    variability: null,
    exposure: null,
    cycle: null,
    learningBlock: null,
    miniblock: null,
    withinMiniblock: null,
    testAccent: "english",
    talkerId: L2_TO_L1_CONTROL_TALKER,
    audioKey: audioKey(assetVersion, "test-control", "english", L2_TO_L1_CONTROL_TALKER, item.word),
    imageKey: null,
    expectsRecording: true,
    controlType: "untrained_easy",
    timing: {
      preAudioRecordingMs: 150,
      responseWindowAfterAudioMs: TEST_RESPONSE_WINDOW_MS,
      interTrialMs: INTER_TRIAL_MS,
    },
  }));

  const controlFirstPositions = new Set((await scopedShuffle(
    Array.from({ length: experimentalTrials.length + controlTrials.length }, (_, index) => index),
    rootSeedHex,
    `l2_to_l1/${timepoint}/controls/merge${suffix}`,
  )).slice(0, 15));
  const failed = new Set();
  const search = (experimentalIndex, controlIndex, previousType, previousAccent, accentRun) => {
    if (experimentalIndex === experimentalTrials.length && controlIndex === controlTrials.length) {
      return [];
    }
    const state = [experimentalIndex, controlIndex, previousType, previousAccent, accentRun].join("|");
    if (failed.has(state)) return null;
    const position = experimentalIndex + controlIndex;
    const options = controlFirstPositions.has(position)
      ? ["control", "experimental"]
      : ["experimental", "control"];
    for (const type of options) {
      if (type === "control" && (controlIndex === controlTrials.length || previousType === "control")) continue;
      if (type === "experimental" && experimentalIndex === experimentalTrials.length) continue;
      const trial = type === "control"
        ? controlTrials[controlIndex]
        : experimentalTrials[experimentalIndex];
      const nextRun = trial.testAccent === previousAccent ? accentRun + 1 : 1;
      if (nextRun > 2) continue;
      const rest = search(
        experimentalIndex + (type === "experimental" ? 1 : 0),
        controlIndex + (type === "control" ? 1 : 0),
        type,
        trial.testAccent,
        nextRun,
      );
      if (rest) return [trial, ...rest];
    }
    failed.add(state);
    return null;
  };
  const merged = search(0, 0, null, null, 0);
  if (!merged) throw new Error(`Unable to interleave L2-to-L1 controls: ${timepoint}`);
  return merged;
}

function practiceTrials(segment, timepoint, assetVersion) {
  if (segment === "picture_naming") {
    return PICTURE_NAMING_PRACTICE_STIMULI.map((item) => ({
      segment,
      practice: true,
      excludeFromAnalysis: true,
      itemId: item.id,
      itemWord: item.word,
      itemGloss: item.gloss,
      listId: null,
      listRank: null,
      variability: null,
      exposure: null,
      cycle: null,
      learningBlock: null,
      miniblock: null,
      testAccent: null,
      talkerId: null,
      audioKey: null,
      imageKey: imageKey(assetVersion, item.word),
      expectsRecording: false,
      timing: { responseWindowMs: TEST_RESPONSE_WINDOW_MS, interTrialMs: INTER_TRIAL_MS },
      timepoint,
    }));
  }
  return L2_TO_L1_PRACTICE_STIMULI.map((item) => ({
    segment,
    practice: true,
    excludeFromAnalysis: true,
    itemId: item.id,
    itemWord: item.word,
    itemGloss: item.gloss,
    listId: null,
    listRank: null,
    variability: null,
    exposure: null,
    cycle: null,
    learningBlock: null,
    miniblock: null,
    testAccent: "english",
    talkerId: PRACTICE_TALKER,
    audioKey: audioKey(assetVersion, "practice", "english", PRACTICE_TALKER, item.word),
    imageKey: null,
    expectsRecording: false,
    timing: {
      preAudioRecordingMs: 150,
      responseWindowAfterAudioMs: TEST_RESPONSE_WINDOW_MS,
      interTrialMs: INTER_TRIAL_MS,
    },
    timepoint,
  }));
}

async function finalizeVisitTrials(participantUuid, visitType, assignmentVersion, rawTrials, assetVersion) {
  const segmentCounts = new Map();
  const rows = await Promise.all(rawTrials.map(async (trial, index) => {
    const segmentOrdinal = (segmentCounts.get(trial.segment) ?? 0) + 1;
    segmentCounts.set(trial.segment, segmentOrdinal);
    const ordinal = index + 1;
    const trialUuid = await deterministicUuid(
      `${assignmentVersion}\u001f${participantUuid}\u001f${visitType}\u001f${ordinal}`,
    );
    const row = {
      trialUuid,
      visitType,
      ordinal,
      segment: trial.segment,
      segmentOrdinal,
      practice: Boolean(trial.practice),
      excludeFromAnalysis: Boolean(trial.excludeFromAnalysis),
      itemId: trial.itemId,
      itemWord: trial.itemWord,
      itemGloss: trial.itemGloss,
      listId: trial.listId,
      listRank: trial.listRank,
      variability: trial.variability,
      exposure: trial.exposure,
      cycle: trial.cycle,
      learningBlock: trial.learningBlock,
      miniblock: trial.miniblock,
      testAccent: trial.testAccent,
      talkerId: trial.talkerId,
      audioKey: trial.audioKey,
      imageKey: trial.imageKey,
      assetVersion,
      placeholderAsset: assetVersion.includes("placeholder"),
      expectsRecording: Boolean(trial.expectsRecording),
      protocol: Object.fromEntries(
        Object.entries(trial).filter(([key]) => ![
          "segment", "practice", "excludeFromAnalysis", "itemId", "itemWord", "itemGloss",
          "listId", "listRank", "variability", "exposure", "cycle", "learningBlock", "miniblock",
          "testAccent", "talkerId", "audioKey", "imageKey", "expectsRecording",
        ].includes(key)),
      ),
    };
    return row;
  }));
  const manifestHash = await sha256Hex(stableJson(rows));
  return {
    visitType,
    trials: rows,
    manifestHash,
    expectedTrialCount: rows.length,
    expectedRecordingCount: rows.filter((trial) => trial.expectsRecording).length,
  };
}

export async function buildParticipantDesign({
  participantId,
  participantUuid = crypto.randomUUID(),
  assignmentVersion,
  seedAlgorithmVersion,
  assetVersion,
  randomizationSecret,
}) {
  const counterbalance = deriveCounterbalance(participantId);
  const rootSeedBytes = await hmacSha256(
    randomizationSecret,
    `${seedAlgorithmVersion}\u001f${assignmentVersion}\u001f${counterbalance.numericId}`,
  );
  const rootSeedHex = bytesToHex(rootSeedBytes);
  const itemAssignments = await createItemAssignments(counterbalance, assetVersion);
  const learningPractice = buildLearningPracticeTrials(assetVersion);
  const learningTrials = await buildLearningTrials(itemAssignments, counterbalance, rootSeedHex, assetVersion);

  const pictureNamingPre = await buildPictureNamingOrder(itemAssignments, rootSeedHex, "pre");
  let pictureNamingImmediate = await buildPictureNamingOrder(itemAssignments, rootSeedHex, "immediate");
  let immediateAlternate = 0;
  while (itemSequence(pictureNamingPre) === itemSequence(pictureNamingImmediate)) {
    immediateAlternate += 1;
    pictureNamingImmediate = await buildPictureNamingOrder(
      itemAssignments,
      rootSeedHex,
      "immediate",
      immediateAlternate,
    );
  }
  let pictureNamingDelayed = await buildPictureNamingOrder(itemAssignments, rootSeedHex, "delayed");
  let delayedAlternate = 0;
  while ([pictureNamingPre, pictureNamingImmediate].some(
    (order) => itemSequence(order) === itemSequence(pictureNamingDelayed),
  )) {
    delayedAlternate += 1;
    pictureNamingDelayed = await buildPictureNamingOrder(
      itemAssignments,
      rootSeedHex,
      "delayed",
      delayedAlternate,
    );
  }
  ensureDifferentOrder(pictureNamingPre, pictureNamingImmediate, "Pre and immediate Picture Naming");
  ensureDifferentOrder(pictureNamingPre, pictureNamingDelayed, "Pre and delayed Picture Naming");
  ensureDifferentOrder(pictureNamingImmediate, pictureNamingDelayed, "Picture Naming");

  const l2Immediate = await addL2Controls(
    await buildL2Order(itemAssignments, rootSeedHex, "immediate"),
    rootSeedHex,
    "immediate",
    assetVersion,
  );
  let l2DelayedAlternate = 0;
  let l2Delayed = await addL2Controls(
    await buildL2Order(itemAssignments, rootSeedHex, "delayed"),
    rootSeedHex,
    "delayed",
    assetVersion,
  );
  while (itemSequence(l2Immediate) === itemSequence(l2Delayed)) {
    l2DelayedAlternate += 1;
    l2Delayed = await addL2Controls(
      await buildL2Order(itemAssignments, rootSeedHex, "delayed", l2DelayedAlternate),
      rootSeedHex,
      "delayed",
      assetVersion,
      l2DelayedAlternate,
    );
  }
  ensureDifferentOrder(l2Immediate, l2Delayed, "L2-to-L1");

  const [pictureNamingPracticePre, pictureNamingPracticeImmediate, l2PracticeImmediate, pictureNamingPracticeDelayed, l2PracticeDelayed] = [
    practiceTrials("picture_naming", "pre", assetVersion),
    practiceTrials("picture_naming", "immediate", assetVersion),
    practiceTrials("l2_to_l1", "immediate", assetVersion),
    practiceTrials("picture_naming", "delayed", assetVersion),
    practiceTrials("l2_to_l1", "delayed", assetVersion),
  ];
  const preRaw = [
    ...pictureNamingPracticePre,
    ...pictureNamingPre,
  ];
  const immediateRaw = [
    ...learningPractice,
    ...learningTrials,
    ...pictureNamingPracticeImmediate,
    ...pictureNamingImmediate,
    ...l2PracticeImmediate,
    ...l2Immediate,
  ];
  const delayedRaw = [
    ...pictureNamingPracticeDelayed,
    ...pictureNamingDelayed,
    ...l2PracticeDelayed,
    ...l2Delayed,
  ];

  const [pre, immediate, delayed] = await Promise.all([
    finalizeVisitTrials(participantUuid, "pre", assignmentVersion, preRaw, assetVersion),
    finalizeVisitTrials(participantUuid, "immediate", assignmentVersion, immediateRaw, assetVersion),
    finalizeVisitTrials(participantUuid, "delayed", assignmentVersion, delayedRaw, assetVersion),
  ]);
  const assignment = {
    participantUuid,
    numericId: counterbalance.numericId,
    trainingAccent: counterbalance.trainingAccent,
    withinAccentQ: counterbalance.q,
    counterbalanceCycle: counterbalance.counterbalanceCycle,
    counterbalanceCell: counterbalance.cell1,
    listCell: counterbalance.listCell,
    orderCell: counterbalance.orderCell,
    talkerCell: counterbalance.talkerCell,
    noList: counterbalance.noList,
    highList: counterbalance.highList,
    noTalkerId: TRAINING_TALKERS[counterbalance.trainingAccent][counterbalance.talkerCell],
    assignmentVersion,
    seedAlgorithmVersion,
    rootSeedHex,
    assetVersion,
    testAccentRotation: (
      counterbalance.talkerCell
      + counterbalance.orderCell
      + (counterbalance.counterbalanceCycle % 3)
    ) % 3,
  };
  return { assignment, itemAssignments, pre, immediate, delayed };
}

export function summarizeRuns(trials) {
  return {
    variability: maxRun(trials.map((trial) => trial.variability).filter(Boolean)),
    testAccent: maxRun(trials.map((trial) => trial.testAccent).filter(Boolean)),
  };
}
