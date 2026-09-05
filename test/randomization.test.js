import { describe, expect, it } from "vitest";
import {
  buildParticipantDesign,
  canonicalParticipantId,
  deriveCounterbalance,
  summarizeRuns,
} from "../src/lib/manifest.js";
import { maxRun } from "../src/lib/randomization.js";
import {
  L2_TO_L1_CONTROL_STIMULI,
  MAIN_STIMULI,
  PRACTICE_TALKER,
  TEST_TALKERS,
  TRAINING_TALKERS,
} from "../src/lib/stimuli.js";

const DESIGN_INPUT = Object.freeze({
  assignmentVersion: "main-v10-english-practice-placeholder",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "placeholder-v2",
  randomizationSecret: "test-randomization-secret-that-is-independent",
});

const EXPECTED_TEST_TALKERS = Object.freeze({
  english: "E6_Audio",
  chinese: "C11_Natural",
  japanese: "J5_Natural",
});

function counts(values) {
  return values.reduce((output, value) => {
    output[value] = (output[value] ?? 0) + 1;
    return output;
  }, {});
}

function mainTrials(design, visitType, segment) {
  return design[visitType].trials.filter(
    (trial) => trial.segment === segment && !trial.practice && !trial.excludeFromAnalysis,
  );
}

function uuidForId(id) {
  return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
}

async function designFor(id) {
  return buildParticipantDesign({ participantId: id, participantUuid: uuidForId(id), ...DESIGN_INPUT });
}

describe("participant ID contract", () => {
  it("rejects ambiguous and unsafe IDs", () => {
    for (const value of ["001", "0", 0, -1, "-2", "1.5", 1.5, "P01", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => canonicalParticipantId(value)).toThrow();
    }
    expect(canonicalParticipantId("1")).toBe(1);
    expect(canonicalParticipantId(216)).toBe(216);
  });

  it("uses ID mod 3 and the specified 24-cell permutation at boundaries", () => {
    expect(deriveCounterbalance(1)).toMatchObject({ trainingAccent: "english", q: 0, cell1: 1 });
    expect(deriveCounterbalance(2)).toMatchObject({ trainingAccent: "chinese", q: 0, cell1: 1 });
    expect(deriveCounterbalance(3)).toMatchObject({ trainingAccent: "japanese", q: 0, cell1: 1 });
    expect(deriveCounterbalance(4)).toMatchObject({ trainingAccent: "english", q: 1, cell1: 8 });
    expect(deriveCounterbalance(72)).toMatchObject({ trainingAccent: "japanese", q: 23, cell1: 23 });
    expect(deriveCounterbalance(73)).toMatchObject({ trainingAccent: "english", q: 24, cell1: 1, counterbalanceCycle: 1 });
    expect(deriveCounterbalance(216)).toMatchObject({ trainingAccent: "japanese", q: 71, cell1: 23, counterbalanceCycle: 2 });
    expect(deriveCounterbalance(217)).toMatchObject({ trainingAccent: "english", q: 72, cell1: 1, counterbalanceCycle: 3 });
  });
});

describe("participant-level manifest invariants", () => {
  it("uses the frozen production word lists", () => {
    expect(MAIN_STIMULI.filter((item) => item.list === 1).map((item) => item.word)).toEqual([
      "tweezers", "scapula", "cocoon", "lotus", "xylophone", "porcupine",
      "carousel", "spatula", "syringe", "catapult", "wardrobe", "abacus",
    ]);
    expect(MAIN_STIMULI.filter((item) => item.list === 2).map((item) => item.word)).toEqual([
      "razor", "podium", "protractor", "acorn", "scalpel", "casket",
      "detergent", "nostril", "binoculars", "raccoon", "parakeet", "toupee",
    ]);
    expect(TRAINING_TALKERS).toEqual({
      english: ["E1_Audio", "E4_Audio", "E7_Audio", "E12_Audio", "E13_Audio", "E14_Audio"],
      chinese: ["C2_Natural", "C5_Natural", "C7_Natural", "C15_Natural", "C16_Natural", "C18_Natural"],
      japanese: ["J6_Natural", "J8_Natural", "J4_Natural", "J12_Natural", "J10_Natural", "J15_Natural"],
    });
    expect(TEST_TALKERS).toEqual(EXPECTED_TEST_TALKERS);
    expect(L2_TO_L1_CONTROL_STIMULI.map((item) => item.word)).toEqual([
      "strawberry", "grape", "pineapple", "peach", "kiwi", "cherry",
    ]);
  });

  it("keeps every participant-facing timing contract unchanged", async () => {
    const design = await designFor(2);
    const allTrials = [
      ...design.pre.trials,
      ...design.immediate.trials,
      ...design.delayed.trials,
    ];
    for (const trial of allTrials.filter((candidate) => candidate.segment === "learning")) {
      expect(trial.protocol.timing).toEqual({
        visualDurationMs: 5_000,
        audioOnsetMs: 750,
        interTrialMs: 650,
      });
    }
    for (const trial of allTrials.filter((candidate) => candidate.segment === "picture_naming")) {
      expect(trial.protocol.timing).toEqual({
        responseWindowMs: 10_000,
        interTrialMs: 650,
      });
    }
    for (const trial of allTrials.filter((candidate) => candidate.segment === "l2_to_l1")) {
      expect(trial.protocol.timing).toEqual({
        preAudioRecordingMs: 150,
        responseWindowAfterAudioMs: 10_000,
        interTrialMs: 650,
      });
    }
  });

  it("uses task-specific practice items and assets disjoint from all 24 main items", async () => {
    const design = await designFor(2);
    const allTrials = [
      ...design.pre.trials,
      ...design.immediate.trials,
      ...design.delayed.trials,
    ];
    const practice = allTrials.filter((trial) => trial.practice);
    const main = allTrials.filter((trial) => !trial.practice);
    const mainIds = new Set(main.map((trial) => trial.itemId));
    const mainWords = new Set(main.map((trial) => trial.itemWord));
    const mainImageKeys = new Set(main.map((trial) => trial.imageKey).filter(Boolean));
    const mainAudioKeys = new Set(main.map((trial) => trial.audioKey).filter(Boolean));

    expect(new Set(practice.map((trial) => trial.itemId))).toEqual(
      new Set([901, 902, 903, 904, 905, 906, 907]),
    );
    expect(new Set(practice.map((trial) => trial.itemWord))).toEqual(
      new Set(["dog", "chair", "book", "water", "house", "apple", "orange"]),
    );
    expect(practice.every((trial) => trial.excludeFromAnalysis)).toBe(true);
    expect(practice.every((trial) => trial.expectsRecording === false)).toBe(true);
    expect(main.filter((trial) => ["picture_naming", "l2_to_l1"].includes(trial.segment))
      .every((trial) => trial.expectsRecording === true)).toBe(true);
    expect(practice.every((trial) => !mainIds.has(trial.itemId))).toBe(true);
    expect(practice.every((trial) => !mainWords.has(trial.itemWord))).toBe(true);
    expect(practice.filter((trial) => trial.imageKey)
      .every((trial) => !mainImageKeys.has(trial.imageKey))).toBe(true);
    expect(practice.filter((trial) => trial.audioKey)
      .every((trial) => !mainAudioKeys.has(trial.audioKey))).toBe(true);

    for (const visitType of ["pre", "immediate", "delayed"]) {
      const learning = design[visitType].trials.filter(
        (trial) => trial.segment === "learning" && trial.practice,
      );
      if (visitType === "immediate") {
        expect(learning.map((trial) => [
          trial.itemId,
          trial.itemWord,
          trial.protocol.visualEmoji,
        ])).toEqual([
          [906, "apple", "🍎"],
          [907, "orange", "🍊"],
        ]);
        expect(learning.every((trial) => (
          trial.imageKey === null
          && trial.expectsRecording === false
          && trial.testAccent === "english"
          && trial.talkerId === PRACTICE_TALKER
          && trial.audioKey === `stimuli/${trial.assetVersion}/learning-practice/english/${PRACTICE_TALKER}/${trial.itemWord}.wav`
        ))).toBe(true);
      } else {
        expect(learning).toHaveLength(0);
      }

      const picture = design[visitType].trials.filter(
        (trial) => trial.segment === "picture_naming" && trial.practice,
      );
      expect(picture.map((trial) => [trial.itemId, trial.itemWord])).toEqual([
        [901, "dog"],
        [902, "chair"],
      ]);
      expect(picture.every((trial) => (
        trial.audioKey === null
        && trial.expectsRecording === false
        && trial.imageKey === `stimuli/${trial.assetVersion}/images/${trial.itemWord}.webp`
      ))).toBe(true);

      const l2 = design[visitType].trials.filter(
        (trial) => trial.segment === "l2_to_l1" && trial.practice,
      );
      if (visitType === "pre") {
        expect(l2).toHaveLength(0);
        continue;
      }
      expect(l2.map((trial) => [trial.itemId, trial.itemWord])).toEqual([
        [903, "book"],
        [904, "water"],
        [905, "house"],
      ]);
      expect(l2.every((trial) => (
        trial.imageKey === null
        && trial.expectsRecording === false
          && trial.testAccent === "english"
          && trial.talkerId === PRACTICE_TALKER
          && trial.audioKey === `stimuli/${trial.assetVersion}/practice/english/${PRACTICE_TALKER}/${trial.itemWord}.wav`
      ))).toBe(true);
    }
  });

  it("satisfies learning, test, timing, and timepoint contracts", async () => {
    for (const id of [1, 2, 3, 4, 72, 73, 216, 217]) {
      const design = await designFor(id);
      const learning = mainTrials(design, "immediate", "learning");
      expect(learning).toHaveLength(144);
      expect(counts(learning.map((trial) => trial.variability))).toEqual({ no: 72, high: 72 });
      for (let itemId = 1; itemId <= 24; itemId += 1) {
        const exposures = learning.filter((trial) => trial.itemId === itemId);
        expect(exposures).toHaveLength(6);
        if (exposures[0].variability === "no") {
          expect(new Set(exposures.map((trial) => trial.talkerId)).size).toBe(1);
        } else {
          expect(new Set(exposures.map((trial) => trial.talkerId)).size).toBe(6);
        }
      }
      const conditionOrder = design.assignment.orderCell === 0 ? ["no", "high"] : ["high", "no"];
      for (let cycle = 1; cycle <= 6; cycle += 1) {
        const cycleTrials = learning.slice((cycle - 1) * 24, cycle * 24);
        expect(cycleTrials.every((trial) => trial.cycle === cycle)).toBe(true);
        expect(new Set(cycleTrials.map((trial) => trial.itemId)).size).toBe(24);
        expect(cycleTrials.slice(0, 12).every((trial) => trial.variability === conditionOrder[0])).toBe(true);
        expect(cycleTrials.slice(12).every((trial) => trial.variability === conditionOrder[1])).toBe(true);
      }
      expect(maxRun(learning.map((trial) => trial.variability))).toBe(12);
      for (const variability of ["no", "high"]) {
        const conditionTrials = learning.filter((trial) => trial.variability === variability);
        const referenceOrder = conditionTrials
          .filter((trial) => trial.exposure === 1)
          .map((trial) => trial.itemId);
        expect(referenceOrder).toHaveLength(12);
        for (let exposure = 1; exposure <= 6; exposure += 1) {
          const block = conditionTrials.filter((trial) => trial.exposure === exposure);
          expect(block.map((trial) => trial.itemId)).toEqual(referenceOrder);
          expect(block.map((trial) => trial.protocol.blockIndex)).toEqual(
            Array.from({ length: 12 }, (_, index) => index + 1),
          );
        }
      }

      const prePn = mainTrials(design, "pre", "picture_naming");
      expect(prePn).toHaveLength(24);
      expect(new Set(prePn.map((trial) => trial.itemId)).size).toBe(24);
      expect(counts(prePn.map((trial) => trial.variability))).toEqual({ no: 12, high: 12 });
      expect(summarizeRuns(prePn).variability).toBeLessThanOrEqual(2);
      expect(design.pre.trials.filter((trial) => trial.segment === "picture_naming" && trial.practice)).toHaveLength(2);
      expect(design.pre.trials.filter((trial) => trial.segment === "l2_to_l1")).toHaveLength(0);

      for (const visitType of ["immediate", "delayed"]) {
        const pn = mainTrials(design, visitType, "picture_naming");
        expect(pn).toHaveLength(24);
        expect(new Set(pn.map((trial) => trial.itemId)).size).toBe(24);
        expect(counts(pn.map((trial) => trial.variability))).toEqual({ no: 12, high: 12 });
        expect(summarizeRuns(pn).variability).toBeLessThanOrEqual(2);
        expect(counts(pn.filter((_, index) => index % 2 === 0).map((trial) => trial.protocol.pairOrientation)))
          .toEqual({ no_first: 6, high_first: 6 });

        const l2 = mainTrials(design, visitType, "l2_to_l1");
        const controls = design[visitType].trials.filter(
          (trial) => trial.segment === "l2_to_l1" && !trial.practice && trial.excludeFromAnalysis,
        );
        const fullL2 = design[visitType].trials.filter((trial) => trial.segment === "l2_to_l1");
        expect(l2).toHaveLength(24);
        expect(new Set(l2.map((trial) => trial.itemId)).size).toBe(24);
        expect(counts(l2.map((trial) => trial.testAccent))).toEqual({ english: 8, chinese: 8, japanese: 8 });
        expect(l2.every(
          (trial) => trial.talkerId === EXPECTED_TEST_TALKERS[trial.testAccent],
        )).toBe(true);
        for (const variability of ["no", "high"]) {
          const variabilityTrials = l2.filter((trial) => trial.variability === variability);
          expect(counts(variabilityTrials.map((trial) => trial.testAccent)))
            .toEqual({ english: 4, chinese: 4, japanese: 4 });
          for (const accent of ["english", "chinese", "japanese"]) {
            expect(Object.values(counts(
              variabilityTrials.filter((trial) => trial.testAccent === accent).map((trial) => trial.talkerId),
            ))).toEqual([4]);
          }
        }
        expect(summarizeRuns(l2).variability).toBeLessThanOrEqual(2);
        expect(summarizeRuns(l2).testAccent).toBeLessThanOrEqual(2);
        expect(controls.map((trial) => trial.itemId).sort((a, b) => a - b))
          .toEqual(L2_TO_L1_CONTROL_STIMULI.map((item) => item.id));
        expect(controls.every((trial) => (
          trial.practice === false
          && trial.excludeFromAnalysis === true
          && trial.expectsRecording === true
          && trial.variability === null
          && trial.testAccent === "english"
          && trial.talkerId === PRACTICE_TALKER
          && trial.protocol.controlType === "untrained_easy"
        ))).toBe(true);
        for (let miniblock = 1; miniblock <= 4; miniblock += 1) {
          const block = l2.filter((trial) => trial.miniblock === miniblock);
          expect(block).toHaveLength(6);
          expect(counts(block.map((trial) => trial.variability))).toEqual({ no: 3, high: 3 });
          expect(counts(block.map((trial) => trial.testAccent))).toEqual({ english: 2, chinese: 2, japanese: 2 });
        }
        const l2Practice = design[visitType].trials.filter(
          (trial) => trial.segment === "l2_to_l1" && trial.practice,
        );
        expect(l2Practice).toHaveLength(3);
        expect(counts(l2Practice.map((trial) => trial.testAccent))).toEqual({ english: 3 });
        expect(l2Practice.every(
          (trial) => trial.talkerId === PRACTICE_TALKER,
        )).toBe(true);
        expect(fullL2).toHaveLength(33);
        expect(maxRun(fullL2.filter((trial) => !trial.practice).map((trial) => trial.testAccent)))
          .toBeLessThanOrEqual(2);
      }

      const immediatePn = mainTrials(design, "immediate", "picture_naming");
      const delayedPn = mainTrials(design, "delayed", "picture_naming");
      const immediateL2 = mainTrials(design, "immediate", "l2_to_l1");
      const delayedL2 = mainTrials(design, "delayed", "l2_to_l1");
      expect(prePn.map((trial) => trial.itemId)).not.toEqual(immediatePn.map((trial) => trial.itemId));
      expect(prePn.map((trial) => trial.itemId)).not.toEqual(delayedPn.map((trial) => trial.itemId));
      expect(immediatePn.map((trial) => trial.itemId)).not.toEqual(delayedPn.map((trial) => trial.itemId));
      expect(immediateL2.map((trial) => trial.itemId)).not.toEqual(delayedL2.map((trial) => trial.itemId));
      const mapping = (trials) => Object.fromEntries(trials.map((trial) => [trial.itemId, [
        trial.variability,
        trial.testAccent,
        trial.talkerId,
        trial.audioKey,
        trial.protocol.timing.responseWindowAfterAudioMs,
      ]]));
      expect(mapping(immediateL2)).toEqual(mapping(delayedL2));
      expect(design.pre.expectedTrialCount).toBe(26);
      expect(design.pre.expectedRecordingCount).toBe(24);
      expect(design.immediate.expectedTrialCount).toBe(205);
      expect(design.immediate.expectedRecordingCount).toBe(54);
      expect(design.delayed.expectedTrialCount).toBe(59);
      expect(design.delayed.expectedRecordingCount).toBe(54);
    }
  });

  it("fixes learning word order within participants and randomizes it between participants", async () => {
    const first = await designFor(1);
    const second = await designFor(73);
    for (const design of [first, second]) {
      for (const variability of ["no", "high"]) {
        const blocks = Array.from({ length: 6 }, (_, index) => mainTrials(
          design,
          "immediate",
          "learning",
        ).filter((trial) => trial.variability === variability && trial.exposure === index + 1)
          .map((trial) => trial.itemId));
        expect(blocks.slice(1).every((block) => block.join() === blocks[0].join())).toBe(true);
      }
    }
    const learningOrder = (design, variability) => mainTrials(design, "immediate", "learning")
      .filter((trial) => trial.variability === variability && trial.exposure === 1)
      .map((trial) => trial.itemId);
    expect(["no", "high"].some(
      (variability) => learningOrder(first, variability).join() !== learningOrder(second, variability).join(),
    )).toBe(true);
  });

  it("includes the seed algorithm version in the root seed context", async () => {
    const first = await designFor(1);
    const second = await buildParticipantDesign({
      participantId: 1,
      participantUuid: uuidForId(1),
      ...DESIGN_INPUT,
      seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v2-test",
    });
    expect(first.assignment.rootSeedHex).not.toBe(second.assignment.rootSeedHex);
  });
});

describe("aggregate counterbalancing", () => {
  it("balances the item, variability, No-talker, and test-accent assignments for IDs 1-216", async () => {
    const designs = [];
    for (let id = 1; id <= 216; id += 1) designs.push(await designFor(id));
    expect(counts(designs.map((design) => design.assignment.trainingAccent)))
      .toEqual({ english: 72, chinese: 72, japanese: 72 });
    for (const trainingAccent of ["english", "chinese", "japanese"]) {
      const accentDesigns = designs.filter((design) => design.assignment.trainingAccent === trainingAccent);
      expect(new Set(accentDesigns.map((design) => design.assignment.counterbalanceCell)).size).toBe(24);
      expect(Object.values(counts(accentDesigns.map((design) => design.assignment.counterbalanceCell))))
        .toEqual(Array(24).fill(3));
      const aggregate = new Map();
      accentDesigns.forEach((design) => {
        design.itemAssignments.forEach((item) => {
          const key = `${item.id}|${item.variability}|${design.assignment.talkerCell}|${item.testAccent}`;
          aggregate.set(key, (aggregate.get(key) ?? 0) + 1);
        });
      });
      expect(new Set(aggregate.values())).toEqual(new Set([2]));
    }
  });
});
