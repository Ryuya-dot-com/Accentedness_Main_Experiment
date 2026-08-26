import {
  acknowledgeTrialResponse,
  clearTrialStart,
  flushOutbox,
  getOrCreateTrialStart,
  hasQueuedRecording,
  markTrialStimulusShown,
  queueTrial,
  uploadQueuedRecording,
} from "./outbox.js";
import { delay } from "./ui.js";

function revealOnAnimationFrame(reveal, audio) {
  return new Promise((resolve) => requestAnimationFrame(() => {
    const visualMode = reveal();
    resolve({ visualMode, ...audio.clockSnapshot() });
  }));
}

async function delayUntilPerformance(deadlinePerfMs) {
  while (performance.now() < deadlinePerfMs) {
    await delay(Math.max(0, deadlinePerfMs - performance.now()));
  }
}

function publicRecordingFields(recording) {
  return {
    sample_rate_hz: recording.sample_rate_hz,
    sample_count: recording.sample_count,
    duration_seconds: recording.duration_seconds,
    capture_start_context_s: recording.start_context_s,
    capture_stop_context_s: recording.stop_context_s,
    capture_stop_command_perf_ms: recording.command_stop_perf_ms,
    capture_stopped_perf_ms: recording.stopped_perf_ms,
    scheduled_stop_context_s: recording.scheduled_stop_context_s,
    expected_sample_count: recording.expected_sample_count,
    sample_count_difference: recording.sample_count_difference,
    missing_input_frames: recording.missing_input_frames,
    quality: recording.quality,
    microphone_settings: recording.microphone_settings,
  };
}

export function isNonRetryableLocalRecordingError(error) {
  const code = String(error?.code ?? "");
  const knownCode = new Set([
    "client_recording_preflight_failed",
    "invalid_recording_type",
    "invalid_wav",
    "invalid_wav_duration",
    "invalid_wav_format",
    "local_recording_missing",
    "local_recording_unreadable",
    "recording_checksum_mismatch",
    "recording_length_mismatch",
    "recording_payload_mismatch",
    "recording_quality_mismatch",
  ]).has(code);
  const localDomFailure = typeof DOMException !== "undefined"
    && error instanceof DOMException
    && new Set([
      "ConstraintError",
      "DataError",
      "InvalidStateError",
      "NotFoundError",
      "QuotaExceededError",
      "ReadOnlyError",
      "TransactionInactiveError",
      "UnknownError",
      "VersionError",
    ]).has(error.name);
  return knownCode || localDomFailure;
}

export function isTerminalInterruptionDrainError(error) {
  if (isNonRetryableLocalRecordingError(error)) return true;
  const code = String(error?.code ?? "");
  if (new Set([
    "invalid_session",
    "session_expired",
    "session_superseded",
    "visit_closed",
    "participant_withdrawn",
    "production_collection_blocked",
  ]).has(code)) return false;
  const status = Number(error?.status);
  if (status === 401) return false;
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![408, 425, 429].includes(status);
}

export class ParticipantExitRequested extends Error {
  constructor(mode, { confirmed = true } = {}) {
    super(confirmed
      ? (mode === "pause" ? "Participant paused the session" : "Participant ended participation")
      : "Participant left interruption confirmation pending");
    this.name = "ParticipantExitRequested";
    this.mode = mode;
    this.confirmed = confirmed;
  }
}

export class ExperimentRunner {
  constructor(api, ui, audio, state) {
    this.api = api;
    this.ui = ui;
    this.audio = audio;
    this.state = state;
    this.running = false;
    this.activeTrial = null;
    this.trialInFlight = false;
    const openInterruption = state.participation_control?.interruption;
    this.pendingInterruption = openInterruption?.state === "requested"
      ? openInterruption
      : null;
    this.participantExitRequested = Boolean(this.pendingInterruption);
    this.interruptionFlowActive = false;
    this.visibilityInterrupted = false;
    this.heartbeatTimer = null;
    this.nextOnsetNotBeforePerfMs = null;
    this.backgroundUploads = new Set();
    this.backgroundUploadFailed = false;
    this.backgroundUploadError = null;
    this.backgroundUploadTail = Promise.resolve();
    this.outboxFlushActive = false;
    this.preloadedTrials = new Map();
    this.onVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      if (hidden && this.activeTrial) this.visibilityInterrupted = true;
      this.sendEvent("visibility_changed", { hidden }).catch(() => {});
    };
    this.onBeforeUnload = (event) => {
      if (!this.running || !this.hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    this.ui.bindInterruptionControl?.(() => {
      if (this.interruptionFlowActive || this.participantExitRequested) return;
      this.participantExitRequested = true;
      this.ui.setInterruptionPending?.(this.trialInFlight);
      if (!this.trialInFlight) this.ui.releaseActivePromptForInterruption?.();
    });
    if (this.pendingInterruption) this.ui.setInterruptionPending?.(false);
  }

  startMonitoring() {
    this.running = true;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("beforeunload", this.onBeforeUnload);
    this.heartbeatTimer = window.setInterval(() => {
      this.api.heartbeat().catch((error) => {
        if (error.code === "session_superseded") {
          this.stopMonitoring();
          this.audio.close();
          this.ui.fatal(error, {
            interruptionRequested: this.participantExitRequested,
          });
        }
      });
    }, 15_000);
  }

  stopMonitoring() {
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  hasUnsavedWork() {
    return this.trialInFlight
      || this.outboxFlushActive
      || this.backgroundUploads.size > 0
      || this.backgroundUploadFailed
      || this.interruptionFlowActive;
  }

  leaveInterruptionUnconfirmed(mode, requestId) {
    this.stopMonitoring();
    this.ui.interruptionUnconfirmed(mode, requestId);
    throw new ParticipantExitRequested(mode, { confirmed: false });
  }

  async retryInterruptionStep(mode, requestId, operation) {
    while (true) {
      try {
        return await operation();
      } catch {
        const retry = await this.ui.retryInterruptionOrShowCloseGuidance(
          mode === "pause"
            ? "一時中断をまだ確定できていません。ネットワーク接続を確認して、再試行してください。"
            : "参加終了をまだ確定できていません。ネットワーク接続を確認して、再試行してください。",
          "再試行",
        );
        if (!retry) this.leaveInterruptionUnconfirmed(mode, requestId);
        this.ui.showInterruptionWorking?.(mode);
      }
    }
  }

  async handleParticipantExit(preselectedMode = null) {
    if (!this.participantExitRequested || this.trialInFlight) return false;
    let mode = preselectedMode ?? this.pendingInterruption?.mode ?? null;
    if (!mode) {
      mode = await this.ui.chooseInterruptionMode();
      if (!mode) {
        this.participantExitRequested = false;
        this.ui.clearInterruptionPending?.();
        this.resetInterTrialClock();
        return false;
      }
    }

    this.interruptionFlowActive = true;
    this.ui.showInterruptionWorking?.(mode);
    const requestId = this.pendingInterruption?.request_id ?? crypto.randomUUID();
    let interruption = this.pendingInterruption ?? (await this.retryInterruptionStep(
      mode,
      requestId,
      async () => {
        const requested = await this.api.requestParticipationInterruption(mode, requestId);
        const candidate = requested?.interruption;
        if (!candidate?.interruption_id
            || candidate.request_id !== requestId
            || candidate.mode !== mode) {
          throw new Error("Interruption request acknowledgement did not match");
        }
        return candidate;
      },
    ));
    if (!interruption?.interruption_id
        || interruption.request_id !== requestId
        || interruption.mode !== mode) {
      throw new Error("中断・終了リクエストの確認情報が一致しません。担当者に知らせてください。");
    }
    this.pendingInterruption = interruption;

    let partialData = false;
    let terminalDrainError = null;
    try {
      await this.flushWithRetry({ interruptionMode: mode, requestId });
    } catch (error) {
      if (!isTerminalInterruptionDrainError(error)) throw error;
      terminalDrainError = error;
    }
    if (!terminalDrainError) {
      this.state = await this.retryInterruptionStep(
        mode,
        requestId,
        () => this.api.state(),
      );
      terminalDrainError = await this.unrecoverableAcceptedRecordingError();
    }
    if (terminalDrainError) {
      if (mode !== "terminate") {
        const escalate = await this.ui.chooseTerminationAfterUnsafePause();
        if (!escalate) this.leaveInterruptionUnconfirmed(mode, requestId);
        const escalated = await this.retryInterruptionStep(
          "terminate",
          requestId,
          () => this.api.requestParticipationInterruption("terminate", requestId),
        );
        const candidate = escalated?.interruption;
        if (!candidate?.interruption_id
            || candidate.interruption_id !== interruption.interruption_id
            || candidate.request_id !== requestId
            || candidate.mode !== "terminate"
            || candidate.state !== "requested") {
          throw new Error("参加終了への切替確認情報が一致しません。担当者に知らせてください。");
        }
        mode = "terminate";
        interruption = candidate;
        this.pendingInterruption = candidate;
      }
      partialData = true;
      const confirmed = await this.ui.confirmTerminationWithPartialData();
      if (confirmed === false) this.leaveInterruptionUnconfirmed(mode, requestId);
    }
    this.ui.showInterruptionWorking?.(mode);
    const finalized = await this.retryInterruptionStep(
      mode,
      requestId,
      async () => {
        const result = await this.api.finalizeParticipationInterruption(
          interruption.interruption_id,
          requestId,
        );
        const expectedState = mode === "pause" ? "paused" : "terminated";
        if (result?.interruption?.state !== expectedState) {
          throw new Error("Interruption finalization acknowledgement did not match");
        }
        return result;
      },
    );
    const expectedState = mode === "pause" ? "paused" : "terminated";
    if (finalized?.interruption?.state !== expectedState) {
      throw new Error("中断・終了の確定状態を確認できません。担当者に知らせてください。");
    }

    this.stopMonitoring();
    if (mode === "terminate") this.api.clearSession();
    this.ui.interrupted(mode, { partialData });
    throw new ParticipantExitRequested(mode);
  }

  sendEvent(type, payload = {}, trial = this.activeTrial, attemptId = null) {
    return this.api.events([{
      event_id: crypto.randomUUID(),
      type,
      trial_id: trial?.trial_id ?? null,
      attempt_id: attemptId,
      client_event_at_ms: performance.now(),
      payload,
    }]);
  }

  async unrecoverableAcceptedRecordingError(
    hasQueuedRecordingForAttempt = hasQueuedRecording,
  ) {
    const manifestByTrialId = new Map(
      this.state.manifest.map((trial) => [trial.trial_id, trial]),
    );
    const pendingRecordings = this.state.accepted.filter((accepted) => (
      manifestByTrialId.get(accepted.trial_id)?.expects_recording
        && accepted.recording_state !== "uploaded"
    ));
    for (const accepted of pendingRecordings) {
      let recoverable;
      try {
        recoverable = await hasQueuedRecordingForAttempt(
          this.state.visit.visit_id,
          accepted.attempt_id,
        );
      } catch (cause) {
        const unreadable = new Error(
          "送信前の録音をこのブラウザから読み出せません。担当者に知らせてください。",
        );
        unreadable.code = "local_recording_unreadable";
        unreadable.cause = cause;
        unreadable.details = {
          trial_id: accepted.trial_id,
          attempt_id: accepted.attempt_id,
          recording_state: accepted.recording_state,
        };
        return unreadable;
      }
      if (!recoverable) {
        const missing = new Error(
          "送信前の録音がこのブラウザに残っていません。これ以上進めず、担当者に知らせてください。",
        );
        missing.code = "local_recording_missing";
        missing.details = {
          trial_id: accepted.trial_id,
          attempt_id: accepted.attempt_id,
          recording_state: accepted.recording_state,
        };
        return missing;
      }
    }
    return null;
  }

  async resolveUnsafeDataForResume(dataError) {
    const terminate = await this.ui.chooseTerminationAfterUnsafeResume?.(
      dataError,
    );
    if (!terminate) throw dataError;
    this.participantExitRequested = true;
    this.ui.setInterruptionPending?.(false);
    await this.handleParticipantExit("terminate");
  }

  async reconcileOutbox(hasQueuedRecordingForAttempt = hasQueuedRecording) {
    try {
      await this.flushWithRetry();
    } catch (error) {
      if (!isTerminalInterruptionDrainError(error)) throw error;
      await this.resolveUnsafeDataForResume(error);
      return this.state;
    }
    this.state = await this.api.state();
    const recordingError = await this.unrecoverableAcceptedRecordingError(
      hasQueuedRecordingForAttempt,
    );
    if (recordingError) {
      await this.resolveUnsafeDataForResume(recordingError);
    }
    return this.state;
  }

  async flushWithRetry({ interruptionMode = null, requestId = null } = {}) {
    this.outboxFlushActive = true;
    try {
      if (this.backgroundUploads.size) await Promise.allSettled([...this.backgroundUploads]);
      while (true) {
        if (this.participantExitRequested
            && !this.interruptionFlowActive
            && !this.trialInFlight) {
          await this.handleParticipantExit();
        }
        try {
          await flushOutbox(
            this.api,
            this.state.visit.visit_id,
            ({ state }) => this.ui.setSaveState(state),
          );
          this.backgroundUploadFailed = false;
          this.backgroundUploadError = null;
          this.ui.setSaveState("saved");
          return;
        } catch (error) {
          this.ui.setSaveState("queued");
          if (["session_superseded", "visit_closed"].includes(error.code)) throw error;
          const retryableStatus = [408, 425, 429].includes(Number(error.status))
            || Number(error.status) >= 500;
          if (!(error instanceof TypeError) && !retryableStatus) throw error;
          if (interruptionMode) {
            const retry = await this.ui.retryInterruptionOrShowCloseGuidance(
              "一部のデータをまだ保存できていません。ネットワーク接続を確認してください。",
              "保存を再試行",
            );
            if (!retry) this.leaveInterruptionUnconfirmed(interruptionMode, requestId);
            this.ui.showInterruptionWorking?.(interruptionMode);
          } else {
            await this.ui.prompt(
              "データをまだ保存できていません。ネットワーク接続を確認してから再送してください。",
              "再送する",
            );
          }
        }
      }
    } finally {
      this.outboxFlushActive = false;
    }
  }

  async acknowledgeTrialResponseWithRetry(
    attemptId,
    acknowledge = acknowledgeTrialResponse,
  ) {
    while (true) {
      try {
        return await acknowledge(this.api, attemptId);
      } catch (error) {
        this.ui.setSaveState("queued");
        if (["session_superseded", "visit_closed"].includes(error.code)) throw error;
        const retryableStatus = [408, 425, 429].includes(Number(error.status))
          || Number(error.status) >= 500;
        if (!(error instanceof TypeError) && !retryableStatus) throw error;
        await this.ui.prompt(
          "この回の回答をまだ保存できていません。ネットワーク接続を確認してから再送してください。",
          "回答を再送する",
        );
      }
    }
  }

  async completeVisitWithRetry() {
    while (true) {
      try {
        return await this.api.completeVisit();
      } catch (error) {
        const retryableStatus = [408, 425, 429].includes(Number(error.status))
          || Number(error.status) >= 500;
        if (!(error instanceof TypeError) && !retryableStatus) throw error;
        await this.ui.prompt(
          "課題の完了をまだ保存できていません。ネットワーク接続を確認してから再送してください。",
          "完了確認を再送する",
        );
      }
    }
  }

  async prepareParticipantCopyWithRetry(fileHandle = null) {
    while (true) {
      try {
        this.ui.setSaveState("saving");
        const archive = await this.api.fetchParticipantCopy(fileHandle);
        this.ui.setSaveState("saved");
        return archive;
      } catch (error) {
        this.ui.setSaveState("queued");
        if (error?.code === "session_expired") {
          const expired = new Error(
            "The completed-session credential expired; request a participant copy from the researcher",
          );
          expired.code = "participant_copy_session_expired";
          expired.status = 401;
          throw expired;
        }
        if (error?.code === "participant_copy_file_write_failed") throw error;
        if (["session_superseded", "visit_closed"].includes(error.code)) throw error;
        const retryableStatus = [408, 425, 429].includes(Number(error.status))
          || Number(error.status) >= 500;
        if (!(error instanceof TypeError) && !retryableStatus) throw error;
        await this.ui.prompt(
          "実験データは保存されていますが、このパソコン向けZIPをまだ準備できません。ネットワーク接続を確認してください。",
          "ZIPを再準備する",
        );
      }
    }
  }

  resetInterTrialClock() {
    this.nextOnsetNotBeforePerfMs = null;
  }

  scheduleNextOnset(trialEndPerfMs, interTrialMs) {
    this.nextOnsetNotBeforePerfMs = trialEndPerfMs + interTrialMs;
  }

  async prepareOnset(initialFixationMs, commitLeadMs = 40) {
    const targetPerfMs = this.nextOnsetNotBeforePerfMs ?? performance.now() + initialFixationMs;
    await delayUntilPerformance(Math.max(performance.now(), targetPerfMs - commitLeadMs));
    return targetPerfMs;
  }

  requireVisibleBeforeOnset() {
    if (document.visibilityState !== "visible") {
      throw new Error("刺激提示前に画面が非表示になりました。画面を戻して担当者に知らせてください。");
    }
  }

  reportOnsetLateness(targetPerfMs, actualPerfMs, trial, attemptId) {
    const lateMs = Math.max(0, actualPerfMs - targetPerfMs);
    if (lateMs > 4) {
      void this.sendEvent("trial_onset_late", {
        target_onset_perf_ms: targetPerfMs,
        actual_onset_perf_ms: actualPerfMs,
        onset_late_ms: lateMs,
      }, trial, attemptId).catch(() => {});
    }
    return lateMs;
  }

  stopIfVisibilityInterrupted(interrupted) {
    if (interrupted) {
      throw new Error("絵や音声が出ている間に画面が非表示になりました。この回は記録済みです。続行せず担当者に知らせてください。");
    }
  }

  startBackgroundRecordingUpload(attemptId) {
    const queuedUpload = this.backgroundUploadTail.then(async () => {
      // Give the next response/stimulus request priority over the bulk WAV upload.
      await delay(1_000);
      return uploadQueuedRecording(this.api, attemptId);
    });
    let uploadPromise;
    uploadPromise = queuedUpload
      .catch((error) => {
        this.backgroundUploadFailed = true;
        this.backgroundUploadError = error;
        this.ui.setSaveState("queued");
      })
      .finally(() => {
        this.backgroundUploads.delete(uploadPromise);
        if (this.backgroundUploads.size === 0) {
          this.ui.setSaveState(this.backgroundUploadFailed ? "queued" : "saved");
        }
      });
    this.backgroundUploadTail = uploadPromise;
    this.backgroundUploads.add(uploadPromise);
  }

  acceptedTrialIds() {
    return new Set(this.state.accepted.map((entry) => entry.trial_id));
  }

  async preloadTrial(trial) {
    if (this.backgroundUploadError || this.backgroundUploads.size >= 3) {
      await this.flushWithRetry();
    }
    const cached = this.preloadedTrials.get(trial.trial_id);
    if (cached) {
      this.preloadedTrials.delete(trial.trial_id);
      try {
        return await cached;
      } catch {
        return this.loadTrialAssets(trial);
      }
    }
    return this.loadTrialAssets(trial);
  }

  async loadTrialAssets(trial) {
    const loaded = { cueBuffer: null, imageUrl: null };
    if (trial.has_audio) loaded.cueBuffer = await this.audio.loadCue(trial.audio_endpoint);
    if (trial.has_image) {
      const imageBlob = await this.api.fetchStimulus(trial.image_endpoint);
      const imageUrl = URL.createObjectURL(imageBlob);
      const image = new Image();
      image.src = imageUrl;
      try {
        await image.decode();
      } catch {
        URL.revokeObjectURL(imageUrl);
        const imageError = new Error("刺激画像を表示できませんでした。担当者に知らせてください。");
        imageError.code = "stimulus_image_unreadable";
        throw imageError;
      }
      loaded.imageUrl = imageUrl;
    }
    return loaded;
  }

  primeNextTrial(trial) {
    if (!trial || this.preloadedTrials.has(trial.trial_id)) return;
    const promise = new Promise((resolve) => window.setTimeout(resolve, 1_000))
      .then(() => this.loadTrialAssets(trial));
    this.preloadedTrials.set(trial.trial_id, promise);
    promise.catch(() => {
      if (this.preloadedTrials.get(trial.trial_id) === promise) {
        this.preloadedTrials.delete(trial.trial_id);
      }
    });
  }

  async authorizeTrial(trial) {
    const durableStart = await getOrCreateTrialStart(this.state.visit.visit_id, trial.trial_id);
    return this.api.startTrial(
      trial.trial_id,
      durableStart.startKey,
      durableStart.clientStartedPerfMs,
      Boolean(durableStart.stimulusShown),
    );
  }

  async persistTrial(trial, authorization, payload, recordingBlob = null) {
    const responseKey = crypto.randomUUID();
    payload.client_response_saved_perf_ms = performance.now();
    await queueTrial({
      visitId: this.state.visit.visit_id,
      trialId: trial.trial_id,
      attemptId: authorization.attempt_id,
      responseKey,
      payload,
      expectsRecording: trial.expects_recording,
      recordingBlob,
    });
    this.ui.setSaveState("queued");
    await this.acknowledgeTrialResponseWithRetry(authorization.attempt_id);
    await clearTrialStart(trial.trial_id);
    if (trial.expects_recording) {
      this.startBackgroundRecordingUpload(authorization.attempt_id);
    } else {
      this.ui.setSaveState("saved");
    }
  }

  async runLearningTrial(trial, loaded, nextTrial = null) {
    this.trialInFlight = true;
    if (!loaded.cueBuffer) throw new Error("学習音声を読み込めませんでした。");
    const protocol = trial.protocol.timing;
    this.ui.showFixation();
    this.ui.setTaskStatus(trial.practice
      ? "中央の＋を見て、次の絵文字と英単語に備えてください。"
      : "中央の＋を見て、次の絵と英単語に備えてください。");
    if (loaded.cueBuffer.duration * 1000 + protocol.audioOnsetMs > protocol.visualDurationMs) {
      throw new Error("学習音声が5秒の提示窓に収まりません。刺激担当者へ連絡してください。");
    }
    const authorization = await this.authorizeTrial(trial);
    this.primeNextTrial(nextTrial);
    this.visibilityInterrupted = false;
    const targetOnsetPerfMs = await this.prepareOnset(300);
    this.requireVisibleBeforeOnset();
    this.activeTrial = trial;
    await markTrialStimulusShown(trial.trial_id);
    await delayUntilPerformance(targetOnsetPerfMs);
    const onset = await revealOnAnimationFrame(
      () => this.ui.showVisual(trial, loaded.imageUrl),
      this.audio,
    );
    this.ui.setTaskStatus(trial.practice
      ? "絵文字を見ながら英単語を聞いて覚えてください。自動で次に進みます。"
      : "絵と英単語の組み合わせを覚えてください。自動で次に進みます。");
    const onsetLateMs = this.reportOnsetLateness(
      targetOnsetPerfMs,
      onset.performance_time_ms,
      trial,
      authorization.attempt_id,
    );
    const playback = this.audio.playCue(
      loaded.cueBuffer,
      protocol.audioOnsetMs / 1000,
      onset.context_time_s,
    );
    void this.sendEvent("learning_visual_onset", {
      visual_mode: onset.visualMode,
      visual_onset_perf_ms: onset.performance_time_ms,
      visual_onset_context_s: onset.context_time_s,
      audio_scheduled_context_s: playback.scheduledStartContextS,
    }, trial, authorization.attempt_id).catch(() => {});
    const visualDeadlinePerfMs = onset.performance_time_ms + protocol.visualDurationMs;
    await delayUntilPerformance(visualDeadlinePerfMs);
    this.ui.showFixation();
    const visualHiddenPerfMs = performance.now();
    if (loaded.imageUrl) URL.revokeObjectURL(loaded.imageUrl);
    const playbackEnd = await Promise.race([
      playback.ended,
      delay(1_000).then(() => null),
    ]);
    if (!playbackEnd || this.audio.context?.state !== "running") {
      throw new Error("学習音声の再生完了を確認できませんでした。担当者に知らせてください。");
    }
    this.scheduleNextOnset(
      Math.max(visualDeadlinePerfMs, visualHiddenPerfMs),
      protocol.interTrialMs,
    );
    const payload = {
      task: "learning",
      visual_mode: onset.visualMode,
      visual_onset_perf_ms: onset.performance_time_ms,
      visual_onset_context_s: onset.context_time_s,
      clock_anchor: onset,
      visual_deadline_perf_ms: visualDeadlinePerfMs,
      visual_hidden_perf_ms: visualHiddenPerfMs,
      target_onset_perf_ms: targetOnsetPerfMs,
      onset_late_ms: onsetLateMs,
      audio_scheduled_context_s: playback.scheduledStartContextS,
      audio_scheduled_end_context_s: playback.scheduledEndContextS,
      audio_duration_s: playback.durationS,
      audio_ended_perf_ms: playbackEnd?.endedPerfMs ?? null,
      trial_end_perf_ms: visualHiddenPerfMs,
      visibility_interrupted: this.visibilityInterrupted,
      page_visibility_at_end: document.visibilityState,
    };
    this.activeTrial = null;
    await this.persistTrial(trial, authorization, payload);
    this.trialInFlight = false;
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
  }

  async runPictureNamingTrial(trial, loaded, nextTrial = null) {
    this.trialInFlight = true;
    const protocol = trial.protocol.timing;
    this.ui.showFixation();
    this.ui.setTaskStatus("中央の＋を見て、次の絵に備えてください。");
    const authorization = await this.authorizeTrial(trial);
    this.primeNextTrial(nextTrial);
    this.visibilityInterrupted = false;
    const targetOnsetPerfMs = await this.prepareOnset(350);
    this.requireVisibleBeforeOnset();
    this.activeTrial = trial;
    await markTrialStimulusShown(trial.trial_id);
    const captureStart = await this.audio.startCapture();
    await delayUntilPerformance(targetOnsetPerfMs);
    const onset = await revealOnAnimationFrame(
      () => this.ui.showVisual(trial, loaded.imageUrl),
      this.audio,
    );
    this.ui.setRecording(true);
    const onsetLateMs = this.reportOnsetLateness(
      targetOnsetPerfMs,
      onset.performance_time_ms,
      trial,
      authorization.attempt_id,
    );
    const responseDeadlinePerfMs = onset.performance_time_ms + protocol.responseWindowMs;
    const responseDeadlineContextS = onset.context_time_s + protocol.responseWindowMs / 1000;
    this.ui.setTaskStatus("前置きを付けず、英単語だけを1回話してください。分からなければ無言で待ってください。");
    this.ui.startResponseTimer(responseDeadlinePerfMs, protocol.responseWindowMs);
    const analysisStartSeconds = Math.max(0, onset.context_time_s - captureStart.start_context_s);
    const recordingPromise = this.audio.stopCaptureAt(responseDeadlineContextS, analysisStartSeconds);
    void this.sendEvent("picture_naming_visual_onset", {
      visual_mode: onset.visualMode,
      visual_onset_perf_ms: onset.performance_time_ms,
      visual_onset_context_s: onset.context_time_s,
      capture_start_context_s: captureStart.start_context_s,
    }, trial, authorization.attempt_id).catch(() => {});
    const [visualHiddenPerfMs, recording] = await Promise.all([
      delayUntilPerformance(responseDeadlinePerfMs).then(() => {
        this.ui.showFixation();
        if (loaded.imageUrl) URL.revokeObjectURL(loaded.imageUrl);
        return performance.now();
      }),
      recordingPromise,
    ]);
    this.ui.setRecording(false);
    this.scheduleNextOnset(responseDeadlinePerfMs, protocol.interTrialMs);
    const payload = {
      task: "picture_naming",
      visual_mode: onset.visualMode,
      visual_onset_perf_ms: onset.performance_time_ms,
      visual_onset_context_s: onset.context_time_s,
      clock_anchor: onset,
      response_deadline_perf_ms: responseDeadlinePerfMs,
      response_deadline_context_s: responseDeadlineContextS,
      visual_hidden_perf_ms: visualHiddenPerfMs,
      target_onset_perf_ms: targetOnsetPerfMs,
      onset_late_ms: onsetLateMs,
      measured_pre_roll_ms: Math.max(0, (onset.context_time_s - captureStart.start_context_s) * 1000),
      response_window_ms: protocol.responseWindowMs,
      visibility_interrupted: this.visibilityInterrupted,
      ...publicRecordingFields(recording),
    };
    this.activeTrial = null;
    await this.persistTrial(trial, authorization, payload, recording.blob);
    this.trialInFlight = false;
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
    return recording;
  }

  async runL2Trial(trial, loaded, nextTrial = null) {
    this.trialInFlight = true;
    if (!loaded.cueBuffer) throw new Error("テスト音声を読み込めませんでした。");
    const protocol = trial.protocol.timing;
    this.ui.showFixation();
    this.ui.setTaskStatus("中央の＋を見て、次の英語音声に備えてください。");
    const authorization = await this.authorizeTrial(trial);
    this.primeNextTrial(nextTrial);
    this.visibilityInterrupted = false;
    const targetOnsetPerfMs = await this.prepareOnset(
      350,
      protocol.preAudioRecordingMs + 40,
    );
    this.requireVisibleBeforeOnset();
    this.activeTrial = trial;
    await markTrialStimulusShown(trial.trial_id);
    await delayUntilPerformance(targetOnsetPerfMs - protocol.preAudioRecordingMs);
    const captureStart = await this.audio.startCapture();
    this.ui.setRecording(true);
    const playback = this.audio.playCue(loaded.cueBuffer, protocol.preAudioRecordingMs / 1000);
    const clockAnchor = this.audio.clockSnapshot();
    const scheduledAudioOnsetPerfMs = clockAnchor.performance_time_ms
      + (playback.scheduledStartContextS - clockAnchor.context_time_s) * 1000;
    const onsetLateMs = this.reportOnsetLateness(
      targetOnsetPerfMs,
      scheduledAudioOnsetPerfMs,
      trial,
      authorization.attempt_id,
    );
    const responseDeadlineContextS = playback.scheduledEndContextS
      + protocol.responseWindowAfterAudioMs / 1000;
    const responseDeadlinePerfMs = clockAnchor.performance_time_ms
      + (responseDeadlineContextS - clockAnchor.context_time_s) * 1000;
    const analysisStartSeconds = Math.max(0, playback.scheduledEndContextS - captureStart.start_context_s);
    const recordingPromise = this.audio.stopCaptureAt(responseDeadlineContextS, analysisStartSeconds);
    void this.sendEvent("l2_audio_scheduled", {
      capture_start_context_s: captureStart.start_context_s,
      audio_scheduled_context_s: playback.scheduledStartContextS,
      audio_scheduled_end_context_s: playback.scheduledEndContextS,
    }, trial, authorization.attempt_id).catch(() => {});
    const audioCueOnsetPromise = delayUntilPerformance(scheduledAudioOnsetPerfMs).then(() => {
      this.ui.showAudioCue();
      this.ui.setRecording(true);
      this.ui.setTaskStatus("英語音声を聞いてください。音声が終わると10秒の回答時間が始まります。");
    });
    const playbackEndPromise = playback.ended.then(async (ended) => {
      await audioCueOnsetPromise;
      this.ui.setTaskStatus("前置きを付けず、日本語の答えだけを1回話してください。分からなければ無言で待ってください。");
      this.ui.startResponseTimer(
        responseDeadlinePerfMs,
        protocol.responseWindowAfterAudioMs,
      );
      return ended;
    });
    const [recording, playbackEnd] = await Promise.all([
      recordingPromise,
      playbackEndPromise,
    ]);
    this.ui.showFixation();
    this.ui.setRecording(false);
    this.scheduleNextOnset(recording.stopped_perf_ms, protocol.interTrialMs);
    const payload = {
      task: "l2_to_l1",
      audio_scheduled_context_s: playback.scheduledStartContextS,
      audio_scheduled_end_context_s: playback.scheduledEndContextS,
      audio_duration_s: playback.durationS,
      audio_ended_perf_ms: playbackEnd.endedPerfMs,
      audio_ended_context_s: playbackEnd.endedContextS,
      response_deadline_context_s: responseDeadlineContextS,
      response_deadline_perf_ms: recording.stopped_perf_ms,
      scheduled_audio_onset_perf_ms: scheduledAudioOnsetPerfMs,
      target_onset_perf_ms: targetOnsetPerfMs,
      onset_late_ms: onsetLateMs,
      measured_pre_audio_ms: Math.max(
        0,
        (playback.scheduledStartContextS - captureStart.start_context_s) * 1000,
      ),
      clock_anchor: clockAnchor,
      response_window_after_audio_ms: protocol.responseWindowAfterAudioMs,
      visibility_interrupted: this.visibilityInterrupted,
      ...publicRecordingFields(recording),
    };
    this.activeTrial = null;
    await this.persistTrial(trial, authorization, payload, recording.blob);
    this.trialInFlight = false;
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
    return recording;
  }

}
