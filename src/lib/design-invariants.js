import {
  ACCENTS,
  LEARNING_PRACTICE_STIMULI,
  LEARNING_PRACTICE_TALKERS,
  L2_TO_L1_PRACTICE_STIMULI,
  MAIN_STIMULI,
  PICTURE_NAMING_PRACTICE_STIMULI,
  PRACTICE_TEST_TALKERS,
  TRAINING_TALKERS,
} from "./stimuli.js";

const VISIT_EXPECTATIONS = Object.freeze({
  pre: Object.freeze({ trials: 26, recordings: 26 }),
  immediate: Object.freeze({ trials: 199, recordings: 53 }),
  delayed: Object.freeze({ trials: 53, recordings: 53 }),
});

const L2_STRATA = Object.freeze(
  ["no", "high"].flatMap((variability) => ACCENTS.map((accent) => `${variability}|${accent}`)),
);

function invariant(condition, message) {
  if (!condition) throw new Error(`Design invariant failed: ${message}`);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameUniqueMembers(values, expected) {
  const actualSet = new Set(values);
  const expectedSet = new Set(expected);
  return values.length === expected.length
    && actualSet.size === values.length
    && expectedSet.size === expected.length
    && [...actualSet].every((value) => expectedSet.has(value));
}

function checkPracticeStimuli(design) {
  invariant(
    new Set(Object.values(LEARNING_PRACTICE_TALKERS)).size === ACCENTS.length,
    "Learning practice talker uniqueness",
  );
  for (const accent of ACCENTS) {
    const practiceTalker = LEARNING_PRACTICE_TALKERS[accent];
    invariant(Boolean(practiceTalker), `${accent} Learning practice talker presence`);
    invariant(
      !TRAINING_TALKERS[accent].includes(practiceTalker),
      `${accent} Learning practice/main talker disjointness`,
    );
    invariant(
      PRACTICE_TEST_TALKERS[accent] !== practiceTalker,
      `${accent} Learning practice/test talker disjointness`,
    );
  }
  const sourcePools = [
    ["main", MAIN_STIMULI],
    ["Learning practice", LEARNING_PRACTICE_STIMULI],
    ["Picture Naming practice", PICTURE_NAMING_PRACTICE_STIMULI],
    ["L2-to-L1 practice", L2_TO_L1_PRACTICE_STIMULI],
  ];
  for (const [label, items] of sourcePools) {
    invariant(new Set(items.map((item) => item.id)).size === items.length, `${label} source item ID uniqueness`);
    invariant(new Set(items.map((item) => item.word)).size === items.length, `${label} source word uniqueness`);
  }
  const mainSourceIds = new Set(MAIN_STIMULI.map((item) => item.id));
  const mainSourceWords = new Set(MAIN_STIMULI.map((item) => item.word));
  const pictureSourceIds = new Set(PICTURE_NAMING_PRACTICE_STIMULI.map((item) => item.id));
  const pictureSourceWords = new Set(PICTURE_NAMING_PRACTICE_STIMULI.map((item) => item.word));
  for (const item of [
    ...LEARNING_PRACTICE_STIMULI,
    ...PICTURE_NAMING_PRACTICE_STIMULI,
    ...L2_TO_L1_PRACTICE_STIMULI,
  ]) {
    invariant(!mainSourceIds.has(item.id), "practice/main source item ID disjointness");
    invariant(!mainSourceWords.has(item.word), "practice/main source word disjointness");
  }
  const learningSourceIds = new Set(LEARNING_PRACTICE_STIMULI.map((item) => item.id));
  const learningSourceWords = new Set(LEARNING_PRACTICE_STIMULI.map((item) => item.word));
  for (const item of [...PICTURE_NAMING_PRACTICE_STIMULI, ...L2_TO_L1_PRACTICE_STIMULI]) {
    invariant(!learningSourceIds.has(item.id), "practice task source item ID disjointness");
    invariant(!learningSourceWords.has(item.word), "practice task source word disjointness");
  }
  for (const item of L2_TO_L1_PRACTICE_STIMULI) {
    invariant(!pictureSourceIds.has(item.id), "practice task source item ID disjointness");
    invariant(!pictureSourceWords.has(item.word), "practice task source word disjointness");
  }

  const visitTypes = Object.keys(VISIT_EXPECTATIONS);
  const allTrials = visitTypes.flatMap((visitType) => design[visitType].trials);
  const main = allTrials.filter((trial) => !trial.practice);
  const practice = allTrials.filter((trial) => trial.practice);
  for (const [field, label] of [
    ["itemId", "item ID"],
    ["itemWord", "word"],
    ["imageKey", "image key"],
    ["audioKey", "audio key"],
  ]) {
    const mainValues = new Set(
      main.map((trial) => trial[field]).filter((value) => value !== null && value !== undefined),
    );
    invariant(
      practice.every((trial) => {
        const value = trial[field];
        return value === null || value === undefined || !mainValues.has(value);
      }),
      `practice/main ${label} disjointness`,
    );
  }

  const pictureItemsById = new Map(
    PICTURE_NAMING_PRACTICE_STIMULI.map((item) => [item.id, item]),
  );
  const l2ItemsById = new Map(L2_TO_L1_PRACTICE_STIMULI.map((item) => [item.id, item]));
  for (const visitType of visitTypes) {
    const visitPractice = design[visitType].trials.filter((trial) => trial.practice);
    const learning = visitPractice.filter((trial) => trial.segment === "learning");
    const picture = visitPractice.filter((trial) => trial.segment === "picture_naming");
    const l2 = visitPractice.filter((trial) => trial.segment === "l2_to_l1");
    const expectedLearningItems = visitType === "immediate" ? LEARNING_PRACTICE_STIMULI : [];
    invariant(
      sameUniqueMembers(
        learning.map((trial) => trial.itemId),
        expectedLearningItems.map((item) => item.id),
      ),
      `${visitType} Learning practice item set`,
    );
    for (const trial of learning) {
      const item = LEARNING_PRACTICE_STIMULI.find((candidate) => candidate.id === trial.itemId);
      invariant(trial.excludeFromAnalysis === true, `${visitType} Learning practice analysis exclusion`);
      invariant(trial.expectsRecording === false, `${visitType} Learning practice recording exclusion`);
      invariant(item?.word === trial.itemWord && item?.gloss === trial.itemGloss, `${visitType} Learning practice item identity`);
      invariant(
        trial.listId === null && trial.listRank === null && trial.variability === null,
        `${visitType} Learning practice condition metadata`,
      );
      invariant(trial.testAccent === null, `${visitType} Learning practice test-accent metadata`);
      const practiceAccent = design.assignment.trainingAccent;
      const practiceTalker = LEARNING_PRACTICE_TALKERS[practiceAccent];
      invariant(trial.talkerId === practiceTalker, `${visitType} Learning practice accent-matched talker`);
      invariant(trial.imageKey === null, `${visitType} Learning practice image absence`);
      invariant(trial.protocol?.visualEmoji === item?.emoji, `${visitType} Learning practice emoji`);
      invariant(trial.protocol?.visualLabel === item?.gloss, `${visitType} Learning practice visual label`);
      invariant(
        trial.audioKey === `stimuli/${trial.assetVersion}/learning-practice/${practiceAccent}/${practiceTalker}/${trial.itemWord}.wav`,
        `${visitType} Learning practice audio key category`,
      );
    }
    invariant(
      sameUniqueMembers(
        picture.map((trial) => trial.itemId),
        PICTURE_NAMING_PRACTICE_STIMULI.map((item) => item.id),
      ),
      `${visitType} Picture Naming practice item set`,
    );
    for (const trial of picture) {
      const item = pictureItemsById.get(trial.itemId);
      invariant(trial.excludeFromAnalysis === true, `${visitType} Picture Naming practice analysis exclusion`);
      invariant(item?.word === trial.itemWord && item?.gloss === trial.itemGloss, `${visitType} Picture Naming practice item identity`);
      invariant(
        trial.listId === null && trial.listRank === null && trial.variability === null,
        `${visitType} Picture Naming practice condition metadata`,
      );
      invariant(trial.testAccent === null && trial.talkerId === null, `${visitType} Picture Naming practice talker metadata`);
      invariant(trial.audioKey === null, `${visitType} Picture Naming practice audio absence`);
      invariant(
        trial.imageKey === `stimuli/${trial.assetVersion}/images/${trial.itemWord}.webp`,
        `${visitType} Picture Naming practice image key`,
      );
    }

    const expectedL2Items = visitType === "pre" ? [] : L2_TO_L1_PRACTICE_STIMULI;
    invariant(
      sameUniqueMembers(
        l2.map((trial) => trial.itemId),
        expectedL2Items.map((item) => item.id),
      ),
      `${visitType} L2-to-L1 practice item set`,
    );
    const accentCounts = countBy(l2.map((trial) => trial.testAccent));
    for (const accent of ACCENTS) {
      invariant(
        accentCounts.get(accent) === (visitType === "pre" ? undefined : 1),
        `${visitType} L2-to-L1 practice ${accent} count`,
      );
    }
    for (const trial of l2) {
      const item = l2ItemsById.get(trial.itemId);
      invariant(trial.excludeFromAnalysis === true, `${visitType} L2-to-L1 practice analysis exclusion`);
      invariant(item?.word === trial.itemWord && item?.gloss === trial.itemGloss, `${visitType} L2-to-L1 practice item identity`);
      invariant(
        trial.listId === null && trial.listRank === null && trial.variability === null,
        `${visitType} L2-to-L1 practice condition metadata`,
      );
      invariant(trial.imageKey === null, `${visitType} L2-to-L1 practice image absence`);
      invariant(
        trial.talkerId === PRACTICE_TEST_TALKERS[trial.testAccent],
        `${visitType} L2-to-L1 practice fixed talker`,
      );
      invariant(
        trial.audioKey === `stimuli/${trial.assetVersion}/practice/${trial.testAccent}/${trial.talkerId}/${trial.itemWord}.wav`,
        `${visitType} L2-to-L1 practice audio key category`,
      );
    }
  }
}

function mainTrials(design, visitType, segment) {
  const trials = design?.[visitType]?.trials;
  invariant(Array.isArray(trials), `${visitType} trials are missing`);
  return trials.filter((trial) => trial.segment === segment && !trial.practice);
}

function checkVisitCounts(design) {
  for (const [visitType, expected] of Object.entries(VISIT_EXPECTATIONS)) {
    const visit = design?.[visitType];
    invariant(visit && Array.isArray(visit.trials), `${visitType} visit is missing`);
    const recordingCount = visit.trials.filter((trial) => trial.expectsRecording).length;
    invariant(visit.trials.length === expected.trials, `${visitType} actual trial count`);
    invariant(visit.expectedTrialCount === expected.trials, `${visitType} declared trial count`);
    invariant(recordingCount === expected.recordings, `${visitType} actual recording count`);
    invariant(visit.expectedRecordingCount === expected.recordings, `${visitType} declared recording count`);
  }
}

function checkHighTalkersByCycle(design) {
  const learning = mainTrials(design, "immediate", "learning");
  invariant(learning.length === 144, "learning main trial count");
  for (let cycle = 1; cycle <= 6; cycle += 1) {
    const cycleTrials = learning.filter((trial) => trial.cycle === cycle);
    const highTrials = cycleTrials.filter((trial) => trial.variability === "high");
    const talkerCounts = countBy(highTrials.map((trial) => trial.talkerId));
    invariant(cycleTrials.length === 24, `learning cycle ${cycle} trial count`);
    invariant(highTrials.length === 12, `learning cycle ${cycle} High trial count`);
    invariant(talkerCounts.size === 6, `learning cycle ${cycle} High talker count`);
    for (const [talkerId, count] of talkerCounts) {
      invariant(typeof talkerId === "string" && talkerId.length > 0, `learning cycle ${cycle} High talker ID`);
      invariant(count === 2, `learning cycle ${cycle} High frequency for ${talkerId}`);
    }
  }
}

function checkPictureNamingPairs(design, visitType) {
  const trials = mainTrials(design, visitType, "picture_naming");
  invariant(trials.length === 24, `${visitType} Picture Naming main trial count`);
  const orientations = [];
  for (let index = 0; index < trials.length; index += 2) {
    const first = trials[index];
    const second = trials[index + 1];
    const orientation = first.variability === "no" && second.variability === "high"
      ? "no_first"
      : first.variability === "high" && second.variability === "no"
        ? "high_first"
        : null;
    invariant(orientation !== null, `${visitType} Picture Naming pair ${index / 2 + 1} composition`);
    invariant(first.protocol?.pairOrientation === orientation, `${visitType} Picture Naming pair ${index / 2 + 1} first metadata`);
    invariant(second.protocol?.pairOrientation === orientation, `${visitType} Picture Naming pair ${index / 2 + 1} second metadata`);
    orientations.push(orientation);
  }
  const counts = countBy(orientations);
  invariant(counts.get("no_first") === 6, `${visitType} Picture Naming no-first pair count`);
  invariant(counts.get("high_first") === 6, `${visitType} Picture Naming high-first pair count`);
}

function checkL2Miniblocks(design, visitType) {
  const trials = mainTrials(design, visitType, "l2_to_l1");
  invariant(trials.length === 24, `${visitType} L2-to-L1 main trial count`);
  for (let miniblock = 1; miniblock <= 4; miniblock += 1) {
    const block = trials.filter((trial) => trial.miniblock === miniblock);
    invariant(block.length === 6, `${visitType} L2-to-L1 miniblock ${miniblock} trial count`);
    const strata = block.map((trial) => `${trial.variability}|${trial.testAccent}`).sort();
    invariant(
      strata.join("\u001f") === L2_STRATA.slice().sort().join("\u001f"),
      `${visitType} L2-to-L1 miniblock ${miniblock} strata`,
    );
  }
}

function checkL2TimepointMapping(design) {
  const immediate = mainTrials(design, "immediate", "l2_to_l1");
  const delayed = mainTrials(design, "delayed", "l2_to_l1");
  const delayedByItem = new Map(delayed.map((trial) => [trial.itemId, trial]));
  invariant(delayedByItem.size === delayed.length, "delayed L2-to-L1 item uniqueness");
  invariant(new Set(immediate.map((trial) => trial.itemId)).size === immediate.length, "immediate L2-to-L1 item uniqueness");
  for (const immediateTrial of immediate) {
    const delayedTrial = delayedByItem.get(immediateTrial.itemId);
    invariant(delayedTrial, `delayed L2-to-L1 mapping for item ${immediateTrial.itemId}`);
    for (const field of ["audioKey", "talkerId", "testAccent", "variability"]) {
      invariant(
        immediateTrial[field] === delayedTrial[field],
        `L2-to-L1 ${field} mapping for item ${immediateTrial.itemId}`,
      );
    }
  }
}

export function samePositionCount(first, second) {
  invariant(Array.isArray(first) && Array.isArray(second), "same-position inputs must be arrays");
  invariant(first.length === second.length, "same-position inputs must have equal length");
  return first.reduce((count, trial, index) => count + (trial.itemId === second[index].itemId ? 1 : 0), 0);
}

export function assertParticipantDesignInvariants(design) {
  checkVisitCounts(design);
  checkPracticeStimuli(design);
  checkHighTalkersByCycle(design);
  for (const visitType of ["pre", "immediate", "delayed"]) checkPictureNamingPairs(design, visitType);
  for (const visitType of ["immediate", "delayed"]) checkL2Miniblocks(design, visitType);
  checkL2TimepointMapping(design);

  const immediatePictureNaming = mainTrials(design, "immediate", "picture_naming");
  const delayedPictureNaming = mainTrials(design, "delayed", "picture_naming");
  const immediateL2 = mainTrials(design, "immediate", "l2_to_l1");
  const delayedL2 = mainTrials(design, "delayed", "l2_to_l1");
  return {
    immediateDelayedSamePosition: {
      pictureNaming: samePositionCount(immediatePictureNaming, delayedPictureNaming),
      l2ToL1: samePositionCount(immediateL2, delayedL2),
    },
  };
}
