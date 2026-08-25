import { describe, expect, it } from "vitest";
import {
  buildParticipantDesign,
  canonicalParticipantId,
  deriveCounterbalance,
  summarizeRuns,
} from "../src/lib/manifest.js";
import { maxRun } from "../src/lib/randomization.js";

const DESIGN_INPUT = Object.freeze({
  assignmentVersion: "main-v3-placeholder-assets",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "placeholder-v1",
  randomizationSecret: "test-randomization-secret-that-is-independent",
});

const EXPECTED_TEST_TALKERS = Object.freeze({
  english: "e_test_f1",
  chinese: "c_test_f1",
  japanese: "j_test_f1",
});

function counts(values) {
  return values.reduce((output, value) => {
    output[value] = (output[value] ?? 0) + 1;
    return output;
  }, {});
}

function mainTrials(design, visitType, segment) {
  return design[visitType].trials.filter((trial) => trial.segment === segment && !trial.practice);
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
      for (let cycle = 1; cycle <= 6; cycle += 1) {
        const cycleTrials = learning.filter((trial) => trial.cycle === cycle);
        expect(cycleTrials).toHaveLength(24);
        expect(new Set(cycleTrials.map((trial) => trial.itemId)).size).toBe(24);
        const highTalkerCounts = counts(
          cycleTrials.filter((trial) => trial.variability === "high").map((trial) => trial.talkerId),
        );
        expect(Object.keys(highTalkerCounts)).toHaveLength(6);
        expect(Object.values(highTalkerCounts)).toEqual(Array(6).fill(2));
      }
      expect(maxRun(learning.map((trial) => trial.variability))).toBe(24);
      for (let index = 1; index < learning.length; index += 1) {
        if (learning[index - 1].variability === "high" && learning[index].variability === "high") {
          expect(learning[index - 1].talkerId).not.toBe(learning[index].talkerId);
        }
      }
      const highByRank = new Map();
      learning.filter((trial) => trial.variability === "high").forEach((trial) => {
        const sequence = highByRank.get(trial.listRank) ?? [];
        sequence.push(trial.talkerId);
        highByRank.set(trial.listRank, sequence);
      });
      for (let rank = 0; rank < 6; rank += 1) {
        expect(highByRank.get(rank)).not.toEqual(highByRank.get(rank + 6));
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
        expect(counts(l2Practice.map((trial) => trial.testAccent)))
          .toEqual({ english: 1, chinese: 1, japanese: 1 });
        expect(l2Practice.every(
          (trial) => trial.talkerId === EXPECTED_TEST_TALKERS[trial.testAccent],
        )).toBe(true);
        expect(maxRun([...l2Practice, ...l2].map((trial) => trial.testAccent))).toBeLessThanOrEqual(2);
      }

      const immediatePn = mainTrials(design, "immediate", "picture_naming");
      const delayedPn = mainTrials(design, "delayed", "picture_naming");
      const immediateL2 = mainTrials(design, "immediate", "l2_to_l1");
      const delayedL2 = mainTrials(design, "delayed", "l2_to_l1");
      expect(prePn.map((trial) => trial.itemId)).not.toEqual(immediatePn.map((trial) => trial.itemId));
      expect(prePn.map((trial) => trial.itemId)).not.toEqual(delayedPn.map((trial) => trial.itemId));
      expect(immediatePn.map((trial) => trial.itemId)).not.toEqual(delayedPn.map((trial) => trial.itemId));
      expect(immediateL2.map((trial) => trial.itemId)).not.toEqual(delayedL2.map((trial) => trial.itemId));
      const mapping = (trials) => Object.fromEntries(trials.map((trial) => [trial.itemId, [trial.variability, trial.testAccent, trial.talkerId]]));
      expect(mapping(immediateL2)).toEqual(mapping(delayedL2));
      expect(design.pre.expectedTrialCount).toBe(26);
      expect(design.pre.expectedRecordingCount).toBe(26);
      expect(design.immediate.expectedTrialCount).toBe(197);
      expect(design.immediate.expectedRecordingCount).toBe(53);
      expect(design.delayed.expectedTrialCount).toBe(53);
      expect(design.delayed.expectedRecordingCount).toBe(53);
    }
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
