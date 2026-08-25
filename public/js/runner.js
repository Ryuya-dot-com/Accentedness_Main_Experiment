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

export class ExperimentRunner {
  constructor(api, ui, audio, state) {
    this.api = api;
    this.ui = ui;
    this.audio = audio;
    this.state = state;
    this.running = false;
    this.activeTrial = null;
    this.visibilityInterrupted = false;
    this.heartbeatTimer = null;
    this.nextOnsetNotBeforePerfMs = null;
    this.backgroundUploads = new Set();
    this.backgroundUploadFailed = false;
    this.backgroundUploadError = null;
    this.backgroundUploadTail = Promise.resolve();
    this.preloadedTrials = new Map();
    this.onVisibility = () => {
      const hidden = document.visibilityState !== "visible";
      if (hidden && this.activeTrial) this.visibilityInterrupted = true;
      this.sendEvent("visibility_changed", { hidden }).catch(() => {});
    };
    this.onBeforeUnload = (event) => {
      if (!this.running) return;
      event.preventDefault();
      event.returnValue = "";
    };
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
          this.ui.fatal(error);
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

  async reconcileOutbox(hasQueuedRecordingForAttempt = hasQueuedRecording) {
    await this.flushWithRetry();
    this.state = await this.api.state();
    const manifestByTrialId = new Map(
      this.state.manifest.map((trial) => [trial.trial_id, trial]),
    );
    const pendingRecordings = this.state.accepted.filter((accepted) => (
      manifestByTrialId.get(accepted.trial_id)?.expects_recording
        && accepted.recording_state !== "uploaded"
    ));
    for (const accepted of pendingRecordings) {
      const recoverable = await hasQueuedRecordingForAttempt(
        this.state.visit.visit_id,
        accepted.attempt_id,
      );
      if (!recoverable) {
        const error = new Error(
          "送信前の録音がこのブラウザに残っていません。これ以上進めず、担当者に知らせてください。",
        );
        error.code = "local_recording_missing";
        error.details = {
          trial_id: accepted.trial_id,
          attempt_id: accepted.attempt_id,
          recording_state: accepted.recording_state,
        };
        throw error;
      }
    }
    return this.state;
  }

  async flushWithRetry() {
    if (this.backgroundUploads.size) await Promise.allSettled([...this.backgroundUploads]);
    while (true) {
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
        await this.ui.prompt(
          `データをまだ送信できていません。ネットワーク接続を確認してください。\n\n${error.message}`,
          "再送する",
        );
      }
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
          `この試行の回答をまだ送信できていません。ネットワーク接続を確認してください。\n\n${error.message}`,
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
          `完了確認をまだ受信できていません。ネットワーク接続を確認してください。\n\n${error.message}`,
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
          `研究用サーバーへの保存は完了していますが、このパソコン向けZIPをまだ準備できません。ネットワーク接続を確認してください。\n\n${error.message}`,
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
      throw new Error("試行中に画面が非表示になりました。この試行は記録済みです。続行せず担当者に知らせてください。");
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
      } catch (error) {
        URL.revokeObjectURL(imageUrl);
        throw new Error(`刺激画像をデコードできませんでした: ${error.message}`);
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
    if (!loaded.cueBuffer) throw new Error("学習音声を読み込めませんでした。");
    const protocol = trial.protocol.timing;
    this.ui.showFixation();
    this.ui.setTaskStatus("中央の＋を見て、次の絵と英単語に備えてください。");
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
    this.ui.setTaskStatus("絵と英単語を覚えてください。5秒後に自動で次へ進みます。");
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
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
  }

  async runPictureNamingTrial(trial, loaded, nextTrial = null) {
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
    this.ui.setTaskStatus("英単語を10秒以内に話してください。答えた後も自動で切り替わるまでお待ちください。");
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
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
    return recording;
  }

  async runL2Trial(trial, loaded, nextTrial = null) {
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
      this.ui.setTaskStatus("日本語で答えてください。回答時間は10秒です。");
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
    this.stopIfVisibilityInterrupted(payload.visibility_interrupted);
    return recording;
  }

  async reviewPracticeRecording(recording) {
    const quality = recording.quality;
    const warning = quality.rms_amplitude < 0.008
      ? "録音音量が小さい可能性があります。マイクに少し近づいてください。"
      : quality.clipping_ratio > 0.01
        ? "録音音量が大きすぎる可能性があります。マイクから少し離れてください。"
        : "録音音量を確認できました。";
    await this.ui.prompt(`練習録音を再生して確認します。\n${warning}`, "録音を再生");
    await this.audio.playBlob(recording.blob);
    await this.ui.prompt("自分の声が聞こえたら続けてください。聞こえない場合は担当者に知らせてください。");
  }
}
