import {
  ACCENTS,
  LEARNING_PRACTICE_STIMULI,
  LEARNING_PRACTICE_TALKERS,
  L2_TO_L1_PRACTICE_STIMULI,
  MAIN_STIMULI,
  PICTURE_NAMING_PRACTICE_STIMULI,
  PRACTICE_TEST_TALKERS,
  TEST_TALKERS,
  TRAINING_TALKERS,
} from "./stimuli.js";
import { deterministicUuid, hmacSha256, bytesToHex, sha256Hex, stableJson } from "./crypto.js";
import { constrainedShuffle, maxRun, permutations, scopedShuffle } from "./randomization.js";

export const CELL_PERMUTATION = Object.freeze([
  1, 8, 15, 22, 5, 12, 13, 20, 3, 10, 17, 24,
  2, 7, 16, 21, 6, 11, 14, 19, 4, 9, 18, 23,
]);

const LEARNING_CYCLES = 6;
const TEST_RESPONSE_WINDOW_MS = 10_000;
const LEARNING_VISUAL_MS = 5_000;
const VISUAL_TO_AUDIO_MS = 750;
const INTER_TRIAL_MS = 650;
const TEST_ACCENT_BASE = Object.freeze([0, 1, 2, 0, 1, 2, 1, 2, 0, 1, 2, 0]);
const SECOND_HIGH_ITEM_CYCLE = Object.freeze([0, 2, 4, 1, 3, 5]);

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
      throw new Error(`Exactly one fixed female test talker is required for ${item.testAccent}`);
    }
    return {
      ...item,
      testTalkerId,
    };
  });
}

async function orderLearningBlock(
  items,
  rootSeedHex,
  domain,
  priorItemId,
  priorHighTalkerId,
  talkerForItem,
  highVariability,
) {
  return constrainedShuffle(
    items,
    rootSeedHex,
    domain,
    (candidate) => {
      if (candidate[0]?.id === priorItemId) return false;
      if (!highVariability) return true;
      const talkers = candidate.map(talkerForItem);
      return maxRun(talkers) <= 1 && (!priorHighTalkerId || talkers[0] !== priorHighTalkerId);
    },
  );
}

async function buildLearningTrials(itemAssignments, counterbalance, rootSeedHex, assetVersion) {
  const noItems = itemAssignments.filter((item) => item.variability === "no");
  const highItems = itemAssignments.filter((item) => item.variability === "high");
  const trials = [];
  let priorItemId = null;
  let priorHighTalkerId = null;
  let priorVariability = null;
  let globalBlock = 0;

  for (let cycleIndex = 0; cycleIndex < LEARNING_CYCLES; cycleIndex += 1) {
    const startsNo = (counterbalance.orderCell + cycleIndex) % 2 === 0;
    const blockOrder = startsNo ? ["no", "high"] : ["high", "no"];
    for (const variability of blockOrder) {
      globalBlock += 1;
      const items = variability === "no" ? noItems : highItems;
      const talkerForItem = (item) => {
        if (variability === "no") return item.noTalkerId;
        const withinHalfRank = item.listRank % 6;
        const cycleOffset = item.listRank < 6 ? cycleIndex : SECOND_HIGH_ITEM_CYCLE[cycleIndex];
        const talkerIndex = (withinHalfRank + cycleOffset + counterbalance.talkerCell) % 6;
        return TRAINING_TALKERS[counterbalance.trainingAccent][talkerIndex];
      };
      const ordered = await orderLearningBlock(
        items,
        rootSeedHex,
        `learning/cycle/${cycleIndex}/condition/${variability}/order`,
        priorItemId,
        variability === "high" && priorVariability === "high" ? priorHighTalkerId : null,
        talkerForItem,
        variability === "high",
      );
      ordered.forEach((item, blockIndex) => {
        const talkerId = talkerForItem(item);
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
          exposure: cycleIndex + 1,
          cycle: cycleIndex + 1,
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
      priorItemId = ordered.at(-1).id;
      priorHighTalkerId = variability === "high" ? talkerForItem(ordered.at(-1)) : null;
      priorVariability = variability;
    }
  }
  return trials;
}

function buildLearningPracticeTrials(assetVersion, trainingAccent) {
  const talkerId = LEARNING_PRACTICE_TALKERS[trainingAccent];
  if (!talkerId) throw new Error(`Unsupported learning practice accent: ${trainingAccent}`);
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
    testAccent: null,
    talkerId,
    audioKey: audioKey(
      assetVersion,
      "learning-practice",
      trainingAccent,
      talkerId,
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

async function practiceTrials(segment, timepoint, assetVersion, rootSeedHex, firstMainTestAccent = null) {
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
      expectsRecording: true,
      timing: { responseWindowMs: TEST_RESPONSE_WINDOW_MS, interTrialMs: INTER_TRIAL_MS },
      timepoint,
    }));
  }
  const practiceAccents = await constrainedShuffle(
    ACCENTS,
    rootSeedHex,
    `l2_to_l1/${timepoint}/practice/accent_order`,
    (candidate) => !firstMainTestAccent || candidate.at(-1) !== firstMainTestAccent,
  );
  return L2_TO_L1_PRACTICE_STIMULI.map((item, index) => {
    const accent = practiceAccents[index];
    const talkerId = PRACTICE_TEST_TALKERS[accent];
    return {
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
      testAccent: accent,
      talkerId,
      audioKey: audioKey(assetVersion, "practice", accent, talkerId, item.word),
      imageKey: null,
      expectsRecording: true,
      timing: {
        preAudioRecordingMs: 150,
        responseWindowAfterAudioMs: TEST_RESPONSE_WINDOW_MS,
        interTrialMs: INTER_TRIAL_MS,
      },
      timepoint,
    };
  });
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
  const learningPractice = buildLearningPracticeTrials(assetVersion, counterbalance.trainingAccent);
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

  const l2Immediate = await buildL2Order(itemAssignments, rootSeedHex, "immediate");
  let l2Delayed = await buildL2Order(itemAssignments, rootSeedHex, "delayed");
  if (itemSequence(l2Immediate) === itemSequence(l2Delayed)) {
    l2Delayed = await buildL2Order(itemAssignments, rootSeedHex, "delayed", 1);
  }
  ensureDifferentOrder(l2Immediate, l2Delayed, "L2-to-L1");

  const [pictureNamingPracticePre, pictureNamingPracticeImmediate, l2PracticeImmediate, pictureNamingPracticeDelayed, l2PracticeDelayed] = await Promise.all([
    practiceTrials("picture_naming", "pre", assetVersion, rootSeedHex),
    practiceTrials("picture_naming", "immediate", assetVersion, rootSeedHex),
    practiceTrials("l2_to_l1", "immediate", assetVersion, rootSeedHex, l2Immediate[0].testAccent),
    practiceTrials("picture_naming", "delayed", assetVersion, rootSeedHex),
    practiceTrials("l2_to_l1", "delayed", assetVersion, rootSeedHex, l2Delayed[0].testAccent),
  ]);
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
