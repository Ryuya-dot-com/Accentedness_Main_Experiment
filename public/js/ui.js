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
    percent: total > 0 ? position / total * 100 : 0,
    labelText: inProgress && completed < total
      ? `${label}　試行 ${position}/${total}`
      : `${label}　${completed}/${total} 完了`,
    valueText: inProgress && completed < total
      ? `${label}、現在の試行 ${position}/${total}、完了 ${completed}/${total}`
      : `${label}、完了 ${completed}/${total}`,
  };
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
  const serverCompletion = alreadyCompleted
    ? "遅延テストは研究用サーバーに保存済みです。"
    : "遅延テストは終了し、すべての回答と録音の研究用サーバー保存が完了しました。";
  if (delivery === PARTICIPANT_COPY_DELIVERY.DIRECT_WRITE_CONFIRMED) {
    return `${serverCompletion} 選択した保存先へのZIP書き込みも完了しました。必要なら下のボタンからもう一度保存できます。ご協力ありがとうございました。`;
  }
  if (delivery === PARTICIPANT_COPY_DELIVERY.DOWNLOAD_STARTED) {
    return `${serverCompletion} ZIPのダウンロードを開始しました。Chromeのダウンロード一覧を開き、「${safeFilename}」が最後までダウンロードされていることを確認してください。確認できない場合は、下のリンクからもう一度ダウンロードを開始できます。ご協力ありがとうございました。`;
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
  if (microphone && (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode)) {
    failures.push("このブラウザでは必要なマイク録音機能を利用できません。");
  }
  return failures;
}

const PARTICIPANT_ERROR_MESSAGES = Object.freeze({
  invalid_invitation: "招待リンクの形式を確認できません。担当者から届いたリンクを開き直してください。",
  invitation_not_found: "この招待リンクは無効または再発行済みです。担当者へ新しいリンクを依頼してください。",
  wrong_visit_route: "このリンクと開いている課題が一致しません。ページを閉じ、担当者から届いたリンクを開き直してください。",
  visit_closed: "このセッションはすでに終了しています。担当者に知らせてください。",
  visit_not_available: "このセッションはまだ受付時刻に達していません。担当者の案内後に開き直してください。",
  invalid_session: "セッション情報を確認できません。担当者から届いたリンクを開き直してください。",
  session_expired: "安全のため一時セッションを更新します。参加期限ではありません。担当者から届いた同じ招待リンクを開き直すと、保存済み位置から再開できます。",
  session_superseded: "別のタブまたは再開操作により、この画面は無効になりました。この画面では続行しないでください。",
  production_collection_blocked: "実験環境が本番開始条件を満たしていないため停止しました。担当者に知らせてください。",
  placeholder_assets_disabled: "本番刺激を確認できないため停止しました。担当者に知らせてください。",
  stimulus_asset_missing: "必要な刺激を読み込めないため停止しました。担当者に知らせてください。",
  participant_copy_before_completion: "研究用サーバーで遅延セッションの完了を確認できません。担当者に知らせてください。",
  participant_copy_visits_incomplete: "3回分の結果コピーを準備できません。研究用サーバーのvisit状態を担当者に確認してもらってください。",
  participant_copy_not_ready: "3回分の回答または録音が研究用サーバーで不足しています。担当者に知らせてください。",
  participant_copy_session_expired: "実験データは研究用サーバーに保存済みです。このパソコン向けZIPの再取得は、研究担当者へ依頼してください。",
  participant_identity_not_registered: "この参加者IDの本人確認情報が登録されていません。入力を繰り返さず、担当者に知らせてください。",
  participation_termination_pending: "参加終了の処理中です。同じ招待リンクを開き直して、終了確認を続けてください。新しい試行は開始されません。",
  local_recording_missing: "前回の回答に対応する送信前録音を確認できないため、このセッションは完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、表示されたコードを担当者へ知らせてください。",
  local_recording_unreadable: "前回の回答に対応する送信前録音を読み出せないため、このセッションは完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、表示されたコードを担当者へ知らせてください。",
});

export function participantErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (PARTICIPANT_ERROR_MESSAGES[code]) return PARTICIPANT_ERROR_MESSAGES[code];
  if (/^(invalid_|response_|recording_|trial_|stimulus_|idempotency_|canonical_)/u.test(code)) {
    return "データまたは課題状態の整合性を確認できないため停止しました。表示されたコードを記録し、担当者へ知らせてください。";
  }
  return error?.message ?? String(error);
}

export function fatalErrorMessage(error, { interruptionRequested = false } = {}) {
  if (!interruptionRequested) return participantErrorMessage(error);
  return [
    "「中断・終了」を押した後、課題を安全に続行できない問題が発生しました。",
    "この画面では、通常完了、一時中断、参加終了のいずれも確認できていません。研究用サーバーがこの試行の回答・録音をどこまで受け付けたかも確認できていません。",
    "担当者から届いた同じ有効な招待リンクを開き直し、参加者IDと氏名を再入力してください。画面が開いたら、新しい試行を始める前に「中断・終了」を選んでください。",
    "同じリンクを開けない場合や状態が分からない場合は、表示されたコードとともに担当者へ連絡してください。",
  ].join("\n\n");
}

export class ExperimentUi {
  constructor() {
    this.welcome = document.getElementById("welcome");
    this.task = document.getElementById("task");
    this.fatalPanel = document.getElementById("fatal");
    this.fatalMessage = document.getElementById("fatal-message");
    this.badge = document.getElementById("connection-badge");
    this.identityForm = document.getElementById("participant-identity-form");
    this.identityParticipantId = document.getElementById("participant-id-input");
    this.identityParticipantName = document.getElementById("participant-name-input");
    this.identitySubmit = document.getElementById("participant-identity-submit");
    this.identityStatus = document.getElementById("participant-identity-status");
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
    this.placeholder = document.getElementById("placeholder-card");
    this.placeholderGloss = document.getElementById("placeholder-gloss");
    this.audioCue = document.getElementById("audio-cue");
    this.recording = document.getElementById("recording-indicator");
    this.responseTimer = document.getElementById("response-timer");
    this.responseTimerLabel = document.getElementById("response-timer-label");
    this.responseTimerValue = document.getElementById("response-timer-value");
    this.responseTimerFill = document.getElementById("response-timer-fill");
    this.message = document.getElementById("stage-message");
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
    this.interruptionHandler = null;
    for (const button of this.interruptionButtons) {
      button.addEventListener("click", () => {
        if (!button.disabled) this.interruptionHandler?.();
      });
    }
    window.addEventListener("pagehide", () => {
      this.stopResponseTimer();
      if (this.identityParticipantName) this.identityParticipantName.value = "";
      if (this.activeDownloadUrl) URL.revokeObjectURL(this.activeDownloadUrl);
    }, { once: true });
  }

  setConnected(state) {
    this.badge.textContent = state ? "接続済み" : "接続エラー";
    this.badge.classList.toggle("error", !state);
  }

  setParticipant(id, visitType) {
    const visitLabel = {
      pre: "事前セッション",
      immediate: "直後セッション",
      delayed: "遅延セッション",
    }[visitType] ?? "実験セッション";
    this.summary.textContent = `参加者ID: ${id}　／　${visitLabel}`;
    this.summary.hidden = false;
  }

  requestParticipantIdentity(message = "") {
    this.participationSetup.hidden = true;
    this.identityForm.hidden = false;
    this.identitySubmit.disabled = false;
    this.identityStatus.textContent = message || "参加者IDと氏名を入力してください。";
    this.welcomeStatus.textContent = "入力内容は本人確認にのみ使用し、このブラウザには保存しません。";
    this.identityParticipantName.value = "";
    this.identityParticipantId.focus();
    return new Promise((resolve) => {
      const onSubmit = (event) => {
        event.preventDefault();
        if (!this.identityForm.reportValidity()) return;
        const participantId = this.identityParticipantId.value.trim();
        const participantName = this.identityParticipantName.value.trim();
        if (!participantId || !participantName) return;
        this.identityForm.removeEventListener("submit", onSubmit);
        this.identitySubmit.disabled = true;
        this.identityStatus.textContent = "招待リンクを確認しています。";
        this.identityParticipantName.value = "";
        resolve({ participant_id: participantId, participant_name: participantName });
      };
      this.identityForm.addEventListener("submit", onSubmit);
    });
  }

  showParticipationSetup() {
    this.identityParticipantName.value = "";
    this.identityParticipantId.value = "";
    this.identityForm.hidden = true;
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
    this.welcome.hidden = true;
    this.task.hidden = false;
    this.task.scrollIntoView({ block: "start" });
  }

  returnToWelcome() {
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
        ? "この試行後に確認"
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
    if (this.activeImageUrl) {
      URL.revokeObjectURL(this.activeImageUrl);
      this.activeImageUrl = null;
    }
    [
      this.fixation,
      this.image,
      this.placeholder,
      this.audioCue,
      this.message,
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
    this.progressTrack.setAttribute("aria-valuenow", String(progress.position));
    this.progressTrack.setAttribute("aria-valuetext", progress.valueText);
    this.progressDetail.textContent = `完了 ${progress.completed}/${progress.total}。回答は各試行後に保存されます。続けられなくなった場合は「中断・終了」を選んでください。`;
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
      ? "データ保存：同期中…"
      : state === "queued"
        ? "データ保存：未送信あり"
        : "データ保存：この時点まで完了";
  }

  async prompt(message, buttonLabel = "続ける") {
    this.resetStage();
    this.message.textContent = message;
    this.message.hidden = false;
    this.continueButton.textContent = buttonLabel;
    this.continueButton.hidden = false;
    await new Promise((resolve) => {
      const cleanup = () => {
        document.removeEventListener("keydown", onKey);
        this.continueButton.removeEventListener("click", onClick);
      };
      const finish = () => {
        if (this.activePromptFinish !== finish) return;
        this.activePromptFinish = null;
        cleanup();
        resolve();
      };
      const onClick = () => finish();
      const onKey = (event) => {
        if (event.code !== "Space" && event.key !== "Enter") return;
        if (![this.continueButton, this.stage, document.body].includes(event.target)) return;
        event.preventDefault();
        finish();
      };
      this.continueButton.addEventListener("click", onClick);
      document.addEventListener("keydown", onKey);
      this.activePromptFinish = finish;
      this.continueButton.focus();
    });
  }

  chooseInterruptionMode() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
    this.interruptionChoiceTitle.textContent = "課題を中断・終了しますか？";
    this.interruptionChoiceDescription.textContent = "一時中断は、同じ招待リンクから研究用サーバーが受け付けた位置へ戻れます。参加終了を選ぶと、これ以降の課題には参加せず、再開できません。送信待ちデータがあれば、確定前に送信を試みます。";
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
    this.interruptionChoiceDescription.textContent = `${message}\n\n通信を再試行できます。いま再試行しない場合も、確定済みとは表示せず、担当者へ伝えるための確認コードを次の画面に表示します。`;
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
    this.interruptionChoiceDescription.textContent = "送信待ちの回答または録音を研究用サーバーで確認できないため、再開可能な一時中断として確定できません。参加終了へ切り替えると、server受付済みデータだけを保持して以後の課題を終了します。切り替えない場合は未確定のまま担当者へ連絡してください。";
    this.pauseParticipationButton.hidden = true;
    this.terminateParticipationButton.textContent = "参加終了へ切り替える";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "切り替えず案内を見る";
    this.interruptionChoice.hidden = false;
    this.terminateParticipationButton.focus();
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
    this.interruptionChoiceDescription.textContent = "前回の回答または録音に、再送しても解消できない問題があります。このまま通常再開や一時中断には進めません。参加終了を選ぶと、研究用サーバーが受け付け済みのデータだけを保持して以後の課題を終了します。終了を選ばない場合は、このまま担当者へ連絡してください。";
    this.pauseParticipationButton.hidden = true;
    this.terminateParticipationButton.textContent = "受付済みデータで参加を終了する";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "終了せず担当者へ連絡する";
    this.interruptionChoice.hidden = false;
    this.terminateParticipationButton.focus();
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
      ? "送信待ちの回答と録音を研究用サーバーへ送り、一時中断を確定しています。"
      : "送信待ちの回答と録音を研究用サーバーへ送り、参加終了を確定しています。";
    this.message.hidden = false;
    this.setTaskStatus("通信が完了すると、安全に閉じられることをお知らせします。");
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
      ? "一部の送信待ち録音を確認できませんでした。研究用サーバーが受け付け済みのデータだけが保持されます。"
      : "研究用サーバーが受け付けた回答と録音は保持されます。";
    this.saveState.textContent = partialData ? "一部未確認・参加終了受付済み" : "サーバー受付済み";
    this.saveState.classList.toggle("pending", partialData);
    this.message.textContent = mode === "pause"
      ? "一時中断を研究用サーバーで確認しました。このページは閉じて構いません。再開するときは、担当者から届いた元の招待リンクを開いてください。"
      : partialData
        ? "参加終了を研究用サーバーで確認しました。一部の録音は送信を確認できなかったため、研究用サーバーがすでに受け付けたデータだけが保持されます。ブラウザ内の送信待ちデータは削除していません。このページは閉じて構いません。"
        : "参加終了を研究用サーバーで確認しました。研究用サーバーが受け付けたデータは保持されます。このページは閉じて構いません。参加終了後は、この招待リンクから課題を再開できません。";
    this.message.hidden = false;
    this.stage.focus();
  }

  async confirmTerminationWithPartialData() {
    await this.prompt(
      "一部の回答または録音を研究用サーバーへ送信できない、あるいはローカル録音を確認できない状態です。参加終了を確定すると、研究用サーバーがすでに受け付けたデータだけが保持されます。ブラウザ内の送信待ちデータは削除しません。",
      "サーバー受付済みデータで参加終了を確定",
    );
  }

  interruptionUnconfirmed(mode, requestId) {
    this.resetStage();
    for (const button of this.interruptionButtons) {
      button.disabled = true;
      button.textContent = "確定未確認";
    }
    this.progressLabel.textContent = mode === "pause" ? "一時中断：未確定" : "参加終了：未確定";
    this.progressTrack.setAttribute("aria-valuetext", "中断または参加終了の確定を未確認");
    this.progressDetail.textContent = "研究用サーバーでの確定を確認できませんでした。送信待ちデータが残っている可能性があります。";
    this.saveState.textContent = "保存・確定：未確認";
    this.saveState.classList.add("pending");
    this.message.textContent = [
      mode === "pause"
        ? "一時中断はまだ確定したものとして扱わないでください。"
        : "参加終了はまだ確定したものとして扱わないでください。",
      "このページは閉じて構いません。表示された確認コードを記録し、担当者へ知らせてください。",
      `確認コード: ${requestId}`,
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
      "研究用サーバーへの保存は完了しています。",
      "Pre・直後・遅延の3セッションの回答データと録音を、1つのZIPとしてこのパソコンにも保存してください。",
      "このZIPは研究用サーバー保存の代替ではありません。",
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
      "研究用サーバーへの保存は完了しています。",
      "Pre・直後・遅延の3セッションの回答データと録音を、このパソコンにもZIPで保存します。",
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
    this.stopResponseTimer();
    if (preserveDownload) {
      [
        this.fixation,
        this.image,
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
    this.progressTrack.setAttribute("aria-valuetext", "セッションの全試行と録音の保存完了");
    this.progressLabel.textContent = "セッション完了";
    this.message.textContent = message;
    this.message.hidden = false;
    if (preserveDownload && this.activeDownloadUrl) {
      this.downloadLink.hidden = false;
    } else if (preserveDownload) {
      this.continueButton.textContent = "ZIPをもう一度保存";
      this.continueButton.hidden = false;
      this.continueButton.addEventListener("click", () => window.location.reload(), { once: true });
    }
    this.progressDetail.textContent = "全試行・録音の保存完了を研究用サーバーで確認しました。";
    this.saveState.textContent = "全試行・録音の保存完了";
    this.saveState.classList.remove("pending");
  }

  fatal(error, { interruptionRequested = false } = {}) {
    this.stopResponseTimer();
    this.welcome.hidden = true;
    this.task.hidden = true;
    this.fatalPanel.hidden = false;
    const code = error?.code ? `（${error.code}）` : "";
    this.fatalMessage.textContent = `${fatalErrorMessage(error, {
      interruptionRequested,
    })} ${code}`.trim();
    this.fatalPanel.focus();
  }
}
