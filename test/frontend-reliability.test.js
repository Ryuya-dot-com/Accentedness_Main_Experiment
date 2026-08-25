import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  participantCopyFilename,
  shouldClearInvitationFragment,
  writeResponseToFile,
} from "../public/js/api.js";
import {
  microphoneCheckStorageKey,
  redirectToCanonical,
} from "../public/js/flow-guards.js";
import {
  fullyAcknowledgedAttemptIds,
  isQueuedTrialFullyAcknowledged,
} from "../public/js/outbox.js";
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
  it("purges a queued trial only after both remote acknowledgements are durable", () => {
    expect(isQueuedTrialFullyAcknowledged({ responseAck: true, recordingAck: true })).toBe(true);
    expect(isQueuedTrialFullyAcknowledged({ responseAck: true, recordingAck: false })).toBe(false);
    expect(isQueuedTrialFullyAcknowledged({ responseAck: false, recordingAck: true })).toBe(false);
    expect(isQueuedTrialFullyAcknowledged(null)).toBe(false);
  });

  it("selects fully acknowledged residue across visits without deleting partial acknowledgements", () => {
    const records = [
      {
        attemptId: "pre-complete",
        visitId: "pre-visit",
        responseAck: true,
        recordingAck: true,
      },
      {
        attemptId: "immediate-response-only",
        visitId: "immediate-visit",
        responseAck: true,
        recordingAck: false,
      },
      {
        attemptId: "delayed-recording-only",
        visitId: "delayed-visit",
        responseAck: false,
        recordingAck: true,
      },
      {
        attemptId: "delayed-complete",
        visitId: "delayed-visit",
        responseAck: true,
        recordingAck: true,
      },
    ];

    expect(fullyAcknowledgedAttemptIds(records)).toEqual([
      "pre-complete",
      "delayed-complete",
    ]);
  });

  it("removes a raw invitation fragment after deterministic client errors but keeps it for retryable server failures", () => {
    expect(shouldClearInvitationFragment(
      new ApiClientError(409, "wrong_visit_route", "wrong route"),
    )).toBe(true);
    expect(shouldClearInvitationFragment(
      new ApiClientError(503, "production_collection_blocked", "temporarily blocked"),
    )).toBe(false);
    expect(shouldClearInvitationFragment(
      new ApiClientError(409, "invitation_redeem_conflict", "retry redemption"),
    )).toBe(false);
    for (const status of [408, 425, 429]) {
      expect(shouldClearInvitationFragment(
        new ApiClientError(status, "temporarily_unavailable", "retry redemption"),
      )).toBe(false);
    }
    expect(shouldClearInvitationFragment(
      new ApiClientError(403, "visit_not_available", "open after target time"),
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
    expect(participantErrorMessage({
      code: "session_expired",
      message: "The session expired",
    })).toContain("参加期限ではありません");
    expect(participantErrorMessage({
      code: "participant_copy_session_expired",
      message: "The session expired",
    })).toContain("研究担当者へ依頼");
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

  it("uses one safe filename for the single participant ZIP", () => {
    expect(participantCopyFilename('attachment; filename="accentedness_results.zip"'))
      .toBe("accentedness_results.zip");
    expect(participantCopyFilename('attachment; filename="../../unsafe.zip"'))
      .toBe("accentedness_results.zip");
  });

  it("streams a ZIP response to a selected file without creating a Blob", async () => {
    const written = [];
    const writable = {
      write: vi.fn(async (chunk) => written.push(new Uint8Array(chunk))),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const fileHandle = { createWritable: vi.fn(async () => writable) };
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const response = new Response(bytes, {
      headers: { "Content-Length": String(bytes.byteLength) },
    });

    await expect(writeResponseToFile(response, fileHandle)).resolves.toBe(bytes.byteLength);
    expect(fileHandle.createWritable).toHaveBeenCalledTimes(1);
    expect(written.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(bytes.byteLength);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it("aborts a direct file save when the ZIP response is truncated", async () => {
    const writable = {
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Length": "5" },
    });

    await expect(writeResponseToFile(response, {
      createWritable: vi.fn(async () => writable),
    })).rejects.toThrow("最後まで受信");
    expect(writable.close).not.toHaveBeenCalled();
    expect(writable.abort).toHaveBeenCalledTimes(1);
  });

  it("labels a file-system write failure so the participant can choose another target", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Length": "3" },
    });
    const writable = {
      write: vi.fn().mockRejectedValue(new DOMException("disk full", "QuotaExceededError")),
      close: vi.fn(),
      abort: vi.fn(async () => {}),
    };

    await expect(writeResponseToFile(response, {
      createWritable: vi.fn(async () => writable),
    })).rejects.toMatchObject({ code: "participant_copy_file_write_failed" });
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });

  it("retries participant ZIP preparation without changing visit completion", async () => {
    const state = stateWith();
    const fetchParticipantCopy = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary copy failure"))
      .mockResolvedValue({ blob: new Blob(["zip"]), filename: "accentedness_results.zip" });
    const { runner, ui } = runnerFor(state, { fetchParticipantCopy });
    const fileHandle = { createWritable: vi.fn() };

    await expect(runner.prepareParticipantCopyWithRetry(fileHandle)).resolves.toMatchObject({
      filename: "accentedness_results.zip",
    });
    expect(fetchParticipantCopy).toHaveBeenCalledTimes(2);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(1, fileHandle);
    expect(fetchParticipantCopy).toHaveBeenNthCalledWith(2, fileHandle);
    expect(ui.prompt).toHaveBeenCalledWith(
      expect.stringContaining("研究用サーバーへの保存は完了しています"),
      "ZIPを再準備する",
    );
  });

  it("stops ZIP retries with accurate guidance after the completed session expires", async () => {
    const state = stateWith();
    const fetchParticipantCopy = vi.fn().mockRejectedValue(
      new ApiClientError(401, "session_expired", "The session expired"),
    );
    const { runner, ui } = runnerFor(state, { fetchParticipantCopy });

    await expect(runner.prepareParticipantCopyWithRetry()).rejects.toMatchObject({
      code: "participant_copy_session_expired",
      status: 401,
    });
    expect(fetchParticipantCopy).toHaveBeenCalledTimes(1);
    expect(ui.prompt).not.toHaveBeenCalled();
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
