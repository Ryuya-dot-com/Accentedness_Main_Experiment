import { describe, expect, it, vi } from "vitest";
import { ApiClientError, commonParticipantStartPayload } from "../public/js/api.js";
import {
  bootstrapTaskAccess,
  bootstrapWithParticipantAccess,
} from "../public/js/flow-guards.js";

function state(participantId = 17, visitType = "pre") {
  return {
    participant: { id: participantId },
    visit: { visit_type: visitType },
    manifest: [],
    accepted: [],
    participation_control: { trial_start_allowed: true, interruption: null },
  };
}

function accessUi(overrides = {}) {
  return {
    requestParticipantId: vi.fn(),
    confirmParticipantId: vi.fn().mockResolvedValue("confirm"),
    showParticipationSetup: vi.fn(),
    ...overrides,
  };
}

describe("common-link participant client access", () => {
  it("stops at the scheduled-visit response without retrying or opening task setup", async () => {
    const error = new ApiClientError(403, "visit_not_available", "internal", {
      available_at_ms: 1893553200980, server_now_ms: 1893553200979,
    });
    const api = { bootstrapCommon: vi.fn().mockRejectedValue(error) };
    const ui = accessUi();
    await expect(bootstrapWithParticipantAccess(api, ui, {
      initialParticipantId: "901", commonEntry: true,
    })).rejects.toBe(error);
    expect(api.bootstrapCommon).toHaveBeenCalledTimes(1);
    expect(ui.showParticipationSetup).not.toHaveBeenCalled();
    expect(ui.requestParticipantId).not.toHaveBeenCalled();
  });

  it("sends only the confirmed participant ID and client context", () => {
    expect(commonParticipantStartPayload({
      clientInstanceId: "client-id",
      expectedVisitType: "delayed",
      participantId: " 17 ",
    })).toEqual({
      client_instance_id: "client-id",
      expected_visit_type: "delayed",
      participant_id: "17",
      participant_id_confirmed: true,
    });
  });

  it("shows the entered ID once and starts without a name step", async () => {
    const resolvedState = state();
    const api = { bootstrapCommon: vi.fn().mockResolvedValue(resolvedState) };
    const ui = accessUi();

    await expect(bootstrapWithParticipantAccess(api, ui, {
      initialParticipantId: "17",
      commonEntry: true,
    })).resolves.toBe(resolvedState);

    expect(ui.confirmParticipantId).toHaveBeenCalledWith("17");
    expect(api.bootstrapCommon).toHaveBeenCalledWith({
      participant_id: "17",
      participant_id_confirmed: true,
    });
    expect(ui.showParticipationSetup).toHaveBeenCalledTimes(1);
  });

  it("returns to ID entry when the displayed ID is rejected", async () => {
    const resolvedState = state(18);
    const api = { bootstrapCommon: vi.fn().mockResolvedValue(resolvedState) };
    const ui = accessUi({
      requestParticipantId: vi.fn().mockResolvedValue("18"),
      confirmParticipantId: vi.fn()
        .mockResolvedValueOnce("edit")
        .mockResolvedValueOnce("confirm"),
    });

    await expect(bootstrapWithParticipantAccess(api, ui, {
      initialParticipantId: "17",
      commonEntry: true,
    })).resolves.toBe(resolvedState);
    expect(ui.confirmParticipantId).toHaveBeenNthCalledWith(1, "17");
    expect(ui.confirmParticipantId).toHaveBeenNthCalledWith(2, "18");
    expect(api.bootstrapCommon).toHaveBeenCalledTimes(1);
  });

  it("resumes an active same-visit session without asking for an ID", async () => {
    const resolvedState = state(17, "immediate");
    const api = {
      hasStoredSession: vi.fn().mockReturnValue(true),
      bootstrap: vi.fn().mockResolvedValue(resolvedState),
      bootstrapCommon: vi.fn(),
      clearSession: vi.fn(),
    };
    const ui = accessUi();
    const beforePersistentParticipantAccess = vi.fn();

    const access = await bootstrapTaskAccess(api, ui, {
      expectedVisitType: "immediate",
      expectedSegment: "picture_naming",
      beforePersistentParticipantAccess,
    });
    expect(access).toMatchObject({ state: resolvedState, testMode: false });
    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(ui.requestParticipantId).not.toHaveBeenCalled();
    expect(ui.confirmParticipantId).not.toHaveBeenCalled();
    expect(beforePersistentParticipantAccess).toHaveBeenCalledTimes(1);
  });

  it("clears an expired session and re-enters through ID confirmation", async () => {
    const resolvedState = state(17, "delayed");
    const api = {
      hasStoredSession: vi.fn().mockReturnValue(true),
      bootstrap: vi.fn().mockRejectedValue(
        new ApiClientError(401, "session_expired", "expired"),
      ),
      bootstrapCommon: vi.fn().mockResolvedValue(resolvedState),
      clearSession: vi.fn(),
    };
    const ui = accessUi({ requestParticipantId: vi.fn().mockResolvedValue("17") });

    const access = await bootstrapTaskAccess(api, ui, {
      expectedVisitType: "delayed",
      expectedSegment: "picture_naming",
    });
    expect(access).toMatchObject({ state: resolvedState, testMode: false });
    expect(api.clearSession).toHaveBeenCalledTimes(1);
    expect(ui.confirmParticipantId).toHaveBeenCalledWith("17");
  });

  it("checks persistent storage before a fresh ID start", async () => {
    const beforePersistentParticipantAccess = vi.fn();
    const api = {
      hasStoredSession: vi.fn().mockReturnValue(false),
      bootstrapCommon: vi.fn().mockResolvedValue(state(17, "immediate")),
    };
    const ui = accessUi({ requestParticipantId: vi.fn().mockResolvedValue("17") });

    await bootstrapTaskAccess(api, ui, {
      expectedVisitType: "immediate",
      expectedSegment: "learning",
      beforePersistentParticipantAccess,
    });
    expect(beforePersistentParticipantAccess.mock.invocationCallOrder[0])
      .toBeLessThan(api.bootstrapCommon.mock.invocationCallOrder[0]);
  });
});
