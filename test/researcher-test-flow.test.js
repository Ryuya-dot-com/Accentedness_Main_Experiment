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
    participant: { id: "999" },
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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function accessUi(participantId = "999") {
  return {
    requestParticipantId: vi.fn().mockResolvedValue(participantId),
    confirmParticipantId: vi.fn().mockResolvedValue("confirm"),
    requestResearcherToken: vi.fn().mockResolvedValue("test-admin-token-that-is-long-and-private"),
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
        bootstrap: vi.fn(),
        bootstrapCommon: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();
      const beforePersistentParticipantAccess = vi.fn();

      const access = await bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "immediate",
        expectedSegment: "learning",
        beforePersistentParticipantAccess,
      });

      expect(access.testMode).toBe(true);
      expect(access.api.isTestMode).toBe(true);
      expect(access.state).toEqual(state);
      expect(realApi.bootstrap).not.toHaveBeenCalled();
      expect(realApi.clearSession).not.toHaveBeenCalled();
      expect(ui.activateResearcherTestMode).toHaveBeenCalledWith(null, "immediate");
      expect(ui.requestResearcherToken).toHaveBeenCalledTimes(1);
      expect(ui.showParticipationSetup).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("/api/health");
      expect(fetchMock.mock.calls[1][0]).toBe("/api/test/bootstrap");
      expect(beforePersistentParticipantAccess).not.toHaveBeenCalled();
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
        bootstrap: vi.fn(),
        bootstrapCommon: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      await expect(bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "delayed",
        expectedSegment: "picture_naming",
      })).rejects.toThrow("network unavailable");

      expect(ui.activateResearcherTestMode).toHaveBeenCalledWith(null, "delayed");
      expect(ui.requestResearcherToken).toHaveBeenCalledTimes(1);
      expect(ui.activateResearcherTestMode.mock.invocationCallOrder[0])
        .toBeLessThan(fetchMock.mock.invocationCallOrder[1]);
      expect(ui.showParticipationSetup).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-prompts only the researcher token after an authorization failure", async () => {
    const state = testState("pre", "picture_naming");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ environment: "development" }))
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "admin_forbidden", message: "Admin authorization failed" },
      }, 403))
      .mockResolvedValueOnce(jsonResponse(state));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const realApi = {
        hasStoredSession: vi.fn().mockReturnValue(false),
      };
      const ui = accessUi();
      ui.requestResearcherToken
        .mockResolvedValueOnce("wrong-token")
        .mockResolvedValueOnce("test-admin-token-that-is-long-and-private");

      const access = await bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "pre",
        expectedSegment: "picture_naming",
      });

      expect(access).toMatchObject({ testMode: true, state });
      expect(ui.requestParticipantId).toHaveBeenCalledTimes(1);
      expect(ui.requestResearcherToken).toHaveBeenNthCalledWith(1, "");
      expect(ui.requestResearcherToken.mock.calls[1][0]).toContain("確認できませんでした");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer wrong-token");
      expect(fetchMock.mock.calls[2][1].headers.Authorization)
        .toBe("Bearer test-admin-token-that-is-long-and-private");
      expect(fetchMock.mock.calls.slice(1).map((call) => call[1].body).join(""))
        .not.toContain("admin-token");
    } finally {
      vi.unstubAllGlobals();
    }
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
        bootstrap: vi.fn().mockRejectedValue(
          new ApiClientError(401, "invalid_session", "stale session"),
        ),
        bootstrapCommon: vi.fn(),
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
      expect(ui.requestResearcherToken).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the ID-only common participant entry for a numeric ID", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = {
      visit: { visit_type: "immediate" },
      participant: { id: 17 },
      manifest: [],
      accepted: [],
      participation_control: { trial_start_allowed: true, interruption: null },
    };
    const realApi = {
      hasStoredSession: vi.fn().mockReturnValue(false),
      bootstrap: vi.fn(),
      bootstrapCommon: vi.fn().mockResolvedValue(state),
      clearSession: vi.fn(),
    };
    const ui = accessUi("17");

    try {
      const access = await bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "immediate",
        expectedSegment: "learning",
      });
      expect(access).toMatchObject({ state, testMode: false });
      expect(realApi.bootstrap).not.toHaveBeenCalled();
      expect(realApi.bootstrapCommon).toHaveBeenCalledWith({
        participant_id: "17",
        participant_id_confirmed: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
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
        bootstrap: vi.fn(),
        bootstrapCommon: vi.fn(),
        clearSession: vi.fn(),
      };
      const ui = accessUi();

      await expect(bootstrapTaskAccess(realApi, ui, {
        expectedVisitType: "pre",
        expectedSegment: "picture_naming",
      })).rejects.toMatchObject({ code: "reserved_test_participant_id" });

      expect(ui.requestParticipantId).toHaveBeenCalledTimes(1);
      expect(ui.activateResearcherTestMode).not.toHaveBeenCalled();
      expect(ui.requestResearcherToken).not.toHaveBeenCalled();
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
      expect(source).toMatch(/if \((?:testMode|api\.isTestMode)\)/u);
      expect(source).not.toContain("researcherTestModeAvailable");
    }
    expect(segment).toContain("api.isTestMode");
    expect(segment).toMatch(/if \(checkKey\) sessionStorage\.setItem/u);
  });
});
