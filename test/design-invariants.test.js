import { describe, expect, it } from "vitest";
import { assertParticipantDesignInvariants } from "../src/lib/design-invariants.js";
import { buildParticipantDesign } from "../src/lib/manifest.js";

const DESIGN_INPUT = Object.freeze({
  participantId: 1,
  participantUuid: "00000000-0000-4000-8000-000000000001",
  assignmentVersion: "main-v3-placeholder-assets",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "placeholder-v1",
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
