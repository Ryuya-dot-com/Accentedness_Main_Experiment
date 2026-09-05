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
import { maxRun } from "./randomization.js";

const VISIT_EXPECTATIONS = Object.freeze({
  pre: Object.freeze({ trials: 26, recordings: 24 }),
  immediate: Object.freeze({ trials: 205, recordings: 54 }),
  delayed: Object.freeze({ trials: 59, recordings: 54 }),
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
  invariant(Boolean(PRACTICE_TALKER), "practice talker presence");
  for (const accent of ACCENTS) {
    invariant(
      !TRAINING_TALKERS[accent].includes(PRACTICE_TALKER),
      `${accent} practice/main talker disjointness`,
    );
    invariant(
      TEST_TALKERS[accent] !== PRACTICE_TALKER,
      `${accent} practice/main-test talker disjointness`,
    );
  }
  const sourcePools = [
    ["main", MAIN_STIMULI],
    ["Learning practice", LEARNING_PRACTICE_STIMULI],
    ["Picture Naming practice", PICTURE_NAMING_PRACTICE_STIMULI],
    ["L2-to-L1 practice", L2_TO_L1_PRACTICE_STIMULI],
    ["L2-to-L1 control", L2_TO_L1_CONTROL_STIMULI],
  ];
  for (const [label, items] of sourcePools) {
    invariant(new Set(items.map((item) => item.id)).size === items.length, `${label} source item ID uniqueness`);
    invariant(new Set(items.map((item) => item.word)).size === items.length, `${label} source word uniqueness`);
  }
  const sourceItems = sourcePools.flatMap(([, items]) => items);
  invariant(new Set(sourceItems.map((item) => item.id)).size === sourceItems.length, "source pool item ID disjointness");
  invariant(new Set(sourceItems.map((item) => item.word)).size === sourceItems.length, "source pool word disjointness");

  const visitTypes = Object.keys(VISIT_EXPECTATIONS);
  const allTrials = visitTypes.flatMap((visitType) => design[visitType].trials);
  const main = allTrials.filter((trial) => !trial.practice);
  const practice = allTrials.filter((trial) => trial.practice);
  const spokenSegments = new Set(["picture_naming", "l2_to_l1"]);
  const spokenPractice = practice.filter((trial) => spokenSegments.has(trial.segment));
  const spokenMain = main.filter((trial) => spokenSegments.has(trial.segment));
  invariant(
    spokenPractice.every((trial) => trial.expectsRecording === false),
    "spoken practice recording exclusion",
  );
  invariant(
    spokenMain.every((trial) => trial.expectsRecording === true),
    "spoken main recording requirement",
  );
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
      invariant(trial.testAccent === "english", `${visitType} Learning practice test-accent metadata`);
      invariant(trial.talkerId === PRACTICE_TALKER, `${visitType} Learning practice talker`);
      invariant(trial.imageKey === null, `${visitType} Learning practice image absence`);
      invariant(trial.protocol?.visualEmoji === item?.emoji, `${visitType} Learning practice emoji`);
      invariant(trial.protocol?.visualLabel === item?.gloss, `${visitType} Learning practice visual label`);
      invariant(
        trial.audioKey === `stimuli/${trial.assetVersion}/learning-practice/english/${PRACTICE_TALKER}/${trial.itemWord}.wav`,
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
      invariant(trial.expectsRecording === false, `${visitType} Picture Naming practice recording exclusion`);
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
    invariant(
      l2.every((trial) => trial.testAccent === "english"),
      `${visitType} L2-to-L1 practice English accent`,
    );
    for (const trial of l2) {
      const item = l2ItemsById.get(trial.itemId);
      invariant(trial.excludeFromAnalysis === true, `${visitType} L2-to-L1 practice analysis exclusion`);
      invariant(trial.expectsRecording === false, `${visitType} L2-to-L1 practice recording exclusion`);
      invariant(item?.word === trial.itemWord && item?.gloss === trial.itemGloss, `${visitType} L2-to-L1 practice item identity`);
      invariant(
        trial.listId === null && trial.listRank === null && trial.variability === null,
        `${visitType} L2-to-L1 practice condition metadata`,
      );
      invariant(trial.imageKey === null, `${visitType} L2-to-L1 practice image absence`);
      invariant(
        trial.talkerId === PRACTICE_TALKER,
        `${visitType} L2-to-L1 practice fixed talker`,
      );
      invariant(
        trial.audioKey === `stimuli/${trial.assetVersion}/practice/english/${PRACTICE_TALKER}/${trial.itemWord}.wav`,
        `${visitType} L2-to-L1 practice audio key category`,
      );
    }
  }
}

function mainTrials(design, visitType, segment) {
  const trials = design?.[visitType]?.trials;
  invariant(Array.isArray(trials), `${visitType} trials are missing`);
  return trials.filter(
    (trial) => trial.segment === segment && !trial.practice && !trial.excludeFromAnalysis,
  );
}

function controlTrials(design, visitType) {
  return design[visitType].trials.filter(
    (trial) => trial.segment === "l2_to_l1" && !trial.practice && trial.excludeFromAnalysis,
  );
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

function checkLearningSequence(design) {
  const learning = mainTrials(design, "immediate", "learning");
  invariant(learning.length === 144, "learning main trial count");
  const conditionOrder = design.assignment.orderCell === 0 ? ["no", "high"] : ["high", "no"];
  for (let cycle = 1; cycle <= 6; cycle += 1) {
    const cycleTrials = learning.slice((cycle - 1) * 24, cycle * 24);
    invariant(
      cycleTrials.length === 24 && cycleTrials.every((trial) => trial.cycle === cycle),
      `learning cycle ${cycle} trial count and contiguity`,
    );
    invariant(new Set(cycleTrials.map((trial) => trial.itemId)).size === 24, `learning cycle ${cycle} item uniqueness`);
    invariant(
      cycleTrials.slice(0, 12).every((trial) => trial.variability === conditionOrder[0])
        && cycleTrials.slice(12).every((trial) => trial.variability === conditionOrder[1]),
      `learning cycle ${cycle} counterbalanced condition order`,
    );
  }

  const assignmentsByItem = new Map(design.itemAssignments.map((item) => [item.id, item]));
  const expectedHighTalkers = TRAINING_TALKERS[design.assignment.trainingAccent];
  for (const variability of ["no", "high"]) {
    const conditionTrials = learning.filter((trial) => trial.variability === variability);
    invariant(conditionTrials.length === 72, `learning ${variability} trial count`);
    let referenceItemOrder = null;
    for (let exposure = 1; exposure <= 6; exposure += 1) {
      const block = conditionTrials.filter((trial) => trial.exposure === exposure);
      const itemOrder = block.map((trial) => trial.itemId);
      invariant(block.length === 12, `learning ${variability} exposure ${exposure} trial count`);
      invariant(new Set(itemOrder).size === 12, `learning ${variability} exposure ${exposure} item uniqueness`);
      invariant(
        block.every((trial, index) => trial.cycle === exposure && trial.protocol?.blockIndex === index + 1),
        `learning ${variability} exposure ${exposure} block metadata`,
      );
      if (referenceItemOrder === null) referenceItemOrder = itemOrder;
      else {
        invariant(
          itemOrder.join("\u001f") === referenceItemOrder.join("\u001f"),
          `learning ${variability} exposure ${exposure} fixed item order`,
        );
      }
    }

    for (const itemId of referenceItemOrder) {
      const itemTrials = conditionTrials.filter((trial) => trial.itemId === itemId);
      const assignment = assignmentsByItem.get(itemId);
      invariant(itemTrials.length === 6, `learning ${variability} item ${itemId} exposure count`);
      invariant(assignment?.variability === variability, `learning ${variability} item ${itemId} assignment`);
      if (variability === "no") {
        invariant(
          itemTrials.every((trial) => trial.talkerId === design.assignment.noTalkerId),
          `learning No fixed talker for item ${itemId}`,
        );
      } else {
        invariant(
          sameUniqueMembers(itemTrials.map((trial) => trial.talkerId), expectedHighTalkers),
          `learning High talker permutation for item ${itemId}`,
        );
      }
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

function checkL2Controls(design) {
  const itemsById = new Map(L2_TO_L1_CONTROL_STIMULI.map((item) => [item.id, item]));
  invariant(controlTrials(design, "pre").length === 0, "pre L2-to-L1 control absence");
  for (const visitType of ["immediate", "delayed"]) {
    const controls = controlTrials(design, visitType);
    invariant(
      sameUniqueMembers(controls.map((trial) => trial.itemId), [...itemsById.keys()]),
      `${visitType} L2-to-L1 control item set`,
    );
    for (const trial of controls) {
      const item = itemsById.get(trial.itemId);
      invariant(item?.word === trial.itemWord && item?.gloss === trial.itemGloss, `${visitType} L2-to-L1 control identity`);
      invariant(trial.practice === false && trial.excludeFromAnalysis === true, `${visitType} L2-to-L1 control analysis exclusion`);
      invariant(trial.expectsRecording === true, `${visitType} L2-to-L1 control recording requirement`);
      invariant(
        trial.listId === null && trial.listRank === null && trial.variability === null,
        `${visitType} L2-to-L1 control condition metadata`,
      );
      invariant(
        trial.testAccent === "english" && trial.talkerId === L2_TO_L1_CONTROL_TALKER,
        `${visitType} L2-to-L1 control talker`,
      );
      invariant(trial.protocol?.controlType === "untrained_easy", `${visitType} L2-to-L1 control type`);
      invariant(
        trial.audioKey === `stimuli/${trial.assetVersion}/test-control/english/${L2_TO_L1_CONTROL_TALKER}/${trial.itemWord}.wav`,
        `${visitType} L2-to-L1 control audio key`,
      );
    }
    const l2Sequence = design[visitType].trials.filter(
      (trial) => trial.segment === "l2_to_l1" && !trial.practice,
    );
    invariant(
      maxRun(l2Sequence.map((trial) => trial.testAccent)) <= 2,
      `${visitType} main/control L2-to-L1 accent run`,
    );
  }
  const delayedByItem = new Map(controlTrials(design, "delayed").map((trial) => [trial.itemId, trial]));
  for (const immediate of controlTrials(design, "immediate")) {
    const delayed = delayedByItem.get(immediate.itemId);
    invariant(delayed?.audioKey === immediate.audioKey, `L2-to-L1 control audio mapping for item ${immediate.itemId}`);
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
  checkLearningSequence(design);
  for (const visitType of ["pre", "immediate", "delayed"]) checkPictureNamingPairs(design, visitType);
  for (const visitType of ["immediate", "delayed"]) checkL2Miniblocks(design, visitType);
  checkL2TimepointMapping(design);
  checkL2Controls(design);

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
