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
  waitForStartOrParticipantExit,
} from "../public/js/flow-guards.js";
import {
  fullyAcknowledgedAttemptIds,
  isQueuedTrialFullyAcknowledged,
} from "../public/js/outbox.js";
import {
  ExperimentRunner,
  isNonRetryableLocalRecordingError,
  isTerminalInterruptionDrainError,
} from "../public/js/runner.js";
import {
  countdownState,
  fatalErrorMessage,
  PARTICIPANT_COPY_DELIVERY,
  participantCopyCompletionMessage,
  participantErrorMessage,
  progressState,
} from "../public/js/ui.js";

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
  it("derives countdown text from an absolute deadline without extending after a stalled frame", () => {
    expect(countdownState(20_000, 10_000, 10_000)).toMatchObject({
      remainingSeconds: 10,
      fraction: 1,
    });
    expect(countdownState(20_000, 10_000, 10_001).remainingSeconds).toBe(10);
    expect(countdownState(20_000, 10_000, 11_000).remainingSeconds).toBe(9);
    expect(countdownState(20_000, 10_000, 19_999).remainingSeconds).toBe(1);
    expect(countdownState(20_000, 10_000, 20_000)).toMatchObject({
      remainingSeconds: 0,
      fraction: 0,
    });
    expect(countdownState(20_000, 10_000, 16_000).remainingSeconds).toBe(4);
    expect(countdownState(20_000, 10_000, 21_000).remainingMs).toBe(0);
  });

  it("separates the current trial position from durably completed progress", () => {
    expect(progressState("Picture Naming 練習", 0, 2, { inProgress: true })).toMatchObject({
      completed: 0,
      position: 1,
      total: 2,
      percent: 50,
      labelText: "Picture Naming 練習　試行 1/2",
    });
    expect(progressState("Picture Naming 練習", 1, 2, { inProgress: true })).toMatchObject({
      completed: 1,
      position: 2,
      labelText: "Picture Naming 練習　試行 2/2",
    });
    expect(progressState("Picture Naming 本番", 0, 24, { inProgress: true })).toMatchObject({
      completed: 0,
      position: 1,
      total: 24,
    });
    expect(progressState("語彙学習", 24, 144, { inProgress: true })).toMatchObject({
      completed: 24,
      position: 25,
      total: 144,
    });
    expect(progressState("L2-to-L1 本番", 24, 24)).toMatchObject({
      completed: 24,
      position: 24,
      percent: 100,
      labelText: "L2-to-L1 本番　24/24 完了",
    });
  });

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
    expect(shouldClearInvitationFragment(
      new ApiClientError(409, "participant_binding_mismatch", "retry identity"),
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
    expect(participantErrorMessage({
      code: "invalid_response_payload",
      message: "invalid response",
    })).not.toContain("閉じない");
    const missingRecording = participantErrorMessage({
      code: "local_recording_missing",
      message: "recording missing",
    });
    expect(missingRecording).toContain("完了しておらず");
    expect(missingRecording).toContain("参加終了を選ばず停止");
    expect(missingRecording).toContain("担当者");
  });

  it("does not imply completion or server receipt when a trial fails after interruption was requested", () => {
    const message = fatalErrorMessage(
      { code: "invalid_response_payload", message: "invalid response" },
      { interruptionRequested: true },
    );

    expect(message).toContain("通常完了、一時中断、参加終了のいずれも確認できていません");
    expect(message).toContain("どこまで受け付けたかも確認できていません");
    expect(message).toContain("同じ有効な招待リンクを開き直し");
    expect(message).toContain("参加者IDと氏名を再入力");
    expect(message).toContain("新しい試行を始める前に「中断・終了」");
    expect(message).toContain("担当者へ連絡");
    expect(message).not.toContain("保存は完了");
    expect(message).not.toContain("サーバー受付済み");
    expect(fatalErrorMessage(
      { code: "participant_copy_session_expired", message: "The session expired" },
      { interruptionRequested: true },
    )).not.toContain("研究用サーバーに保存済み");
    expect(fatalErrorMessage(
      { code: "invalid_response_payload", message: "invalid response" },
    )).not.toContain("同じ有効な招待リンク");
  });

  it("returns to the welcome screen after cancelling an interruption without auto-starting", async () => {
    const ui = {
      waitForStart: vi.fn()
        .mockResolvedValueOnce("interrupt")
        .mockResolvedValueOnce("start"),
      beginTask: vi.fn(),
      returnToWelcome: vi.fn(),
    };
    const runner = { handleParticipantExit: vi.fn().mockResolvedValue(false) };

    await expect(waitForStartOrParticipantExit(ui, runner)).resolves.toBeUndefined();
    expect(ui.waitForStart).toHaveBeenCalledTimes(2);
    expect(ui.beginTask).toHaveBeenCalledTimes(1);
    expect(runner.handleParticipantExit).toHaveBeenCalledTimes(1);
    expect(ui.returnToWelcome).toHaveBeenCalledTimes(1);
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

  it("claims local ZIP completion only after a confirmed direct file write", () => {
    const direct = participantCopyCompletionMessage(
      PARTICIPANT_COPY_DELIVERY.DIRECT_WRITE_CONFIRMED,
    );
    expect(direct).toContain("研究用サーバー保存が完了");
    expect(direct).toContain("選択した保存先へのZIP書き込みも完了");
    expect(direct).not.toContain("ダウンロードを開始しました");

    const fallback = participantCopyCompletionMessage(
      PARTICIPANT_COPY_DELIVERY.DOWNLOAD_STARTED,
      { alreadyCompleted: true, filename: "accentedness_results.zip" },
    );
    expect(fallback).toContain("研究用サーバーに保存済み");
    expect(fallback).toContain("ZIPのダウンロードを開始しました");
    expect(fallback).toContain("Chromeのダウンロード一覧");
    expect(fallback).toContain("accentedness_results.zip");
    expect(fallback).not.toContain("ZIP書き込みも完了");
  });

  it("refuses to render participant ZIP completion for an unknown delivery state", () => {
    expect(() => participantCopyCompletionMessage("unknown"))
      .toThrow("受け渡し状態を確認できません");
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

  it("offers canonical partial-data termination when a missing accepted WAV makes resume unsafe", async () => {
    const state = stateWith({
      manifest: [{ trial_id: "trial-recorded", expects_recording: true }],
      accepted: [{
        trial_id: "trial-recorded",
        attempt_id: "attempt-recorded",
        recording_state: "pending",
      }],
    });
    const recordingError = Object.assign(new Error("recording missing"), {
      code: "local_recording_missing",
    });
    const interruptionId = "77777777-7777-4777-8777-777777777777";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui } = runnerFor(state, {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseTerminationAfterUnsafeResume: vi.fn().mockResolvedValue(true),
      chooseInterruptionMode: vi.fn(),
      setInterruptionPending: vi.fn(),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);
    runner.unrecoverableAcceptedRecordingError = vi.fn().mockResolvedValue(recordingError);

    await expect(runner.reconcileOutbox()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(ui.chooseTerminationAfterUnsafeResume)
      .toHaveBeenCalledWith(recordingError);
    expect(ui.chooseInterruptionMode).not.toHaveBeenCalled();
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(
      interruptionId,
      requestId,
    );
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
    expect(clearSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["corrupt Blob", () => Object.assign(new Error("invalid local WAV"), {
      code: "client_recording_preflight_failed",
    })],
    ["unreadable IndexedDB", () => new DOMException("record unreadable", "DataError")],
  ])("offers the same termination-only recovery when outbox flush fails on %s", async (_, errorFactory) => {
    const interruptionId = "88888888-8888-4888-8888-888888888888";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui, api } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    const recordingError = errorFactory();
    Object.assign(ui, {
      chooseTerminationAfterUnsafeResume: vi.fn().mockResolvedValue(true),
      chooseInterruptionMode: vi.fn(),
      setInterruptionPending: vi.fn(),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.flushWithRetry = vi.fn().mockRejectedValue(recordingError);

    await expect(runner.reconcileOutbox()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(ui.chooseTerminationAfterUnsafeResume)
      .toHaveBeenCalledWith(recordingError);
    expect(ui.chooseInterruptionMode).not.toHaveBeenCalled();
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledTimes(1);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(api.state).not.toHaveBeenCalled();
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

  it("warns on unload only while the running task has unsaved work", () => {
    const { runner } = runnerFor(stateWith());
    runner.running = true;
    const cleanEvent = { preventDefault: vi.fn(), returnValue: null };

    runner.onBeforeUnload(cleanEvent);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

    runner.trialInFlight = true;
    const trialEvent = { preventDefault: vi.fn(), returnValue: null };
    runner.onBeforeUnload(trialEvent);
    expect(trialEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(trialEvent.returnValue).toBe("");

    runner.trialInFlight = false;
    runner.backgroundUploadFailed = true;
    const queuedEvent = { preventDefault: vi.fn(), returnValue: null };
    runner.onBeforeUnload(queuedEvent);
    expect(queuedEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("classifies non-retryable missing or corrupt recordings without treating network failures as local corruption", () => {
    for (const code of [
      "client_recording_preflight_failed",
      "local_recording_missing",
      "local_recording_unreadable",
      "invalid_wav",
      "recording_checksum_mismatch",
      "recording_payload_mismatch",
    ]) {
      expect(isNonRetryableLocalRecordingError({ code })).toBe(true);
    }
    expect(isNonRetryableLocalRecordingError(
      new DOMException("IndexedDB record is unreadable", "DataError"),
    )).toBe(true);
    expect(isNonRetryableLocalRecordingError(new TypeError("offline"))).toBe(false);
    expect(isNonRetryableLocalRecordingError({ code: "invalid_response_payload" })).toBe(false);
  });

  it("allows terminal response or recording 4xx errors to end participation but not auth or retryable failures", () => {
    for (const error of [
      { status: 409, code: "recording_object_conflict" },
      { status: 409, code: "idempotency_conflict" },
      { status: 422, code: "invalid_response_payload" },
      { status: 422, code: "recording_payload_mismatch" },
    ]) {
      expect(isTerminalInterruptionDrainError(error)).toBe(true);
    }
    for (const error of [
      { status: 401, code: "session_expired" },
      { status: 401, code: "authorization_required" },
      { status: 409, code: "session_superseded" },
      { status: 409, code: "visit_closed" },
      { status: 429, code: "temporarily_unavailable" },
      { status: 503, code: "temporarily_unavailable" },
      new TypeError("offline"),
    ]) {
      expect(isTerminalInterruptionDrainError(error)).toBe(false);
    }
  });

  it("canonically terminates with an explicit partial-data warning when a local recording cannot drain", async () => {
    const interruptionId = "22222222-2222-4222-8222-222222222222";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui, api } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("terminate"),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("recording missing"), { code: "local_recording_missing" }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(requestParticipationInterruption).toHaveBeenCalledWith(
      "terminate",
      expect.any(String),
    );
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(interruptionId, requestId);
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
    expect(api.completeVisit).not.toHaveBeenCalled();
  });

  it("does not finalize a pause when a local recording is missing", async () => {
    const interruptionId = "44444444-4444-4444-8444-444444444444";
    const finalizeParticipationInterruption = vi.fn();
    const clearSession = vi.fn();
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("pause"),
      chooseTerminationAfterUnsafePause: vi.fn().mockResolvedValue(false),
      showInterruptionWorking: vi.fn(),
      interruptionUnconfirmed: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("recording missing"), { code: "local_recording_missing" }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "pause",
      confirmed: false,
    });
    expect(finalizeParticipationInterruption).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.interruptionUnconfirmed).toHaveBeenCalledWith("pause", requestId);
  });

  it("changes an unsafe pause request to termination with the same durable request ID", async () => {
    const interruptionId = "55555555-5555-4555-8555-555555555555";
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      escalated: mode === "terminate",
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const finalizeParticipationInterruption = vi.fn().mockResolvedValue({
      interruption: { state: "terminated" },
    });
    const clearSession = vi.fn();
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("pause"),
      chooseTerminationAfterUnsafePause: vi.fn().mockResolvedValue(true),
      showInterruptionWorking: vi.fn(),
      confirmTerminationWithPartialData: vi.fn().mockResolvedValue(undefined),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockRejectedValue(
      Object.assign(new Error("response cannot be accepted"), {
        status: 422,
        code: "invalid_response_payload",
      }),
    );

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: true,
    });
    expect(requestParticipationInterruption).toHaveBeenCalledTimes(2);
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(requestParticipationInterruption.mock.calls).toEqual([
      ["pause", requestId],
      ["terminate", requestId],
    ]);
    expect(ui.chooseTerminationAfterUnsafePause).toHaveBeenCalledTimes(1);
    expect(ui.confirmTerminationWithPartialData).toHaveBeenCalledTimes(1);
    expect(finalizeParticipationInterruption).toHaveBeenCalledWith(
      interruptionId,
      requestId,
    );
    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(ui.interrupted).toHaveBeenCalledWith("terminate", { partialData: true });
  });

  it("lets a participant stop retrying a transient finalize failure without claiming termination", async () => {
    const interruptionId = "66666666-6666-4666-8666-666666666666";
    const finalizeParticipationInterruption = vi.fn().mockRejectedValue(
      new TypeError("offline"),
    );
    const clearSession = vi.fn();
    const requestParticipationInterruption = vi.fn(async (mode, requestId) => ({
      interruption: {
        interruption_id: interruptionId,
        request_id: requestId,
        mode,
        state: "requested",
      },
    }));
    const { runner, ui } = runnerFor(stateWith(), {
      requestParticipationInterruption,
      finalizeParticipationInterruption,
      clearSession,
    });
    Object.assign(ui, {
      chooseInterruptionMode: vi.fn().mockResolvedValue("terminate"),
      showInterruptionWorking: vi.fn(),
      retryInterruptionOrShowCloseGuidance: vi.fn().mockResolvedValue(false),
      interruptionUnconfirmed: vi.fn(),
      interrupted: vi.fn(),
    });
    runner.stopMonitoring = vi.fn();
    runner.participantExitRequested = true;
    runner.flushWithRetry = vi.fn().mockResolvedValue(undefined);

    await expect(runner.handleParticipantExit()).rejects.toMatchObject({
      name: "ParticipantExitRequested",
      mode: "terminate",
      confirmed: false,
    });
    expect(finalizeParticipationInterruption).toHaveBeenCalledTimes(1);
    expect(ui.retryInterruptionOrShowCloseGuidance).toHaveBeenCalledTimes(1);
    const requestId = requestParticipationInterruption.mock.calls[0][1];
    expect(ui.interruptionUnconfirmed).toHaveBeenCalledWith("terminate", requestId);
    expect(ui.interrupted).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });
});
