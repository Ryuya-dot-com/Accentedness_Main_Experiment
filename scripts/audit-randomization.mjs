import assert from "node:assert/strict";
import { assertParticipantDesignInvariants } from "../src/lib/design-invariants.js";
import { buildParticipantDesign } from "../src/lib/manifest.js";
import { maxRun } from "../src/lib/randomization.js";

const MAX_ID = 2_160;
const DESIGN_INPUT = Object.freeze({
  assignmentVersion: "main-v3-placeholder-assets",
  seedAlgorithmVersion: "hmac-sha256+xoshiro128ss-v1",
  assetVersion: "placeholder-v1",
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

const EXPECTED_TEST_TALKERS = Object.freeze({
  english: "e_test_f1",
  chinese: "c_test_f1",
  japanese: "j_test_f1",
});

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
  return design[visitType].trials.filter((trial) => trial.segment === segment && !trial.practice);
}

async function auditRandomization({ label, value: randomizationSecret }) {
  const designs = [];
  const roots = new Set();
  let worstAccentRun = 0;
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
    for (let itemId = 1; itemId <= 24; itemId += 1) {
      const exposures = learning.filter((trial) => trial.itemId === itemId);
      assert.equal(exposures.length, 6, `${label}, ID ${id}, item ${itemId}: exposures`);
      assert.equal(
        new Set(exposures.map((trial) => trial.talkerId)).size,
        exposures[0].variability === "no" ? 1 : 6,
        `${label}, ID ${id}, item ${itemId}: learning talker contract`,
      );
    }
    for (let index = 1; index < learning.length; index += 1) {
      if (learning[index - 1].variability === "high" && learning[index].variability === "high") {
        assert.notEqual(
          learning[index - 1].talkerId,
          learning[index].talkerId,
          `${label}, ID ${id}: adjacent High talker`,
        );
      }
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
      assert(
        [...practice, ...l2].every(
          (trial) => trial.talkerId === EXPECTED_TEST_TALKERS[trial.testAccent],
        ),
        `${label}, ID ${id}: fixed test talker per accent`,
      );
      const fullAccentRun = maxRun([...practice, ...l2].map((trial) => trial.testAccent));
      worstAccentRun = Math.max(worstAccentRun, fullAccentRun);
      worstVariabilityRun = Math.max(worstVariabilityRun, maxRun(l2.map((trial) => trial.variability)));
      assert(fullAccentRun <= 2, `${label}, ID ${id}: full L2 accent run`);
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
    maximum_full_l2_accent_run: worstAccentRun,
    maximum_test_variability_run: worstVariabilityRun,
    maximum_immediate_delayed_same_position_picture_naming: maximumPictureNamingSamePosition,
    maximum_immediate_delayed_same_position_l2_to_l1: maximumL2SamePosition,
    n72_counterbalance_cells_per_training_accent: "24 cells × 1",
    n216_joint_balance: "item × variability × No-talker × order × test-accent = 1 per training accent",
    pre_immediate_delayed_orders: "independent and pairwise non-identical",
    test_talkers: "one fixed female talker per accent (accent and speaker identity are fully confounded)",
  };
}

const audits = [];
for (const secret of AUDIT_SECRETS) audits.push(await auditRandomization(secret));
console.log(JSON.stringify({ audits }, null, 2));
