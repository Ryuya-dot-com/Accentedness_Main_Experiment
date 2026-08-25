import { ACCENTS } from "./stimuli.js";

const VISIT_EXPECTATIONS = Object.freeze({
  pre: Object.freeze({ trials: 26, recordings: 26 }),
  immediate: Object.freeze({ trials: 197, recordings: 53 }),
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
