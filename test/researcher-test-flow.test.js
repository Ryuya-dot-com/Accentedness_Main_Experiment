import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../public/js/api.js";
import { bootstrapTaskAccess } from "../public/js/flow-guards.js";

function testState(visitType, segment) {
  return {
    test_mode: true,
    test_run: {
      training_accent: "english",
      visit_type: visitType,
      segment,
      persistence: "none",
    },
    visit: {
      visit_id: "10000000-0000-4000-8000-000000000001",
      visit_type: visitType,
      status: "active",
    },
    participant: { id: "test" },
    manifest: [{
      trial_id: "20000000-0000-4000-8000-000000000001",
      ordinal: 1,
      segment,
      current: true,
    }],
    accepted: [],
    participation_control: { trial_start_allowed: true, interruption: null },
    next_trial_id: "20000000-0000-4000-8000-000000000001",
    next_route: null,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function accessUi(participantId = "test") {
  return {
    requestParticipantId: vi.fn().mockResolvedValue(participantId),
    activateResearcherTestMode: vi.fn(),
    showParticipationSetup: vi.fn(),
  };
}

describe("literal test ID task access", () => {
  it("uses the existing ID decision to bypass every participant persistence API", async () => {
    const state = testState("immediate", "learning");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ environment: "development" }))
      .mockResolvedValueOnce(jsonResponse(state));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const realApi = {
        hasStoredSession: vi.fn().mockReturnValue(false),
        hasInvitationToken: vi.fn().mockReturnValue(false),
        bootstrap: vi.fn(),
        previewParticipantName: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      const access = await bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "immediate",
        expectedSegment: "learning",
      });

      expect(access.testMode).toBe(true);
      expect(access.api.isTestMode).toBe(true);
      expect(access.state).toEqual(state);
      expect(realApi.bootstrap).not.toHaveBeenCalled();
      expect(realApi.previewParticipantName).not.toHaveBeenCalled();
      expect(realApi.clearSession).not.toHaveBeenCalled();
      expect(ui.activateResearcherTestMode).toHaveBeenCalledWith(null, "immediate");
      expect(ui.showParticipationSetup).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("/api/health");
      expect(fetchMock.mock.calls[1][0]).toBe("/api/test/bootstrap");
      expect(ui.activateResearcherTestMode.mock.invocationCallOrder[0])
        .toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enters researcher UI context before a test bootstrap failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ environment: "development" }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const realApi = {
        hasStoredSession: vi.fn().mockReturnValue(false),
        hasInvitationToken: vi.fn().mockReturnValue(false),
        bootstrap: vi.fn(),
        previewParticipantName: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      await expect(bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "delayed",
        expectedSegment: "picture_naming",
      })).rejects.toThrow("network unavailable");

      expect(ui.activateResearcherTestMode).toHaveBeenCalledWith(null, "delayed");
      expect(ui.activateResearcherTestMode.mock.invocationCallOrder[0])
        .toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
      expect(ui.showParticipationSetup).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not enter researcher test mode from a participant invitation URL", async () => {
    const realApi = {
      hasStoredSession: vi.fn().mockReturnValue(false),
      hasInvitationToken: vi.fn().mockReturnValue(true),
      bootstrap: vi.fn(),
      previewParticipantName: vi.fn().mockRejectedValue(
        new ApiClientError(400, "invalid_participant_id", "positive integer required"),
      ),
      clearSession: vi.fn(),
    };
    const ui = accessUi();

    await expect(bootstrapTaskAccess(realApi, ui, {
      expectedVisitType: "pre",
      expectedSegment: "picture_naming",
    })).rejects.toMatchObject({ code: "invalid_participant_id" });

    expect(realApi.previewParticipantName).toHaveBeenCalledWith("test");
    expect(realApi.bootstrap).not.toHaveBeenCalled();
    expect(ui.activateResearcherTestMode).not.toHaveBeenCalled();
  });

  it("clears only an invalid stale real session before showing the same ID field", async () => {
    const state = testState("delayed", "l2_to_l1");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ environment: "development" }))
      .mockResolvedValueOnce(jsonResponse(state));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const realApi = {
        hasStoredSession: vi.fn().mockReturnValue(true),
        hasInvitationToken: vi.fn().mockReturnValue(false),
        bootstrap: vi.fn().mockRejectedValue(
          new ApiClientError(401, "invalid_session", "stale session"),
        ),
        previewParticipantName: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      const access = await bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "delayed",
        expectedSegment: "l2_to_l1",
      });

      expect(access.testMode).toBe(true);
      expect(realApi.bootstrap).toHaveBeenCalledTimes(1);
      expect(realApi.clearSession).toHaveBeenCalledTimes(1);
      expect(ui.requestParticipantId).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not treat a numeric ID on a plain URL as test mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ environment: "development" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const realApi = {
      hasStoredSession: vi.fn().mockReturnValue(false),
      hasInvitationToken: vi.fn().mockReturnValue(false),
      bootstrap: vi.fn(),
      previewParticipantName: vi.fn(),
      clearSession: vi.fn(),
    };
    const ui = accessUi("17");

    try {
      await expect(bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "immediate",
        expectedSegment: "learning",
      })).rejects.toMatchObject({ code: "invitation_required" });
      expect(realApi.bootstrap).not.toHaveBeenCalled();
      expect(realApi.previewParticipantName).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not reveal or enter researcher test mode in production", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ environment: "production" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const realApi = {
        hasStoredSession: vi.fn().mockReturnValue(false),
        hasInvitationToken: vi.fn().mockReturnValue(false),
        bootstrap: vi.fn(),
        previewParticipantName: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      await expect(bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "pre",
        expectedSegment: "picture_naming",
      })).rejects.toMatchObject({ code: "invitation_required" });

      expect(ui.requestParticipantId).not.toHaveBeenCalled();
      expect(ui.activateResearcherTestMode).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wires both task programs to the no-write access boundary", async () => {
    const [learningResponse, segmentResponse] = await Promise.all([
      exports.default.fetch(new Request("https://experiment.test/js/learning.js")),
      exports.default.fetch(new Request("https://experiment.test/js/segment.js")),
    ]);
    const [learning, segment] = await Promise.all([
      learningResponse.text(),
      segmentResponse.text(),
    ]);

    for (const source of [learning, segment]) {
      expect(source).toContain("bootstrapTaskAccess");
      expect(source).toContain("ResearcherTestRunner");
      expect(source).toMatch(/if \(testMode\)/u);
      expect(source).not.toContain("researcherTestModeAvailable");
    }
    expect(segment).toContain("api.isTestMode");
    expect(segment).toMatch(/if \(checkKey\) sessionStorage\.setItem/u);
  });
});
