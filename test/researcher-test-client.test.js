import { describe, expect, it, vi } from "vitest";
import {
  ResearcherTestApi,
  ResearcherTestModeError,
  ResearcherTestRunner,
  researcherTestModeAvailable,
} from "../public/js/test-mode.js";

const ADMIN_TOKEN = "test-admin-token-that-is-long-and-private";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function testState({
  visitType = "immediate",
  segment = "picture_naming",
  manifest = null,
} = {}) {
  const resolvedManifest = manifest ?? [{
    trial_id: "test-default-trial",
    ordinal: 1,
    segment,
    expects_recording: segment !== "learning",
    current: true,
  }];
  return {
    test_mode: true,
    test_run: {
      training_accent: "english",
      visit_type: visitType,
      segment,
      persistence: "none",
    },
    visit: { visit_id: "test-run-1", visit_type: visitType, status: "active" },
    participant: { id: "999" },
    manifest: resolvedManifest,
    accepted: [],
    participation_control: { trial_start_allowed: true, interruption: null },
    next_trial_id: resolvedManifest[0]?.trial_id ?? null,
    next_route: null,
  };
}

function runnerUi(overrides = {}) {
  return {
    bindInterruptionControl: vi.fn(),
    setSaveState: vi.fn(),
    clearInterruptionPending: vi.fn(),
    setInterruptionControlEnabled: vi.fn(),
    completed: vi.fn(),
    ...overrides,
  };
}

describe("researcher test-mode client boundary", () => {
  it("exposes the test entry only when health identifies the development environment", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ environment: "development" }))
      .mockResolvedValueOnce(jsonResponse({ environment: "production" }));

    await expect(researcherTestModeAvailable({ fetchImpl })).resolves.toBe(true);
    await expect(researcherTestModeAvailable({ fetchImpl })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/health", {
      method: "GET",
      cache: "no-store",
    });
  });

  it("posts the literal test identity exactly once and keeps subsequent state in memory", async () => {
    const state = testState();
    const fetchImpl = vi.fn(function browserLikeFetch() {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(jsonResponse(state));
    });
    const api = new ResearcherTestApi("immediate", "picture_naming", {
      fetchImpl,
      origin: "https://experiment.test",
      adminToken: ADMIN_TOKEN,
    });

    expect(api.isTestMode).toBe(true);
    expect(api.hasStoredSession()).toBe(false);
    const bootstrapped = await api.bootstrap();
    await expect(api.bootstrap("999")).resolves.toBe(bootstrapped);
    await expect(api.state()).resolves.toBe(bootstrapped);
    expect(bootstrapped).toStrictEqual(state);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [path, options] = fetchImpl.mock.calls[0];
    expect(path).toBe("/api/test/bootstrap");
    expect(options).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    expect(JSON.parse(options.body)).toEqual({
      participant_id: "999",
      expected_visit_type: "immediate",
      expected_segment: "picture_naming",
    });
    expect(Object.keys(JSON.parse(options.body))).toHaveLength(3);
    await expect(api.bootstrap("test")).rejects.toBeInstanceOf(ResearcherTestModeError);
    await expect(api.bootstrap("17")).rejects.toBeInstanceOf(ResearcherTestModeError);
  });

  it("uses authenticated GET only for protected same-origin stimuli and blocks persistence", async () => {
    const state = testState();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(new Response(new Blob(["static-wave"]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }));
    const api = new ResearcherTestApi("immediate", "picture_naming", {
      fetchImpl,
      origin: "https://experiment.test",
      adminToken: ADMIN_TOKEN,
    });
    await api.bootstrap();

    const endpoint = "/api/test/stimuli/audio?key=stimuli%2Fmain-assets-v2%2Fpractice%2Fenglish%2Ftts_us_bella%2Fbook.wav";
    const stimulus = await api.fetchStimulus(endpoint);
    expect(await stimulus.text()).toBe("static-wave");
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      endpoint,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        cache: "no-store",
      },
    );

    for (const operation of [
      () => api.startTrial("trial-1"),
      () => api.saveResponse("trial-1"),
      () => api.uploadRecording("attempt-1", new Blob(["discard me"])),
      () => api.completeVisit(),
      () => api.requestParticipationInterruption("terminate", "request-1"),
      () => api.finalizeParticipationInterruption("interruption-1", "request-1"),
      () => api.fetchParticipantCopy(),
    ]) {
      expect(operation).toThrowError(ResearcherTestModeError);
    }
    await expect(api.fetchStimulus("/api/stimuli/trial-1/audio"))
      .rejects.toBeInstanceOf(ResearcherTestModeError);
    await expect(api.fetchStimulus("/styles.css"))
      .rejects.toBeInstanceOf(ResearcherTestModeError);
    await expect(api.fetchStimulus("data:image/png;base64,AAAA"))
      .rejects.toBeInstanceOf(ResearcherTestModeError);
    await expect(api.fetchStimulus(`https://other.test${endpoint}`))
      .rejects.toBeInstanceOf(ResearcherTestModeError);
    await expect(api.heartbeat()).resolves.toMatchObject({ test_mode: true });
    await expect(api.events([])).resolves.toMatchObject({ test_mode: true });
    api.clearSession();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("authorizes, accepts, and completes trials in page memory without IndexedDB or API calls", async () => {
    const manifest = [
      {
        trial_id: "test-trial-1",
        ordinal: 1,
        segment: "picture_naming",
        expects_recording: true,
        current: true,
      },
      {
        trial_id: "test-trial-2",
        ordinal: 2,
        segment: "picture_naming",
        expects_recording: false,
        current: false,
      },
    ];
    const state = testState({ manifest });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(state));
    const api = new ResearcherTestApi("immediate", "picture_naming", {
      fetchImpl,
      adminToken: ADMIN_TOKEN,
    });
    await api.bootstrap();
    const ui = runnerUi();
    const runner = new ResearcherTestRunner(api, ui, {}, state);
    const poisonedIndexedDb = new Proxy({}, {
      get() {
        throw new Error("IndexedDB must not be accessed in researcher test mode");
      },
    });
    vi.stubGlobal("indexedDB", poisonedIndexedDb);

    try {
      runner.startMonitoring();
      expect(runner.running).toBe(true);
      expect(runner.heartbeatTimer).toBeNull();

      const authorization = await runner.authorizeTrial(manifest[0]);
      await runner.markTrialStimulusShown(manifest[0].trial_id);
      const recording = new Blob(["must-not-be-retained"]);
      await runner.persistTrial(
        manifest[0],
        authorization,
        { answer: "must-not-be-retained" },
        recording,
      );

      expect(runner.acceptedTrialIds()).toEqual(new Set(["test-trial-1"]));
      expect(state.accepted).toEqual([expect.objectContaining({
        trial_id: "test-trial-1",
        attempt_id: authorization.attempt_id,
        recording_state: "discarded",
        test_mode: true,
      })]);
      expect(state.accepted[0]).not.toHaveProperty("payload");
      expect(state.accepted[0]).not.toHaveProperty("blob");
      expect(runner.memoryAttempts.size).toBe(0);
      expect(state.next_trial_id).toBe("test-trial-2");
      expect(manifest.map((trial) => trial.current)).toEqual([false, true]);
      expect(JSON.stringify(runner)).not.toContain("must-not-be-retained");

      await expect(runner.reconcileOutbox()).resolves.toBe(state);
      await expect(runner.flushWithRetry()).resolves.toBe(state);
      await expect(runner.sendEvent("test-event")).resolves.toMatchObject({ test_mode: true });
      await expect(runner.completeVisitWithRetry()).resolves.toMatchObject({ test_mode: true });
      expect(state.visit.status).toBe("test_complete");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      runner.stopMonitoring();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not enter any interruption or test-exit flow", async () => {
    const state = testState();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(state));
    const api = new ResearcherTestApi("immediate", "picture_naming", {
      fetchImpl,
      adminToken: ADMIN_TOKEN,
    });
    await api.bootstrap();
    const ui = runnerUi({
      chooseResearcherTestExit: vi.fn(),
      researcherTestInterrupted: vi.fn(),
      chooseInterruptionMode: vi.fn(() => {
        throw new Error("Participant interruption copy must not be used");
      }),
    });
    const runner = new ResearcherTestRunner(api, ui, {}, state);

    runner.participantExitRequested = true;
    await expect(runner.handleParticipantExit()).resolves.toBe(false);
    expect(runner.participantExitRequested).toBe(false);
    expect(ui.chooseInterruptionMode).not.toHaveBeenCalled();
    expect(ui.chooseResearcherTestExit).not.toHaveBeenCalled();
    expect(ui.researcherTestInterrupted).not.toHaveBeenCalled();
    expect(ui.completed).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
