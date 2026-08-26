import { describe, expect, it } from "vitest";
import { assertParticipantDesignInvariants } from "../src/lib/design-invariants.js";
import { buildParticipantDesign } from "../src/lib/manifest.js";

const DESIGN_INPUT = Object.freeze({
  participantId: 1,
  participantUuid: "00000000-0000-4000-8000-000000000001",
  assignmentVersion: "main-v5-english-learning-practice-placeholder",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "placeholder-v2",
  randomizationSecret: "focused-design-invariant-test-secret",
});

async function validDesign() {
  return buildParticipantDesign(DESIGN_INPUT);
}

function mainTrials(design, visitType, segment) {
  return design[visitType].trials.filter((trial) => trial.segment === segment && !trial.practice);
}

function directSamePosition(first, second) {
  return first.filter((trial, index) => trial.itemId === second[index].itemId).length;
}

describe("participant design invariant checker", () => {
  it("accepts a valid design and reports same-position metrics without constraining them", async () => {
    const design = await validDesign();
    const metrics = assertParticipantDesignInvariants(design);
    expect(metrics.immediateDelayedSamePosition).toEqual({
      pictureNaming: directSamePosition(
        mainTrials(design, "immediate", "picture_naming"),
        mainTrials(design, "delayed", "picture_naming"),
      ),
      l2ToL1: directSamePosition(
        mainTrials(design, "immediate", "l2_to_l1"),
        mainTrials(design, "delayed", "l2_to_l1"),
      ),
    });
  });

  it("rejects incorrect declared visit and recording totals", async () => {
    const design = await validDesign();
    design.pre.expectedRecordingCount -= 1;
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("pre declared recording count");
  });

  it.each([
    ["itemId", "itemId", "item ID"],
    ["itemWord", "itemWord", "word"],
    ["imageKey", "imageKey", "image key"],
  ])("rejects a Picture Naming practice/main %s collision", async (_, field, label) => {
    const design = await validDesign();
    const practice = design.pre.trials.find(
      (trial) => trial.segment === "picture_naming" && trial.practice,
    );
    const main = mainTrials(design, "pre", "picture_naming")[0];
    practice[field] = main[field];
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow(`practice/main ${label} disjointness`);
  });

  it("rejects an L2-to-L1 practice/main audio-key collision", async () => {
    const design = await validDesign();
    const practice = design.immediate.trials.find(
      (trial) => trial.segment === "l2_to_l1" && trial.practice,
    );
    practice.audioKey = mainTrials(design, "immediate", "l2_to_l1")[0].audioKey;
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("practice/main audio key disjointness");
  });

  it("rejects an L2-to-L1 practice audio key outside the practice category", async () => {
    const design = await validDesign();
    const practice = design.immediate.trials.find(
      (trial) => trial.segment === "l2_to_l1" && trial.practice,
    );
    practice.audioKey = practice.audioKey.replace("/practice/", "/test/");
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("immediate L2-to-L1 practice audio key category");
  });

  it("rejects an L2 miniblock that does not contain all six strata once", async () => {
    const design = await validDesign();
    const block = mainTrials(design, "immediate", "l2_to_l1").filter((trial) => trial.miniblock === 1);
    const first = block[0];
    const sameVariability = block.find(
      (trial) => trial !== first && trial.variability === first.variability,
    );
    sameVariability.testAccent = first.testAccent;
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("immediate L2-to-L1 miniblock 1 strata");
  });

  it("rejects a Picture Naming adjacent pair without one No and one High item", async () => {
    const design = await validDesign();
    const trials = mainTrials(design, "pre", "picture_naming");
    trials[1].variability = trials[0].variability;
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("pre Picture Naming pair 1 composition");
  });

  it.each(["audioKey", "talkerId"])(
    "rejects an immediate/delayed %s mapping mismatch",
    async (field) => {
      const design = await validDesign();
      const delayedTrial = mainTrials(design, "delayed", "l2_to_l1")[0];
      delayedTrial[field] = `${delayedTrial[field]}-changed`;
      expect(() => assertParticipantDesignInvariants(design))
        .toThrow(`L2-to-L1 ${field} mapping`);
    },
  );

  it("rejects an immediate/delayed accent mapping mismatch even when strata remain balanced", async () => {
    const design = await validDesign();
    const block = mainTrials(design, "delayed", "l2_to_l1").filter((trial) => trial.miniblock === 1);
    const first = block[0];
    const peer = block.find((trial) => trial !== first && trial.variability === first.variability);
    [first.testAccent, peer.testAccent] = [peer.testAccent, first.testAccent];
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("L2-to-L1 testAccent mapping");
  });

  it("rejects an immediate/delayed variability mapping mismatch even when strata remain balanced", async () => {
    const design = await validDesign();
    const block = mainTrials(design, "delayed", "l2_to_l1").filter((trial) => trial.miniblock === 1);
    const first = block[0];
    const peer = block.find((trial) => trial !== first && trial.testAccent === first.testAccent);
    [first.variability, peer.variability] = [peer.variability, first.variability];
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("L2-to-L1 variability mapping");
  });

  it("rejects a learning cycle without exactly two High trials per talker", async () => {
    const design = await validDesign();
    const high = mainTrials(design, "immediate", "learning")
      .filter((trial) => trial.cycle === 1 && trial.variability === "high");
    const replacement = high.find((trial) => trial.talkerId !== high[0].talkerId);
    high[0].talkerId = replacement.talkerId;
    expect(() => assertParticipantDesignInvariants(design))
      .toThrow("learning cycle 1 High frequency");
  });
});
