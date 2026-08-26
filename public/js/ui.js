export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function countdownState(deadlinePerfMs, durationMs, nowPerfMs) {
  const safeDurationMs = Math.max(1, Number(durationMs) || 0);
  const remainingMs = Math.max(0, Number(deadlinePerfMs) - Number(nowPerfMs));
  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1_000),
    fraction: Math.max(0, Math.min(1, remainingMs / safeDurationMs)),
  };
}

export function progressState(label, completedInput, totalInput, { inProgress = false } = {}) {
  const total = Math.max(0, Math.trunc(Number(totalInput) || 0));
  const completed = Math.max(0, Math.min(total, Math.trunc(Number(completedInput) || 0)));
  const position = inProgress && completed < total ? completed + 1 : completed;
  return {
    completed,
    total,
    position,
    percent: total > 0 ? completed / total * 100 : 0,
    labelText: inProgress && completed < total
      ? `${label}　${position}/${total} 回目`
      : `${label}　${completed}/${total} 完了`,
    valueText: inProgress && completed < total
      ? `${label}、現在 ${position}/${total} 回目、完了 ${completed}/${total}`
      : `${label}、完了 ${completed}/${total}`,
  };
}

export function participantGuidanceError(message) {
  const error = new Error(String(message));
  Object.defineProperty(error, "participantGuidance", { value: true });
  return error;
}

export function participantSupportCode(error) {
  const source = String(error?.code ?? error?.message ?? error?.name ?? "participant-error");
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `E-${(hash >>> 0).toString(36).toUpperCase().padStart(7, "0")}`;
}

export const PARTICIPANT_COPY_DELIVERY = Object.freeze({
  DIRECT_WRITE_CONFIRMED: "direct_write_confirmed",
  DOWNLOAD_STARTED: "download_started",
});

export function participantCopyCompletionMessage(
  delivery,
  { alreadyCompleted = false, filename = "accentedness_results.zip" } = {},
) {
  const safeFilename = /^[A-Za-z0-9._-]+\.zip$/u.test(String(filename))
    ? String(filename)
    : "accentedness_results.zip";
  const completion = alreadyCompleted
    ? "遅延テストは終了しています。回答と録音も保存済みです。"
    : "遅延テストは終了し、回答と録音は保存されました。";
  if (delivery === PARTICIPANT_COPY_DELIVERY.DIRECT_WRITE_CONFIRMED) {
    return `${completion} 選択した保存先へのZIP書き込みも完了しました。必要なら下のボタンからもう一度保存できます。ご協力ありがとうございました。`;
  }
  if (delivery === PARTICIPANT_COPY_DELIVERY.DOWNLOAD_STARTED) {
    return `${completion} ZIPのダウンロードを開始しました。Chromeのダウンロード一覧を開き、「${safeFilename}」が最後までダウンロードされていることを確認してください。確認できない場合は、下のリンクからもう一度ダウンロードを開始できます。ご協力ありがとうございました。`;
  }
  throw new TypeError("参加者向けZIPの受け渡し状態を確認できませんでした。");
}

export function validateBrowserEnvironment({ microphone }) {
  const failures = [];
  const userAgent = navigator.userAgent ?? "";
  const isChrome = /Chrome\//u.test(userAgent) && !/Edg\/|OPR\/|CriOS/u.test(userAgent);
  const isMobile = /Android|iPhone|iPad|Mobile/u.test(userAgent);
  if (!isChrome) failures.push("パソコン版Google Chromeで開いてください。");
  if (isMobile) failures.push("スマートフォンやタブレットでは実施できません。パソコンを使用してください。");
  if (!window.isSecureContext) failures.push("安全なHTTPS接続で開いてください。");
  if (!window.indexedDB) failures.push("このブラウザでは一時保存機能を利用できません。");
  if (!window.AudioContext) failures.push("このブラウザでは音声再生機能を利用できません。");
  if (window.innerWidth < 900 || window.innerHeight < 600) {
    failures.push("課題画面が見切れています。ウィンドウを最大化するか、Chromeのズームを100%に戻してから再読み込みしてください。");
  }
  if (microphone && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) {
    failures.push("このブラウザでは必要なマイク録音機能を利用できません。");
  }
  return failures;
}

const PARTICIPANT_ERROR_MESSAGES = Object.freeze({
  invalid_invitation: "招待リンクの形式を確認できません。担当者から届いたリンクを開き直してください。",
  invitation_not_found: "この招待リンクは無効または再発行済みです。担当者へ新しいリンクを依頼してください。",
  wrong_visit_route: "このリンクと開いている課題が一致しません。ページを閉じ、担当者から届いたリンクを開き直してください。",
  participant_name_not_registered: "Preで氏名登録が完了していません。このまま進まず担当者へ連絡してください。",
  invalid_name_preview: "氏名確認情報を読み込めませんでした。このまま進まず担当者へ連絡してください。",
  visit_closed: "この課題はすでに終了しています。担当者に知らせてください。",
  visit_not_available: "この課題はまだ開始できません。担当者の案内後に開き直してください。",
  invalid_session: "この画面の情報を確認できません。担当者から届いたリンクを開き直してください。",
  session_expired: "この画面の有効時間が切れました。回答期限ではありません。担当者から届いた同じ招待リンクを開き直すと、続きから再開できます。",
  session_superseded: "別のタブまたは再開操作により、この画面は無効になりました。この画面では続行しないでください。",
  production_collection_blocked: "実験環境が本番開始条件を満たしていないため停止しました。担当者に知らせてください。",
  placeholder_assets_disabled: "本番刺激を確認できないため停止しました。担当者に知らせてください。",
  stimulus_asset_missing: "必要な刺激を読み込めないため停止しました。担当者に知らせてください。",
  participant_copy_before_completion: "遅延テストの完了を確認できません。担当者に知らせてください。",
  participant_copy_visits_incomplete: "3回分の結果ファイルを準備できません。担当者に知らせてください。",
  participant_copy_not_ready: "結果ファイルに必要な回答または録音を確認できません。担当者に知らせてください。",
  participant_copy_session_expired: "実験データは保存済みです。このパソコン向けZIPをもう一度取得する場合は、担当者へ依頼してください。",
  participation_termination_pending: "参加終了の処理中です。同じ招待リンクを開き直して、終了確認を続けてください。新しい問題は開始されません。",
  local_outbox_inconsistent: "保存待ちの回答を確認できません。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  local_recording_missing: "前回の回答に対応する録音を確認できないため、この課題は完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  local_recording_unreadable: "前回の回答に対応する録音を読み出せないため、この課題は完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  request_timeout: "通信がタイムアウトしました。ネットワーク接続を確認し、担当者から届いた同じ招待リンクを開き直してください。",
  session_storage_unavailable: "このブラウザでは回答を一時保存できません。通常モードのGoogle Chromeで開き直し、担当者に知らせてください。",
});

export function participantErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (PARTICIPANT_ERROR_MESSAGES[code]) return PARTICIPANT_ERROR_MESSAGES[code];
  if (/^(invalid_|response_|recording_|trial_|stimulus_|idempotency_|canonical_)/u.test(code)) {
    return "データまたは課題状態の整合性を確認できないため停止しました。お問い合わせ番号を記録し、担当者へ知らせてください。";
  }
  const message = String(error?.message ?? "");
  if (error?.participantGuidance === true && message) return message;
  return "課題を続けられない問題が発生しました。お問い合わせ番号を記録し、担当者へ知らせてください。";
}

export function fatalErrorMessage(error, { interruptionRequested = false } = {}) {
  if (!interruptionRequested) return participantErrorMessage(error);
  return [
    "「中断・終了」を押した後、課題を安全に続行できない問題が発生しました。",
    "この画面では、通常完了、一時中断、参加終了のどれが完了したか確認できていません。回答や録音がどこまで保存されたかも確認できていません。",
    "担当者から届いた同じ有効な招待リンクを開き直し、参加者IDを入力して表示される氏名を確認してください。画面が開いたら、新しい問題を始める前に「中断・終了」を選んでください。",
    "同じリンクを開けない場合や状態が分からない場合は、お問い合わせ番号とともに担当者へ連絡してください。",
  ].join("\n\n");
}

export class ExperimentUi {
  constructor() {
    this.welcome = document.getElementById("welcome");
    this.task = document.getElementById("task");
    this.fatalPanel = document.getElementById("fatal");
    this.fatalMessage = document.getElementById("fatal-message");
    this.badge = document.getElementById("connection-badge");
    this.participantIdForm = document.getElementById("participant-id-form");
    this.participantIdInput = document.getElementById("participant-id-input");
    this.participantIdSubmit = document.getElementById("participant-id-submit");
    this.participantIdStatus = document.getElementById("participant-id-status");
    this.participantNameForm = document.getElementById("participant-name-form");
    this.participantNameInput = document.getElementById("participant-name-input");
    this.participantNameSubmit = document.getElementById("participant-name-submit");
    this.participantNameStatus = document.getElementById("participant-name-status");
    this.participantNameConfirmation = document.getElementById("participant-name-confirmation");
    this.participantNameConfirmationHeading = document.getElementById("participant-name-confirmation-heading");
    this.participantNameConfirmationPrompt = document.getElementById("participant-name-confirmation-prompt");
    this.participantNameConfirmationValue = document.getElementById("participant-name-confirmation-value");
    this.participantNameConfirm = document.getElementById("participant-name-confirm");
    this.participantNameEdit = document.getElementById("participant-name-edit");
    this.participantNameReject = document.getElementById("participant-name-reject");
    this.participantNameConfirmationStatus = document.getElementById("participant-name-confirmation-status");
    this.participationSetup = document.getElementById("participation-setup");
    this.summary = document.getElementById("participant-summary");
    this.readyCheck = document.getElementById("ready-check");
    this.startButton = document.getElementById("start-button");
    this.welcomeStatus = document.getElementById("welcome-status");
    this.progressLabel = document.getElementById("progress-label");
    this.progressTrack = document.getElementById("progress-track");
    this.progressFill = document.getElementById("progress-fill");
    this.progressDetail = document.getElementById("progress-detail");
    this.saveState = document.getElementById("save-state");
    this.stage = document.getElementById("stage");
    this.fixation = document.getElementById("fixation");
    this.image = document.getElementById("stimulus-image");
    this.emoji = document.getElementById("stimulus-emoji");
    this.placeholder = document.getElementById("placeholder-card");
    this.placeholderGloss = document.getElementById("placeholder-gloss");
    this.audioCue = document.getElementById("audio-cue");
    this.recording = document.getElementById("recording-indicator");
    this.responseTimer = document.getElementById("response-timer");
    this.responseTimerLabel = document.getElementById("response-timer-label");
    this.responseTimerValue = document.getElementById("response-timer-value");
    this.responseTimerFill = document.getElementById("response-timer-fill");
    this.message = document.getElementById("stage-message");
    this.promptKeyboardHint = document.getElementById("prompt-keyboard-hint");
    this.continueKeyLabel = document.getElementById("continue-key-label");
    this.continueButton = document.getElementById("continue-button");
    this.downloadLink = document.getElementById("download-link");
    this.interruptionButton = document.getElementById("interruption-button");
    this.welcomeInterruptionButton = document.getElementById("welcome-interruption-button");
    this.interruptionButtons = [
      this.interruptionButton,
      this.welcomeInterruptionButton,
    ].filter(Boolean);
    this.interruptionChoice = document.getElementById("interruption-choice");
    this.interruptionChoiceTitle = document.getElementById("interruption-choice-title");
    this.interruptionChoiceDescription = document.getElementById("interruption-choice-description");
    this.pauseParticipationButton = document.getElementById("pause-participation-button");
    this.terminateParticipationButton = document.getElementById("terminate-participation-button");
    this.cancelInterruptionButton = document.getElementById("cancel-interruption-button");
    this.taskStatus = document.getElementById("task-status");
    this.activeImageUrl = null;
    this.activeDownloadUrl = null;
    this.responseTimerFrame = null;
    this.responseTimerRun = 0;
    this.activePromptFinish = null;
    this.spaceHeld = false;
    this.interruptionHandler = null;
    for (const button of this.interruptionButtons) {
      button.addEventListener("click", () => {
        if (!button.disabled) this.interruptionHandler?.();
      });
    }
    document.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spaceHeld = false;
    });
    window.addEventListener("pagehide", () => {
      this.stopResponseTimer();
      this.clearParticipantAccess();
      if (this.activeDownloadUrl) URL.revokeObjectURL(this.activeDownloadUrl);
    }, { once: true });
  }

  setConnected(state) {
    this.badge.textContent = state ? "接続済み" : "接続エラー";
    this.badge.classList.toggle("error", !state);
  }

  setParticipant(id, visitType) {
    const visitLabel = {
      pre: "事前テスト",
      immediate: "直後課題",
      delayed: "遅延テスト",
    }[visitType] ?? "実験課題";
    this.summary.textContent = `参加者ID: ${id}　／　${visitLabel}`;
    this.summary.hidden = false;
  }

  hideParticipantAccessSteps() {
    this.participantIdForm.hidden = true;
    this.participantNameForm.hidden = true;
    this.participantNameConfirmation.hidden = true;
  }

  clearParticipantName() {
    this.participantNameInput.value = "";
    this.participantNameInput.setAttribute("aria-invalid", "false");
    this.participantNameConfirmationValue.textContent = "";
    this.participantNameConfirmationStatus.textContent = "";
  }

  clearParticipantAccess() {
    this.participantIdInput.value = "";
    this.clearParticipantName();
    this.hideParticipantAccessSteps();
  }

  requestParticipantId(message = "") {
    this.participationSetup.hidden = true;
    this.hideParticipantAccessSteps();
    this.clearParticipantName();
    this.participantIdForm.hidden = false;
    this.participantIdSubmit.disabled = false;
    this.participantIdStatus.textContent = message || "担当者から案内された参加者IDを入力してください。";
    this.welcomeStatus.textContent = "氏名は参加者記録の確認に使用します。このブラウザには保存しません。";
    this.participantIdInput.focus();
    return new Promise((resolve) => {
      const onSubmit = (event) => {
        event.preventDefault();
        if (!this.participantIdForm.reportValidity()) return;
        const participantId = this.participantIdInput.value.trim();
        if (!participantId) return;
        this.participantIdForm.removeEventListener("submit", onSubmit);
        this.participantIdSubmit.disabled = true;
        this.participantIdStatus.textContent = "招待リンクと参加者IDを確認しています。";
        resolve(participantId);
      };
      this.participantIdForm.addEventListener("submit", onSubmit);
    });
  }

  requestParticipantName(initialValue = "", message = "") {
    this.hideParticipantAccessSteps();
    this.clearParticipantName();
    this.participantNameForm.hidden = false;
    this.participantNameSubmit.disabled = false;
    this.participantNameStatus.textContent = message
      || "氏名は保存前に次の画面で確認できます。";
    this.participantNameInput.value = String(initialValue ?? "");
    this.participantNameInput.setAttribute("aria-invalid", message ? "true" : "false");
    this.participantNameInput.focus();
    return new Promise((resolve) => {
      const onSubmit = (event) => {
        event.preventDefault();
        if (!this.participantNameForm.reportValidity()) return;
        // Pass the raw value to the shared canonicalizer/validator. In particular,
        // whitespace-only input must produce inline feedback instead of making the
        // submit button appear unresponsive here.
        const participantName = this.participantNameInput.value;
        this.participantNameForm.removeEventListener("submit", onSubmit);
        this.participantNameSubmit.disabled = true;
        this.participantNameInput.setAttribute("aria-invalid", "false");
        this.participantNameInput.value = "";
        resolve(participantName);
      };
      this.participantNameForm.addEventListener("submit", onSubmit);
    });
  }

  confirmParticipantName(participantName, { allowEdit = false } = {}) {
    this.hideParticipantAccessSteps();
    this.participantNameInput.value = "";
    this.participantNameConfirmation.hidden = false;
    this.participantNameConfirmationPrompt.textContent = allowEdit
      ? "この氏名をPreの参加者記録として保存します。誤りがないか確認してください。"
      : "Preで記録された氏名です。ご自身の氏名であることを確認してください。";
    this.participantNameConfirmationValue.textContent = String(participantName ?? "");
    this.participantNameConfirmationStatus.textContent = allowEdit
      ? "誤りがある場合は「氏名を修正」を選んでください。"
      : "ご自身の氏名でない場合は「いいえ、違います」を選んでください。";
    this.participantNameEdit.hidden = !allowEdit;
    this.participantNameReject.hidden = allowEdit;
    this.participantNameConfirm.disabled = false;
    this.participantNameEdit.disabled = false;
    this.participantNameReject.disabled = false;
    this.participantNameConfirmationHeading.focus();
    return new Promise((resolve) => {
      const cleanup = () => {
        this.participantNameConfirm.removeEventListener("click", onConfirm);
        this.participantNameEdit.removeEventListener("click", onEdit);
        this.participantNameReject.removeEventListener("click", onReject);
        this.participantNameConfirmation.hidden = true;
        this.clearParticipantName();
      };
      const finish = (decision) => {
        this.participantNameConfirm.disabled = true;
        this.participantNameEdit.disabled = true;
        this.participantNameReject.disabled = true;
        cleanup();
        resolve(decision);
      };
      const onConfirm = () => finish("confirm");
      const onEdit = () => finish("edit");
      const onReject = () => finish("reject");
      this.participantNameConfirm.addEventListener("click", onConfirm);
      this.participantNameEdit.addEventListener("click", onEdit);
      this.participantNameReject.addEventListener("click", onReject);
    });
  }

  showParticipationSetup() {
    this.clearParticipantAccess();
    this.participationSetup.hidden = false;
  }

  enableStartWhenReady() {
    this.updateStartAvailability = () => {
      this.startButton.disabled = !this.readyCheck.checked;
    };
    this.readyCheck.addEventListener("change", this.updateStartAvailability);
    this.updateStartAvailability();
  }

  waitForStart() {
    return new Promise((resolve) => {
      const cleanup = () => {
        this.startButton.removeEventListener("click", onStart);
        this.welcomeInterruptionButton?.removeEventListener("click", onInterrupt);
      };
      const onStart = () => {
        cleanup();
        this.startButton.disabled = true;
        if (this.welcomeInterruptionButton) this.welcomeInterruptionButton.disabled = true;
        resolve("start");
      };
      const onInterrupt = () => {
        cleanup();
        resolve("interrupt");
      };
      this.startButton.addEventListener("click", onStart);
      this.welcomeInterruptionButton?.addEventListener("click", onInterrupt);
    });
  }

  beginTask() {
    document.body.classList.add("experiment-active");
    this.welcome.hidden = true;
    this.task.hidden = false;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }

  returnToWelcome() {
    document.body.classList.remove("experiment-active");
    this.resetStage();
    this.task.hidden = true;
    this.welcome.hidden = false;
    this.clearInterruptionPending();
    this.updateStartAvailability?.();
    this.welcome.scrollIntoView({ block: "start" });
    (this.startButton.disabled ? this.readyCheck : this.startButton).focus();
  }

  bindInterruptionControl(handler) {
    this.interruptionHandler = handler;
  }

  setInterruptionPending(activeTrial) {
    for (const button of this.interruptionButtons) {
      button.textContent = button === this.interruptionButton && activeTrial
        ? "この回の後に確認"
        : "中断・終了を確認中";
      button.disabled = true;
    }
  }

  clearInterruptionPending() {
    for (const button of this.interruptionButtons) {
      button.textContent = "中断・終了";
      button.disabled = false;
    }
  }

  releaseActivePromptForInterruption() {
    this.activePromptFinish?.();
  }

  setInterruptionControlEnabled(enabled) {
    for (const button of this.interruptionButtons) {
      button.disabled = !enabled;
      if (!enabled) button.textContent = "中断・終了";
    }
  }

  resetStage() {
    this.stopResponseTimer();
    this.stage.classList?.remove("prompt-active");
    if (this.activeImageUrl) {
      URL.revokeObjectURL(this.activeImageUrl);
      this.activeImageUrl = null;
    }
    [
      this.fixation,
      this.image,
      this.emoji,
      this.placeholder,
      this.audioCue,
      this.message,
      this.promptKeyboardHint,
      this.continueKeyLabel,
      this.continueButton,
      this.downloadLink,
      this.interruptionChoice,
    ]
      .forEach((element) => { if (element) element.hidden = true; });
    if (this.continueButton) this.continueButton.disabled = false;
    if (this.recording) this.recording.hidden = true;
    this.taskStatus.textContent = "";
  }

  showFixation() {
    this.resetStage();
    this.fixation.hidden = false;
  }

  showVisual(trial, imageUrl = null) {
    this.resetStage();
    if (imageUrl) {
      this.activeImageUrl = imageUrl;
      this.image.src = this.activeImageUrl;
      this.image.alt = "課題の絵";
      this.image.hidden = false;
      return "image";
    }
    if (trial.protocol?.visualEmoji) {
      this.emoji.textContent = trial.protocol.visualEmoji;
      this.emoji.setAttribute("aria-label", trial.protocol.visualLabel || "練習用の絵文字");
      this.emoji.hidden = false;
      return "emoji";
    }
    this.placeholderGloss.textContent = "刺激画像を読み込めませんでした";
    this.placeholder.hidden = false;
    return "placeholder";
  }

  showAudioCue() {
    this.resetStage();
    this.audioCue.hidden = false;
  }

  setRecording(active) {
    if (this.recording) this.recording.hidden = !active;
  }

  setTaskStatus(text) {
    this.taskStatus.textContent = text;
  }

  updateProgress(label, completed, total, options = {}) {
    const progress = progressState(label, completed, total, options);
    this.progressLabel.textContent = progress.labelText;
    this.progressFill.style.width = `${progress.percent.toFixed(2)}%`;
    this.progressTrack.setAttribute("aria-valuemax", String(progress.total));
    this.progressTrack.setAttribute("aria-valuenow", String(progress.completed));
    this.progressTrack.setAttribute("aria-valuetext", progress.valueText);
    this.progressDetail.textContent = `完了 ${progress.completed}/${progress.total}。ここまで自動で保存されます。続けられなくなった場合は「中断・終了」を選んでください。`;
  }

  startResponseTimer(deadlinePerfMs, durationMs, label = "回答時間") {
    this.stopResponseTimer();
    const run = this.responseTimerRun;
    this.responseTimerLabel.textContent = label;
    this.responseTimer.hidden = false;
    let priorSeconds = null;
    const tick = (nowPerfMs) => {
      if (run !== this.responseTimerRun) return;
      const state = countdownState(deadlinePerfMs, durationMs, nowPerfMs);
      if (state.remainingSeconds !== priorSeconds) {
        this.responseTimerValue.textContent = state.remainingSeconds > 0
          ? `残り ${state.remainingSeconds} 秒`
          : "時間終了";
        this.responseTimer.setAttribute(
          "aria-label",
          state.remainingSeconds > 0
            ? `${label}、残り${state.remainingSeconds}秒`
            : `${label}、時間終了`,
        );
        priorSeconds = state.remainingSeconds;
      }
      this.responseTimerFill.style.transform = `scaleX(${state.fraction.toFixed(5)})`;
      this.responseTimer.classList.toggle("ending", state.remainingMs > 0 && state.remainingMs <= 3_000);
      if (state.remainingMs > 0) {
        this.responseTimerFrame = window.requestAnimationFrame(tick);
      } else {
        this.responseTimerFrame = null;
      }
    };
    this.responseTimerFrame = window.requestAnimationFrame(tick);
  }

  stopResponseTimer() {
    this.responseTimerRun += 1;
    if (this.responseTimerFrame !== null) {
      window.cancelAnimationFrame(this.responseTimerFrame);
      this.responseTimerFrame = null;
    }
    if (this.responseTimer) {
      this.responseTimer.hidden = true;
      this.responseTimer.classList.remove("ending");
    }
  }

  setSaveState(state) {
    const pending = state !== "saved";
    this.saveState.classList.toggle("pending", pending);
    this.saveState.textContent = state === "saving"
      ? "保存中…"
      : state === "queued"
        ? "未送信あり"
        : "ここまで保存済み";
  }

  async prompt(message, buttonLabel = "続ける") {
    this.resetStage();
    this.stage.classList?.add("prompt-active");
    this.message.textContent = message;
    this.message.hidden = false;
    this.promptKeyboardHint.textContent = `キーボードのスペースキーを1回押すと「${buttonLabel}」へ進みます。クリックや他のキーでは進みません。`;
    this.promptKeyboardHint.hidden = false;
    this.continueKeyLabel.textContent = "Space";
    this.continueKeyLabel.hidden = false;
    this.stage.setAttribute("aria-keyshortcuts", "Space");
    await new Promise((resolve) => {
      const cleanup = () => {
        document.removeEventListener("keydown", onKey);
        this.stage.removeAttribute("aria-keyshortcuts");
      };
      const finish = () => {
        if (this.activePromptFinish !== finish) return;
        this.activePromptFinish = null;
        cleanup();
        resolve();
      };
      const onKey = (event) => {
        if (![this.stage, document.body].includes(event.target)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          return;
        }
        if (event.code !== "Space") return;
        event.preventDefault();
        if (event.repeat || this.spaceHeld) return;
        this.spaceHeld = true;
        finish();
      };
      document.addEventListener("keydown", onKey);
      this.activePromptFinish = finish;
      this.stage.focus({ preventScroll: true });
    });
  }

  chooseInterruptionMode() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.interruptionChoiceTitle.textContent = "課題を中断・終了しますか？";
    this.interruptionChoiceDescription.textContent = "一時中断すると、ここまでを保存し、同じ招待リンクから続きに戻れます。参加終了を選ぶと、実験への参加を終え、再開できません。";
    this.pauseParticipationButton.textContent = "一時中断する";
    this.pauseParticipationButton.hidden = false;
    this.terminateParticipationButton.textContent = "参加を終了する";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "課題に戻る";
    this.interruptionChoice.hidden = false;
    this.pauseParticipationButton.focus();
    return new Promise((resolve) => {
      const finish = (mode) => {
        this.pauseParticipationButton.removeEventListener("click", onPause);
        this.terminateParticipationButton.removeEventListener("click", onTerminate);
        this.cancelInterruptionButton.removeEventListener("click", onCancel);
        this.interruptionChoice.hidden = true;
        if (!mode) this.stage.focus();
        resolve(mode);
      };
      const onPause = () => finish("pause");
      const onTerminate = () => finish("terminate");
      const onCancel = () => finish(null);
      this.pauseParticipationButton.addEventListener("click", onPause);
      this.terminateParticipationButton.addEventListener("click", onTerminate);
      this.cancelInterruptionButton.addEventListener("click", onCancel);
    });
  }

  retryInterruptionOrShowCloseGuidance(message, retryLabel = "再試行") {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.interruptionChoiceTitle.textContent = "まだ確定していません";
    this.interruptionChoiceDescription.textContent = `${message}\n\n通信を再試行できます。いま再試行しない場合も、確定済みとは表示せず、担当者へ伝えるための確認番号を次の画面に表示します。`;
    this.pauseParticipationButton.textContent = retryLabel;
    this.pauseParticipationButton.hidden = false;
    this.terminateParticipationButton.hidden = true;
    this.cancelInterruptionButton.textContent = "再試行せず案内を見る";
    this.interruptionChoice.hidden = false;
    this.pauseParticipationButton.focus();
    return new Promise((resolve) => {
      const finish = (retry) => {
        this.pauseParticipationButton.removeEventListener("click", onRetry);
        this.cancelInterruptionButton.removeEventListener("click", onStop);
        this.interruptionChoice.hidden = true;
        resolve(retry);
      };
      const onRetry = () => finish(true);
      const onStop = () => finish(false);
      this.pauseParticipationButton.addEventListener("click", onRetry);
      this.cancelInterruptionButton.addEventListener("click", onStop);
    });
  }

  chooseTerminationAfterUnsafePause() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.interruptionChoiceTitle.textContent = "一時中断を安全に確定できません";
    this.interruptionChoiceDescription.textContent = "まだ保存できていない回答または録音があるため、続きから再開できる状態で中断できません。参加終了へ切り替えると、すでに保存できたデータだけを残して実験への参加を終了します。切り替えない場合は担当者へ連絡してください。";
    this.pauseParticipationButton.hidden = true;
    this.terminateParticipationButton.textContent = "参加終了へ切り替える";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "切り替えず案内を見る";
    this.interruptionChoice.hidden = false;
    this.cancelInterruptionButton.focus();
    return new Promise((resolve) => {
      const finish = (escalate) => {
        this.terminateParticipationButton.removeEventListener("click", onEscalate);
        this.cancelInterruptionButton.removeEventListener("click", onStop);
        this.interruptionChoice.hidden = true;
        resolve(escalate);
      };
      const onEscalate = () => finish(true);
      const onStop = () => finish(false);
      this.terminateParticipationButton.addEventListener("click", onEscalate);
      this.cancelInterruptionButton.addEventListener("click", onStop);
    });
  }

  chooseTerminationAfterUnsafeResume() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.interruptionChoiceTitle.textContent = "前回のデータを安全に送信できません";
    this.interruptionChoiceDescription.textContent = "前回の回答または録音を保存できないため、このまま課題を再開したり、一時中断したりできません。参加終了を選ぶと、すでに保存できたデータだけを残して実験への参加を終了します。終了を選ばない場合は担当者へ連絡してください。";
    this.pauseParticipationButton.hidden = true;
    this.terminateParticipationButton.textContent = "受付済みデータで参加を終了する";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "終了せず担当者へ連絡する";
    this.interruptionChoice.hidden = false;
    this.cancelInterruptionButton.focus();
    return new Promise((resolve) => {
      const finish = (terminate) => {
        this.terminateParticipationButton.removeEventListener("click", onTerminate);
        this.cancelInterruptionButton.removeEventListener("click", onContact);
        this.interruptionChoice.hidden = true;
        resolve(terminate);
      };
      const onTerminate = () => finish(true);
      const onContact = () => finish(false);
      this.terminateParticipationButton.addEventListener("click", onTerminate);
      this.cancelInterruptionButton.addEventListener("click", onContact);
    });
  }

  showInterruptionWorking(mode) {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.message.textContent = mode === "pause"
      ? "ここまでの回答と録音を保存し、一時中断の手続きをしています。"
      : "ここまでの回答と録音を保存し、参加終了の手続きをしています。";
    this.message.hidden = false;
    this.setTaskStatus("「このページは閉じて構いません」と表示されるまで、画面を閉じないでください。");
  }

  interrupted(mode, { partialData = false } = {}) {
    this.resetStage();
    for (const button of this.interruptionButtons) {
      button.disabled = true;
      button.textContent = mode === "pause" ? "一時中断済み" : "参加終了済み";
    }
    this.progressLabel.textContent = mode === "pause" ? "一時中断" : "参加終了";
    this.progressTrack.setAttribute(
      "aria-valuetext",
      mode === "pause" ? "一時中断を保存済み" : "参加終了を受付済み",
    );
    this.progressDetail.textContent = partialData
      ? "一部の録音を保存できませんでした。すでに保存できたデータは残ります。"
      : "ここまでの回答と録音は保存されています。";
    this.saveState.textContent = partialData ? "一部未保存・参加終了済み" : "保存済み";
    this.saveState.classList.toggle("pending", partialData);
    this.message.textContent = mode === "pause"
      ? "一時中断が完了しました。このページは閉じて構いません。再開するときは、担当者から届いた元の招待リンクを開いてください。"
      : partialData
        ? "参加終了が完了しました。一部の録音は保存できませんでしたが、すでに保存できたデータは残ります。このページは閉じて構いません。"
        : "参加終了が完了しました。ここまでのデータは保存されています。このページは閉じて構いません。参加終了後は、この招待リンクから課題を再開できません。";
    this.message.hidden = false;
    this.stage.focus();
  }

  async confirmTerminationWithPartialData() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.progressDetail.textContent = "一部の回答または録音を保存できていません。";
    this.saveState.textContent = "一部未保存";
    this.saveState.classList.add("pending");
    this.interruptionChoiceTitle.textContent = "保存できていないデータがあります";
    this.interruptionChoiceDescription.textContent = "一部の回答または録音を保存できません。この状態で参加を終了すると、すでに保存できたデータだけが残り、課題は再開できません。";
    this.pauseParticipationButton.hidden = true;
    this.terminateParticipationButton.textContent = "この状態で参加を終了する";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "終了せず担当者へ連絡する";
    this.interruptionChoice.hidden = false;
    this.cancelInterruptionButton.focus();
    return new Promise((resolve) => {
      const finish = (confirmed) => {
        this.terminateParticipationButton.removeEventListener("click", onConfirm);
        this.cancelInterruptionButton.removeEventListener("click", onCancel);
        this.interruptionChoice.hidden = true;
        resolve(confirmed);
      };
      const onConfirm = () => finish(true);
      const onCancel = () => finish(false);
      this.terminateParticipationButton.addEventListener("click", onConfirm);
      this.cancelInterruptionButton.addEventListener("click", onCancel);
    });
  }

  interruptionUnconfirmed(mode, requestId) {
    this.resetStage();
    for (const button of this.interruptionButtons) {
      button.disabled = true;
      button.textContent = "確定未確認";
    }
    this.progressLabel.textContent = mode === "pause" ? "一時中断：未確定" : "参加終了：未確定";
    this.progressTrack.setAttribute("aria-valuetext", "中断または参加終了の確定を未確認");
    this.progressDetail.textContent = "中断・終了の完了を確認できませんでした。未保存のデータが残っている可能性があります。";
    this.saveState.textContent = "保存・確定：未確認";
    this.saveState.classList.add("pending");
    this.message.textContent = [
      mode === "pause"
        ? "一時中断はまだ確定したものとして扱わないでください。"
        : "参加終了はまだ確定したものとして扱わないでください。",
      "このページは閉じて構いません。表示された確認番号を記録し、担当者へ知らせてください。",
      `確認番号: ${requestId}`,
    ].join("\n");
    this.message.hidden = false;
    this.stage.focus();
  }

  async downloadParticipantCopy({ blob, filename }) {
    this.resetStage();
    if (this.activeDownloadUrl) URL.revokeObjectURL(this.activeDownloadUrl);
    const objectUrl = URL.createObjectURL(blob);
    this.activeDownloadUrl = objectUrl;
    this.message.textContent = [
      "実験の回答と録音は保存されています。",
      "事前・直後・遅延の3回分の結果を、1つのZIPとしてこのパソコンにも保存してください。",
      "共用パソコンの場合は、他の利用者に見えない保存先を選び、担当者の案内に従って削除してください。",
    ].join("\n");
    this.message.hidden = false;
    this.downloadLink.href = objectUrl;
    this.downloadLink.download = filename;
    this.downloadLink.textContent = "ZIPをダウンロード";
    this.downloadLink.hidden = false;
    return new Promise((resolve) => {
      this.downloadLink.addEventListener("click", () => {
        window.setTimeout(() => {
          this.downloadLink.textContent = "ZIPをもう一度ダウンロード";
          this.setTaskStatus(
            "ZIPのダウンロードを開始しました。Chromeのダウンロード一覧で、ZIPが最後までダウンロードされていることを確認してください。",
          );
          resolve({ delivery: PARTICIPANT_COPY_DELIVERY.DOWNLOAD_STARTED });
        }, 0);
      }, { once: true });
      this.downloadLink.focus();
    });
  }

  chooseParticipantCopyTarget(filename = "accentedness_results.zip") {
    this.resetStage();
    this.message.textContent = [
      "実験の回答と録音は保存されています。",
      "事前・直後・遅延の3回分の結果を、このパソコンにもZIPで保存します。",
      "共用パソコンの場合は、他の利用者に見えない保存先を選び、担当者の案内に従って削除してください。",
    ].join("\n");
    this.message.hidden = false;
    this.continueButton.textContent = typeof window.showSaveFilePicker === "function"
      ? "ZIPの保存先を選ぶ"
      : "ZIPを準備する";
    this.continueButton.hidden = false;
    this.continueButton.focus();
    return new Promise((resolve, reject) => {
      const onClick = async () => {
        this.continueButton.disabled = true;
        try {
          if (typeof window.showSaveFilePicker !== "function") {
            this.continueButton.removeEventListener("click", onClick);
            this.continueButton.disabled = false;
            this.continueButton.hidden = true;
            this.setTaskStatus("ZIPを準備しています。画面を閉じないでください。");
            resolve(null);
            return;
          }
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{
              description: "ZIP archive",
              accept: { "application/zip": [".zip"] },
            }],
          });
          this.continueButton.removeEventListener("click", onClick);
          this.continueButton.disabled = false;
          this.continueButton.hidden = true;
          this.setTaskStatus("ZIPを保存しています。画面を閉じないでください。");
          resolve(handle);
        } catch (error) {
          this.continueButton.disabled = false;
          if (error?.name === "AbortError") {
            this.setTaskStatus("保存先の選択をキャンセルしました。保存する場合は、もう一度ボタンを押してください。");
            return;
          }
          this.continueButton.removeEventListener("click", onClick);
          const pickerError = new Error("保存先を選択できませんでした。");
          pickerError.code = "participant_copy_picker_failed";
          pickerError.cause = error;
          reject(pickerError);
        }
      };
      this.continueButton.addEventListener("click", onClick);
    });
  }

  completed(message, { preserveDownload = false } = {}) {
    document.body.classList.remove("experiment-active");
    this.stopResponseTimer();
    if (preserveDownload) {
      [
        this.fixation,
        this.image,
        this.emoji,
        this.placeholder,
        this.audioCue,
        this.recording,
        this.continueButton,
      ].forEach((element) => { if (element) element.hidden = true; });
    } else {
      this.resetStage();
    }
    this.progressFill.style.width = "100%";
    const progressMax = this.progressTrack.getAttribute("aria-valuemax") ?? "1";
    this.progressTrack.setAttribute("aria-valuenow", progressMax);
    this.progressTrack.setAttribute("aria-valuetext", "この課題の回答と録音を保存済み");
    this.progressLabel.textContent = "課題完了";
    this.message.textContent = message;
    this.message.hidden = false;
    if (preserveDownload && this.activeDownloadUrl) {
      this.downloadLink.hidden = false;
    } else if (preserveDownload) {
      this.continueButton.textContent = "ZIPをもう一度保存";
      this.continueButton.hidden = false;
      this.continueButton.addEventListener("click", () => window.location.reload(), { once: true });
    }
    this.progressDetail.textContent = "この課題の回答と録音は保存されています。";
    this.saveState.textContent = "保存済み";
    this.saveState.classList.remove("pending");
  }

  fatal(error, { interruptionRequested = false } = {}) {
    document.body.classList.remove("experiment-active");
    this.stopResponseTimer();
    this.welcome.hidden = true;
    this.task.hidden = true;
    this.fatalPanel.hidden = false;
    const supportCode = participantSupportCode(error);
    this.fatalMessage.textContent = `${fatalErrorMessage(error, {
      interruptionRequested,
    })}\n\nお問い合わせ番号: ${supportCode}`;
    this.fatalPanel.focus();
  }
}
