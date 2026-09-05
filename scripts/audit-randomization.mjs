import assert from "node:assert/strict";
import { assertParticipantDesignInvariants } from "../src/lib/design-invariants.js";
import { buildParticipantDesign } from "../src/lib/manifest.js";
import { maxRun } from "../src/lib/randomization.js";
import { PRACTICE_TALKER, TEST_TALKERS } from "../src/lib/stimuli.js";

const MAX_ID = 2_160;
const DESIGN_INPUT = Object.freeze({
  assignmentVersion: "main-v10-english-practice-real-assets",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "main-assets-v2",
});
const AUDIT_SECRETS = Object.freeze([
  Object.freeze({
    label: "primary",
    value: "offline-audit-secret-not-used-for-data-collection",
  }),
  Object.freeze({
    label: "secondary-independent",
    value: "second-independent-offline-audit-secret-not-used-for-data-collection",
  }),
]);

function uuidForId(id, secretLabel) {
  const labelCode = secretLabel === "primary" ? "1" : "2";
  return `00000000-0000-4000-800${labelCode}-${String(id).padStart(12, "0")}`;
}

function count(values) {
  const output = new Map();
  for (const value of values) output.set(value, (output.get(value) ?? 0) + 1);
  return output;
}

function sortedValues(map) {
  return [...map.values()].sort((a, b) => a - b);
}

function mainTrials(design, visitType, segment) {
  return design[visitType].trials.filter(
    (trial) => trial.segment === segment && !trial.practice && !trial.excludeFromAnalysis,
  );
}

async function auditRandomization({ label, value: randomizationSecret }) {
  const designs = [];
  const roots = new Set();
  let worstMainControlAccentRun = 0;
  let worstVariabilityRun = 0;
  let maximumPictureNamingSamePosition = 0;
  let maximumL2SamePosition = 0;

  for (let id = 1; id <= MAX_ID; id += 1) {
    const design = await buildParticipantDesign({
      participantId: id,
      participantUuid: uuidForId(id, label),
      randomizationSecret,
      ...DESIGN_INPUT,
    });
    designs.push(design);
    let invariantMetrics;
    try {
      invariantMetrics = assertParticipantDesignInvariants(design);
    } catch (error) {
      throw new Error(`${label} audit, ID ${id}: ${error.message}`, { cause: error });
    }
    maximumPictureNamingSamePosition = Math.max(
      maximumPictureNamingSamePosition,
      invariantMetrics.immediateDelayedSamePosition.pictureNaming,
    );
    maximumL2SamePosition = Math.max(
      maximumL2SamePosition,
      invariantMetrics.immediateDelayedSamePosition.l2ToL1,
    );

    const expectedAccent = ["japanese", "english", "chinese"][id % 3];
    assert.equal(design.assignment.trainingAccent, expectedAccent, `${label}, ID ${id}: accent remainder`);
    assert(!roots.has(design.assignment.rootSeedHex), `${label}, ID ${id}: root seed collision`);
    roots.add(design.assignment.rootSeedHex);

    const learning = mainTrials(design, "immediate", "learning");
    assert.equal(learning.length, 144, `${label}, ID ${id}: learning count`);
    const conditionOrder = design.assignment.orderCell === 0 ? ["no", "high"] : ["high", "no"];
    for (let cycle = 1; cycle <= 6; cycle += 1) {
      const cycleTrials = learning.slice((cycle - 1) * 24, cycle * 24);
      assert(
        cycleTrials.every((trial) => trial.cycle === cycle)
          && cycleTrials.slice(0, 12).every((trial) => trial.variability === conditionOrder[0])
          && cycleTrials.slice(12).every((trial) => trial.variability === conditionOrder[1]),
        `${label}, ID ${id}: cycle ${cycle} counterbalanced Learning condition order`,
      );
    }
    for (const variability of ["no", "high"]) {
      const conditionTrials = learning.filter((trial) => trial.variability === variability);
      const referenceOrder = conditionTrials
        .filter((trial) => trial.exposure === 1)
        .map((trial) => trial.itemId);
      for (let exposure = 1; exposure <= 6; exposure += 1) {
        assert.deepEqual(
          conditionTrials.filter((trial) => trial.exposure === exposure).map((trial) => trial.itemId),
          referenceOrder,
          `${label}, ID ${id}: ${variability} fixed item order, exposure ${exposure}`,
        );
      }
    }
    for (let itemId = 1; itemId <= 24; itemId += 1) {
      const exposures = learning.filter((trial) => trial.itemId === itemId);
      assert.equal(exposures.length, 6, `${label}, ID ${id}, item ${itemId}: exposures`);
      assert.equal(
        new Set(exposures.map((trial) => trial.talkerId)).size,
        exposures[0].variability === "no" ? 1 : 6,
        `${label}, ID ${id}, item ${itemId}: learning talker contract`,
      );
    }

    const prePn = mainTrials(design, "pre", "picture_naming");
    assert.equal(prePn.length, 24, `${label}, ID ${id}: pre Picture Naming count`);
    assert.equal(
      design.pre.trials.filter((trial) => trial.segment === "l2_to_l1").length,
      0,
      `${label}, ID ${id}: no pre L2`,
    );
    worstVariabilityRun = Math.max(worstVariabilityRun, maxRun(prePn.map((trial) => trial.variability)));
    assert(maxRun(prePn.map((trial) => trial.variability)) <= 2, `${label}, ID ${id}: pre Picture Naming variability run`);

    for (const visitType of ["immediate", "delayed"]) {
      const pn = mainTrials(design, visitType, "picture_naming");
      worstVariabilityRun = Math.max(worstVariabilityRun, maxRun(pn.map((trial) => trial.variability)));
      assert(worstVariabilityRun <= 2, `${label}, ID ${id}: Picture Naming variability run`);

      const practice = design[visitType].trials.filter(
        (trial) => trial.segment === "l2_to_l1" && trial.practice,
      );
      const l2 = mainTrials(design, visitType, "l2_to_l1");
      const controls = design[visitType].trials.filter(
        (trial) => trial.segment === "l2_to_l1" && !trial.practice && trial.excludeFromAnalysis,
      );
      assert.equal(l2.length, 24, `${label}, ID ${id}: L2 experimental count`);
      assert.equal(controls.length, 6, `${label}, ID ${id}: L2 control count`);
      assert(controls.every((trial) => (
        trial.expectsRecording && trial.variability === null && trial.protocol.controlType === "untrained_easy"
      )), `${label}, ID ${id}: L2 control contract`);
      assert(
        practice.every(
          (trial) => trial.testAccent === "english" && trial.talkerId === PRACTICE_TALKER,
        ),
        `${label}, ID ${id}: fixed practice talker per accent`,
      );
      assert(
        l2.every(
          (trial) => trial.talkerId === TEST_TALKERS[trial.testAccent],
        ),
        `${label}, ID ${id}: fixed main-test talker per accent`,
      );
      const mainControlAccentRun = maxRun([...l2, ...controls]
        .sort((first, second) => first.ordinal - second.ordinal)
        .map((trial) => trial.testAccent));
      worstMainControlAccentRun = Math.max(worstMainControlAccentRun, mainControlAccentRun);
      worstVariabilityRun = Math.max(worstVariabilityRun, maxRun(l2.map((trial) => trial.variability)));
      assert(mainControlAccentRun <= 2, `${label}, ID ${id}: main/control L2 accent run`);
      assert(maxRun(l2.map((trial) => trial.variability)) <= 2, `${label}, ID ${id}: L2 variability run`);
      for (const variability of ["no", "high"]) {
        for (const accent of ["english", "chinese", "japanese"]) {
          const talkers = l2
            .filter((trial) => trial.variability === variability && trial.testAccent === accent)
            .map((trial) => trial.talkerId);
          assert.deepEqual(
            sortedValues(count(talkers)),
            [4],
            `${label}, ID ${id}: ${accent}/${variability} fixed talker`,
          );
        }
      }
    }

    const pnOrders = ["pre", "immediate", "delayed"].map(
      (visitType) => mainTrials(design, visitType, "picture_naming").map((trial) => trial.itemId),
    );
    assert.notDeepEqual(pnOrders[0], pnOrders[1], `${label}, ID ${id}: pre/immediate PN order`);
    assert.notDeepEqual(pnOrders[0], pnOrders[2], `${label}, ID ${id}: pre/delayed PN order`);
    assert.notDeepEqual(pnOrders[1], pnOrders[2], `${label}, ID ${id}: immediate/delayed PN order`);
    assert.notDeepEqual(
      mainTrials(design, "immediate", "l2_to_l1").map((trial) => trial.itemId),
      mainTrials(design, "delayed", "l2_to_l1").map((trial) => trial.itemId),
      `${label}, ID ${id}: L2 timepoint order`,
    );
  }

  const first72 = designs.slice(0, 72);
  assert.deepEqual(
    sortedValues(count(first72.map((design) => design.assignment.trainingAccent))),
    [24, 24, 24],
  );
  for (const accent of ["english", "chinese", "japanese"]) {
    const group72 = first72.filter((design) => design.assignment.trainingAccent === accent);
    assert.deepEqual(sortedValues(count(group72.map((design) => design.assignment.counterbalanceCell))), Array(24).fill(1));

    const group216 = designs.slice(0, 216).filter((design) => design.assignment.trainingAccent === accent);
    assert.deepEqual(sortedValues(count(group216.map((design) => design.assignment.counterbalanceCell))), Array(24).fill(3));
    const joint = new Map();
    for (const design of group216) {
      for (const item of design.itemAssignments) {
        const key = [
          item.id,
          item.variability,
          design.assignment.talkerCell,
          design.assignment.orderCell,
          item.testAccent,
        ].join("|");
        joint.set(key, (joint.get(key) ?? 0) + 1);
      }
    }
    assert.deepEqual(new Set(joint.values()), new Set([1]), `${label}, ${accent}: N=216 joint cells`);
  }

  return {
    randomization_secret_label: label,
    audited_participant_ids: `1-${MAX_ID}`,
    failures: 0,
    unique_root_seeds: roots.size,
    maximum_main_control_l2_accent_run: worstMainControlAccentRun,
    maximum_test_variability_run: worstVariabilityRun,
    maximum_immediate_delayed_same_position_picture_naming: maximumPictureNamingSamePosition,
    maximum_immediate_delayed_same_position_l2_to_l1: maximumL2SamePosition,
    n72_counterbalance_cells_per_training_accent: "24 cells × 1",
    n216_joint_balance: "item × variability × No-talker × order × test-accent = 1 per training accent",
    learning_order: "six 24-item cycles in one counterbalanced condition order; one fixed 12-item order across all six cycles per condition",
    high_learning_talkers: "independent six-talker permutation without replacement for each High item",
    pre_immediate_delayed_orders: "independent and pairwise non-identical",
    test_talkers: "one fixed selected talker per accent (accent and speaker identity are fully confounded)",
    l2_controls: "six untrained easy TTS items at both timepoints, excluded from No/High analysis",
  };
}

const audits = [];
for (const secret of AUDIT_SECRETS) audits.push(await auditRandomization(secret));
console.log(JSON.stringify({ audits }, null, 2));
