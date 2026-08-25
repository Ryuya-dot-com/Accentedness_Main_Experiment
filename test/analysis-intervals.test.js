import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://experiment.test";
const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";
const DAY_MS = 86_400_000;

async function createParticipant(participantId) {
  const response = await exports.default.fetch(new Request(`${ORIGIN}/api/admin/participants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ participant_id: participantId }),
  }));
  expect(response.status).toBe(201);
  return (await response.json()).participant;
}

async function intervalRow(participantId) {
  return env.DB.prepare(`
    SELECT * FROM analysis_intervals WHERE numeric_id = ? LIMIT 1
  `).bind(participantId).first();
}

describe("canonical analysis intervals", () => {
  it("preserves the original analysis view column prefix for migration compatibility", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(analysis_intervals)").all();
    expect(columns.results.map((column) => column.name).slice(0, 13)).toEqual([
      "participant_uuid",
      "numeric_id",
      "pre_visit_uuid",
      "immediate_visit_uuid",
      "delayed_visit_uuid",
      "pre_behavioral_completed_at_ms",
      "immediate_learning_started_at_ms",
      "pre_to_learning_interval_ms",
      "immediate_behavioral_completed_at_ms",
      "delayed_picture_naming_started_at_ms",
      "retention_interval_ms",
      "delayed_target_at_ms",
      "target_deviation_ms",
    ]);
  });

  it("uses behavioral endpoints and ignores invitation-redeem and finalization timing", async () => {
    const participantId = 700_001;
    const participant = await createParticipant(participantId);
    const preCompletedAt = 1_000_000;
    const learningStartedAt = 1_007_000;
    const learningCompletedAt = 1_500_000;
    const immediatePictureNamingStartedAt = learningCompletedAt + 1_234;
    const immediatePictureNamingCompletedAt = 1_800_000;
    const immediateL2StartedAt = immediatePictureNamingCompletedAt + 2_345;
    const immediateCompletedAt = 2_000_000;
    const delayedTargetAt = immediateCompletedAt + 5 * DAY_MS;
    const delayedPictureNamingStartedAt = delayedTargetAt + 12_345;
    const delayedPictureNamingCompletedAt = delayedPictureNamingStartedAt + 50_000;
    const delayedL2StartedAt = delayedPictureNamingCompletedAt + 6_789;

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits
        SET first_started_at_ms = ?, behavioral_completed_at_ms = ?, finalized_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(100_000, preCompletedAt, 1_900_000, participant.pre_visit_id),
      env.DB.prepare(`
        UPDATE visits
        SET first_started_at_ms = ?, behavioral_completed_at_ms = ?, finalized_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(1_001_000, immediateCompletedAt, 2_900_000, participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE visits
        SET first_started_at_ms = ?, target_at_ms = ?, finalized_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(delayedTargetAt + 1_000, delayedTargetAt, delayedTargetAt + 99_999, participant.delayed_visit_id),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = ?, completed_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'learning'
      `).bind(learningStartedAt, learningCompletedAt, participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = ?, completed_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'picture_naming'
      `).bind(
        immediatePictureNamingStartedAt,
        immediatePictureNamingCompletedAt,
        participant.immediate_visit_id,
      ),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'l2_to_l1'
      `).bind(immediateL2StartedAt, participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = ?, completed_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'picture_naming'
      `).bind(
        delayedPictureNamingStartedAt,
        delayedPictureNamingCompletedAt,
        participant.delayed_visit_id,
      ),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = ?
        WHERE visit_uuid = ? AND segment = 'l2_to_l1'
      `).bind(delayedL2StartedAt, participant.delayed_visit_id),
      env.DB.prepare(`
        UPDATE invitations SET first_redeemed_at_ms = ?, last_redeemed_at_ms = ?
        WHERE visit_uuid = ?
      `).bind(50_000, 60_000, participant.pre_visit_id),
    ]);

    const expected = {
      pre_behavioral_completed_at_ms: preCompletedAt,
      immediate_learning_started_at_ms: learningStartedAt,
      pre_to_learning_interval_ms: 7_000,
      immediate_learning_completed_at_ms: learningCompletedAt,
      immediate_picture_naming_started_at_ms: immediatePictureNamingStartedAt,
      learning_to_immediate_pn_interval_ms: 1_234,
      immediate_picture_naming_completed_at_ms: immediatePictureNamingCompletedAt,
      immediate_l2_to_l1_started_at_ms: immediateL2StartedAt,
      immediate_pn_to_l2_interval_ms: 2_345,
      immediate_behavioral_completed_at_ms: immediateCompletedAt,
      delayed_picture_naming_started_at_ms: delayedPictureNamingStartedAt,
      retention_interval_ms: 5 * DAY_MS + 12_345,
      delayed_target_at_ms: delayedTargetAt,
      target_deviation_ms: 12_345,
      delayed_picture_naming_completed_at_ms: delayedPictureNamingCompletedAt,
      delayed_l2_to_l1_started_at_ms: delayedL2StartedAt,
      delayed_pn_to_l2_interval_ms: 6_789,
    };
    expect(await intervalRow(participantId)).toMatchObject(expected);

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET first_started_at_ms = first_started_at_ms + 333333,
          finalized_at_ms = finalized_at_ms + 777777
        WHERE participant_uuid = ?
      `).bind(participant.participant_uuid),
      env.DB.prepare(`
        UPDATE invitations SET first_redeemed_at_ms = first_redeemed_at_ms + 444444,
          last_redeemed_at_ms = last_redeemed_at_ms + 555555
        WHERE visit_uuid = ?
      `).bind(participant.pre_visit_id),
    ]);

    expect(await intervalRow(participantId)).toMatchObject(expected);
  });

  it("stays null until the exact behavioral endpoints exist", async () => {
    const participantId = 700_002;
    const participant = await createParticipant(participantId);

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE visits SET first_started_at_ms = 100, finalized_at_ms = 900
        WHERE participant_uuid = ?
      `).bind(participant.participant_uuid),
      env.DB.prepare(`
        UPDATE visits SET target_at_ms = 800
        WHERE visit_uuid = ?
      `).bind(participant.delayed_visit_id),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = 500
        WHERE visit_uuid = ? AND segment = 'picture_naming'
      `).bind(participant.immediate_visit_id),
      env.DB.prepare(`
        UPDATE segments SET started_at_ms = 850
        WHERE visit_uuid = ? AND segment = 'l2_to_l1'
      `).bind(participant.delayed_visit_id),
    ]);

    expect(await intervalRow(participantId)).toMatchObject({
      pre_to_learning_interval_ms: null,
      learning_to_immediate_pn_interval_ms: null,
      immediate_pn_to_l2_interval_ms: null,
      retention_interval_ms: null,
      target_deviation_ms: null,
      delayed_pn_to_l2_interval_ms: null,
    });
  });
});
