import { describe, expect, it, vi } from "vitest";
import { ApiClientError, shouldClearInvitationFragment } from "../public/js/api.js";
import {
  microphoneCheckStorageKey,
  redirectToCanonical,
} from "../public/js/flow-guards.js";
import { ExperimentRunner } from "../public/js/runner.js";
import { participantErrorMessage } from "../public/js/ui.js";

function stateWith({ manifest = [], accepted = [] } = {}) {
  return {
    visit: { visit_id: "visit-1", visit_type: "immediate" },
    session: { epoch: 2 },
    manifest,
    accepted,
  };
}

function runnerFor(state, apiOverrides = {}) {
  const api = {
    state: vi.fn().mockResolvedValue(state),
    completeVisit: vi.fn().mockResolvedValue({ ok: true }),
    ...apiOverrides,
  };
  const ui = {
    prompt: vi.fn().mockResolvedValue(undefined),
    setSaveState: vi.fn(),
  };
  const audio = { close: vi.fn() };
  return { runner: new ExperimentRunner(api, ui, audio, state), api, ui, audio };
}

describe("frontend reliability guards", () => {
  it("removes a raw invitation fragment after deterministic client errors but keeps it for retryable server failures", () => {
    expect(shouldClearInvitationFragment(
      new ApiClientError(409, "wrong_visit_route", "wrong route"),
    )).toBe(true);
    expect(shouldClearInvitationFragment(
      new ApiClientError(503, "production_collection_blocked", "temporarily blocked"),
    )).toBe(false);
  });

  it("shows participant-facing Japanese guidance for common server errors", () => {
    expect(participantErrorMessage({
      code: "session_superseded",
      message: "This session is no longer active",
    })).toContain("別のタブ");
    expect(participantErrorMessage({
      code: "invalid_response_payload",
      message: "visual_onset_perf_ms is outside the accepted range",
    })).toContain("整合性");
  });

  it("stops monitoring and closes audio before a post-start canonical redirect", () => {
    const calls = [];
    const redirected = redirectToCanonical(
      { next_route: "/immediate-l2-to-l1/" },
      {
        runner: { stopMonitoring: () => calls.push("stop") },
        audio: { close: () => calls.push("close") },
        location: {
          pathname: "/immediate-picture-naming/",
          replace: (path) => calls.push(`replace:${path}`),
        },
      },
    );

    expect(redirected).toBe(true);
    expect(calls).toEqual([
      "stop",
      "close",
      "replace:/immediate-l2-to-l1/",
    ]);
  });

  it("does not stop a running task when the current route is already canonical", () => {
    const stopMonitoring = vi.fn();
    const close = vi.fn();
    const replace = vi.fn();
    const redirected = redirectToCanonical(
      { next_route: "/immediate-picture-naming/" },
      {
        runner: { stopMonitoring },
        audio: { close },
        location: { pathname: "/immediate-picture-naming", replace },
      },
    );

    expect(redirected).toBe(false);
    expect(stopMonitoring).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("uses separate microphone checks for Picture Naming and L2-to-L1", () => {
    const state = stateWith();
    const pictureKey = microphoneCheckStorageKey(state, "picture_naming");
    const l2Key = microphoneCheckStorageKey(state, "l2_to_l1");

    expect(pictureKey).toBe("microphone_checked:visit-1:2:picture_naming");
    expect(l2Key).toBe("microphone_checked:visit-1:2:l2_to_l1");
    expect(pictureKey).not.toBe(l2Key);
  });

  it("retries a rejected speculative preload exactly once as a foreground load", async () => {
    const state = stateWith();
    const { runner } = runnerFor(state);
    const trial = { trial_id: "trial-1" };
    const loaded = { cueBuffer: "loaded", imageUrl: null };
    runner.preloadedTrials.set(trial.trial_id, Promise.reject(new Error("transient preload failure")));
    runner.loadTrialAssets = vi.fn().mockResolvedValue(loaded);

    await expect(runner.preloadTrial(trial)).resolves.toBe(loaded);
    expect(runner.loadTrialAssets).toHaveBeenCalledTimes(1);
    expect(runner.preloadedTrials.has(trial.trial_id)).toBe(false);
  });

  it("does not loop if the one foreground preload retry also fails", async () => {
    const state = stateWith();
    const { runner } = runnerFor(state);
    const trial = { trial_id: "trial-2" };
    runner.preloadedTrials.set(trial.trial_id, Promise.reject(new Error("speculative failure")));
    runner.loadTrialAssets = vi.fn().mockRejectedValue(new Error("foreground failure"));

    await expect(runner.preloadTrial(trial)).rejects.toThrow("foreground failure");
    expect(runner.loadTrialAssets).toHaveBeenCalledTimes(1);
  });

  it("retries visit finalization after a transient transport failure", async () => {
    const state = stateWith();
    const completeVisit = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValue({ ok: true });
    const { runner, ui } = runnerFor(state, { completeVisit });

    await expect(runner.completeVisitWithRetry()).resolves.toEqual({ ok: true });
    expect(completeVisit).toHaveBeenCalledTimes(2);
    expect(ui.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps a durably queued trial in place and retries a transient response PUT", async () => {
    const state = stateWith();
    const { runner, ui, api } = runnerFor(state);
    const acknowledge = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary response failure"))
      .mockResolvedValue({ responseAck: true });

    await expect(
      runner.acknowledgeTrialResponseWithRetry("attempt-1", acknowledge),
    ).resolves.toEqual({ responseAck: true });
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenNthCalledWith(1, api, "attempt-1");
    expect(acknowledge).toHaveBeenNthCalledWith(2, api, "attempt-1");
    expect(ui.setSaveState).toHaveBeenCalledWith("queued");
    expect(ui.prompt).toHaveBeenCalledWith(
      expect.stringContaining("この試行の回答をまだ送信できていません"),
      "回答を再送する",
    );
  });

  it("fails before another trial when an accepted WAV is absent locally and remotely", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "pending",
      }],
    });
    const { runner } = runnerFor(state);
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    const hasQueuedRecording = vi.fn().mockResolvedValue(false);

    await expect(runner.reconcileOutbox(hasQueuedRecording)).rejects.toMatchObject({
      code: "local_recording_missing",
      details: {
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
      },
    });
    expect(hasQueuedRecording).toHaveBeenCalledWith("visit-1", "attempt-recorded");
  });

  it("allows reconciliation when every accepted recording is uploaded", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "uploaded",
      }],
    });
    const { runner } = runnerFor(state);
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    const hasQueuedRecording = vi.fn();

    await expect(runner.reconcileOutbox(hasQueuedRecording)).resolves.toBe(state);
    expect(hasQueuedRecording).not.toHaveBeenCalled();
  });
});
