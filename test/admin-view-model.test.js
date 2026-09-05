import { describe, expect, it } from "vitest";
import {
  buildInvitationMessage,
  canonicalParticipantId,
  classifyAdminHealth,
  consumeZipResponse,
  freshCopyDecision,
  operatorActionView,
  participantCategory,
  participantListFromAdminPayload,
  transferProgressText,
  visitIsVerifiedComplete,
  visitStatusLabel,
  zipLabelForParticipant,
} from "../public/js/admin-operations.js";

const productionReady = classifyAdminHealth({
  ok: true,
  environment: "production",
  collection_ready: true,
  placeholder_assets: false,
});

describe("admin health fail-closed gate", () => {
  it.each([
    [null, "unknown"],
    [{ ok: true, environment: "development", collection_ready: true }, "development"],
    [{
      ok: true,
      environment: "production",
      collection_ready: false,
      placeholder_assets: false,
    }, "production-blocked"],
    [{
      ok: true,
      environment: "production",
      collection_ready: true,
      placeholder_assets: true,
    }, "production-blocked"],
  ])("blocks distribution for %j", (payload, mode) => {
    const result = classifyAdminHealth(payload);
    expect(result.mode).toBe(mode);
    expect(result.canDistribute).toBe(false);
  });

  it("allows distribution only for a ready, non-placeholder production environment", () => {
    expect(productionReady).toMatchObject({
      mode: "production",
      canDistribute: true,
      showQa: false,
    });
  });

  it("exposes QA links only for development", () => {
    expect(classifyAdminHealth({
      ok: true,
      environment: "development",
      collection_ready: false,
    })).toMatchObject({ canDistribute: false, showQa: true });
  });
});

describe("server-authoritative next action", () => {
  it("cancels a copy when production readiness changes before copying", () => {
    const participant = {
      participant_id: 27,
      next_action: {
        code: "start_immediate",
        category: "ready",
        visit_type: "immediate",
        path: "/main-experiment/",
      },
    };
    expect(freshCopyDecision(
      participant,
      [participant],
      classifyAdminHealth({
        ok: true,
        environment: "production",
        collection_ready: false,
        placeholder_assets: false,
      }),
    )).toMatchObject({ copyable: false, reason: "environment_changed" });
  });

  it("cancels a copy when the participant next action changes during refresh", () => {
    const original = {
      participant_id: 27,
      next_action: {
        code: "start_immediate",
        category: "ready",
        visit_type: "immediate",
        path: "/main-experiment/",
      },
    };
    const latest = {
      participant_id: 27,
      next_action: {
        code: "resume_immediate",
        category: "in_progress",
        visit_type: "immediate",
        path: "/main-experiment/",
      },
    };
    expect(freshCopyDecision(original, [latest], productionReady))
      .toMatchObject({ copyable: false, reason: "action_changed" });
  });

  it("allows a copy only when the refreshed action remains unchanged and safe", () => {
    const participant = {
      participant_id: 27,
      next_action: {
        code: "start_delayed",
        category: "ready",
        visit_type: "delayed",
        path: "/delayed-picture-naming/",
      },
    };
    expect(freshCopyDecision(participant, [{ ...participant }], productionReady))
      .toMatchObject({ copyable: true, reason: "current" });
  });

  it("never creates an action for an unknown server code", () => {
    const view = operatorActionView({
      next_action: {
        code: "surprise_action",
        visit_type: "pre",
        path: "/pre-picture-naming/",
      },
    }, productionReady);
    expect(view.copyable).toBe(false);
    expect(view.buttonLabel).toBeNull();
    expect(view.message).toContain("案内しないでください");
  });

  it.each([
    "wait_delayed",
    "retry_immediate_uploads",
    "finalize_immediate",
    "wait_immediate_recording_upload",
    "finish_interruption",
    "resume_paused_visit",
    "complete",
    "participation_ended",
    "review_state",
  ])("does not create a button for blocked code %s even if a path is present", (code) => {
    const view = operatorActionView({
      next_action: {
        code,
        visit_type: "immediate",
        path: "/main-experiment/",
        available_at_ms: Date.UTC(2026, 7, 31),
      },
    }, productionReady);
    expect(view.copyable).toBe(false);
    expect(view.buttonLabel).toBeNull();
    expect(view.path).toBeNull();
  });

  it.each([
    ["start_pre", "pre", "/pre-picture-naming/"],
    ["resume_pre", "pre", "/pre-picture-naming/"],
    ["start_immediate", "immediate", "/main-experiment/"],
    ["resume_immediate", "immediate", "/main-experiment/"],
    ["start_delayed", "delayed", "/delayed-picture-naming/"],
    ["resume_delayed", "delayed", "/delayed-picture-naming/"],
  ])("copies an ID-bearing message for safe action %s", (code, visitType, path) => {
    const nextAction = {
      code,
      category: code.startsWith("start_") ? "ready" : "in_progress",
      visit_type: visitType,
      path,
    };
    const view = operatorActionView({ next_action: nextAction }, productionReady);
    expect(view.copyable).toBe(true);
    const message = buildInvitationMessage({
      participantId: 27,
      nextAction,
      origin: "https://experiment.test",
    });
    expect(message).toContain("参加者ID：27");
    expect(message).toContain(`https://experiment.test${path}`);
    expect(message).toContain("同じURLと参加者IDで再開できます");
    expect(message).toContain("参加者IDを入力し、表示された同じIDを確認");
  });

  it("rejects a path that does not match the server action visit", () => {
    const view = operatorActionView({
      next_action: {
        code: "start_delayed",
        category: "ready",
        visit_type: "delayed",
        path: "/main-experiment/",
      },
    }, productionReady);
    expect(view.copyable).toBe(false);
    expect(view.message).toContain("案内しないでください");
  });

  it("blocks an otherwise safe action outside ready production", () => {
    const view = operatorActionView({
      next_action: {
        code: "start_pre",
        category: "ready",
        visit_type: "pre",
        path: "/pre-picture-naming/",
      },
    }, classifyAdminHealth({ ok: true, environment: "development" }));
    expect(view.copyable).toBe(false);
  });

  it.each([
    ["start_pre", "attention"],
    ["start_immediate", "in_progress"],
    ["resume_delayed", "ready"],
  ])("rejects inconsistent action/category pair %s + %s", (code, category) => {
    const visitType = code.endsWith("_pre")
      ? "pre"
      : code.endsWith("_immediate")
        ? "immediate"
        : "delayed";
    const path = {
      pre: "/pre-picture-naming/",
      immediate: "/main-experiment/",
      delayed: "/delayed-picture-naming/",
    }[visitType];
    expect(operatorActionView({
      next_action: { code, category, visit_type: visitType, path },
    }, productionReady).copyable).toBe(false);
  });
});

describe("admin participant response validation", () => {
  it("accepts a unique canonical participant list", () => {
    const participants = [{
      participant_id: 27,
      visits: [],
      next_action: { code: "wait_delayed", category: "waiting", path: null },
    }];
    expect(participantListFromAdminPayload({
      ok: true,
      server_now_ms: 1,
      participants,
    })).toBe(participants);
  });

  it.each([
    null,
    {},
    { participants: null },
    { ok: false, participants: [] },
    {
      ok: true,
      server_now_ms: 1,
      participants: [{
        participant_id: 27,
        visits: [],
        next_action: { code: "future_complete", category: "completed", path: null },
      }],
    },
    { ok: true, participants: [{ participant_id: "P27", next_action: { code: "complete", category: "completed" } }] },
    { ok: true, participants: [{ participant_id: 27 }] },
    {
      ok: true,
      participants: [
        { participant_id: 27, next_action: { code: "complete", category: "completed" } },
        { participant_id: "27", next_action: { code: "complete", category: "completed" } },
      ],
    },
  ])("rejects a malformed or ambiguous response: %j", (payload) => {
    expect(() => participantListFromAdminPayload(payload)).toThrow("invalid_admin_response");
  });
});

describe("admin labels and filters", () => {
  it("counts a completed visit only when responses and main recordings are consistent", () => {
    const completeVisit = {
      status: "completed",
      finalized_at_ms: 1,
      accepted_trials: 24,
      expected_trials: 24,
      accepted_recording_trials: 24,
      uploaded_recordings: 24,
      expected_recordings: 24,
      pending_recordings: 0,
      missing_recordings: 0,
      abandoned_recordings: 0,
    };
    expect(visitIsVerifiedComplete(completeVisit)).toBe(true);
    expect(visitIsVerifiedComplete({ ...completeVisit, uploaded_recordings: 23 })).toBe(false);
    expect(visitIsVerifiedComplete({ ...completeVisit, finalized_at_ms: null })).toBe(false);
  });

  it.each([
    ["retry_pre_uploads", "attention", null, null, "attention"],
    ["finalize_immediate", "attention", null, null, "attention"],
    ["complete", "completed", null, null, "complete"],
    ["participation_ended", "ended", null, null, "complete"],
    ["resume_immediate", "in_progress", "immediate", "/main-experiment/", "in_progress"],
    ["wait_immediate_recording_upload", "waiting", null, null, "in_progress"],
  ])("classifies %s using server category %s", (code, serverCategory, visitType, path, category) => {
    expect(participantCategory({
      next_action: { code, category: serverCategory, visit_type: visitType, path },
    })).toBe(category);
  });

  it.each(["start_delayed", "resume_delayed"])(
    "uses a verified delayed action for the delayed filter: %s",
    (code) => {
      expect(participantCategory({
        next_action: {
          code,
          category: code.startsWith("start_") ? "ready" : "in_progress",
          visit_type: "delayed",
          path: "/delayed-picture-naming/",
        },
      })).toBe("delayed");
    },
  );

  it("does not invent a category for an unknown server category", () => {
    expect(participantCategory({
      next_action: { code: "review_state", category: "future_category" },
    })).toBe("attention");
  });

  it("keeps a server waiting category out of attention", () => {
    expect(participantCategory({
      next_action: {
        code: "wait_immediate_recording_upload",
        category: "waiting",
        path: null,
      },
    })).toBe("in_progress");
  });

  it("treats an unknown action claiming completion as attention", () => {
    expect(participantCategory({
      next_action: {
        code: "future_complete",
        category: "completed",
        path: null,
      },
    })).toBe("attention");
  });

  it("does not expose an unknown English visit state", () => {
    expect(visitStatusLabel("started")).toBe("実施中");
    expect(visitStatusLabel("future_internal_state")).toBe("状態確認が必要");
  });

  it("uses one ZIP label whose completeness follows the server next action", () => {
    expect(zipLabelForParticipant({ next_action: { code: "complete" } }))
      .toBe("全時点完了データZIPを保存");
    expect(zipLabelForParticipant({ next_action: { code: "resume_delayed" } }))
      .toBe("現在保存済みの部分データZIPを保存");
  });

  it("validates canonical numeric IDs without extracting digits", () => {
    expect(canonicalParticipantId("21")).toBe("21");
    expect(canonicalParticipantId("P21")).toBeNull();
    expect(canonicalParticipantId("021")).toBeNull();
    expect(canonicalParticipantId("0")).toBeNull();
  });

  it("reports Content-Length progress when available", () => {
    expect(transferProgressText(5 * 1024 * 1024, 10 * 1024 * 1024))
      .toBe("50%（5.0 / 10.0 MB）");
    expect(transferProgressText(1024 * 1024, 0)).toBe("1.0 MB受信");
  });

  it("streams a ZIP body, checks Content-Length, and reports progress", async () => {
    const progress = [];
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    }), {
      headers: {
        "Content-Length": "3",
        "Content-Type": "application/zip",
      },
    });
    const result = await consumeZipResponse(
      response,
      null,
      (received, expected) => progress.push([received, expected]),
    );

    expect(result).toMatchObject({ received: 3, expected: 3 });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(3);
    expect(progress).toEqual([[2, 3], [3, 3]]);
  });
});
