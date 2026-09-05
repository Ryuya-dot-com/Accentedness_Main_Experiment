export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalPositiveInteger(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) return null;
  const numeric = Number(text);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
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
  const percent = total > 0 ? completed / total * 100 : 0;
  const roundedPercent = Math.round(percent);
  return {
    completed,
    total,
    inProgress: Boolean(inProgress && completed < total),
    percent,
    valueText: `進み具合 ${roundedPercent}パーセント`,
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

export function visitAvailabilityMessage(error) {
  const availableAt = error?.details?.available_at_ms;
  const serverNow = error?.details?.server_now_ms;
  if (error?.status !== 403 || error?.code !== "visit_not_available"
      || !Number.isSafeInteger(availableAt) || !Number.isSafeInteger(serverNow)
      || serverNow <= 0 || availableAt <= serverNow) return null;
  // Round display up only; the server remains authoritative for admission.
  const date = new Date(Math.ceil(availableAt / 1000) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const dateLabel = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "long", day: "numeric", weekday: "long",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(date);
  return `この課題は、次の日時以降に開始できます。\n\n${dateLabel}（日本時間）以降\n\nこのページは閉じてかまいません。上の日時以降に、担当者から届いた同じリンクを開き、同じ参加者IDを入力してください。開いたままでも自動では始まりません。`;
}

export function participantCopyCompletionMessage(
  { visitType = "delayed", alreadyCompleted = false, filename = "accentedness_results.zip" } = {},
) {
  const safeFilename = /^[A-Za-z0-9._-]+\.zip$/u.test(String(filename))
    ? String(filename)
    : "accentedness_results.zip";
  const label = { pre: "事前テスト", immediate: "直後テスト", delayed: "遅延テスト" }[visitType];
  const completion = alreadyCompleted
    ? `${label}は終了しています。回答と録音も保存済みです。`
    : `${label}は終了し、回答と録音は保存されました。`;
  const nextStep = visitType === "pre"
    ? "単語学習のリンクは担当者から別途お送りします。"
    : visitType === "immediate"
      ? "遅延テストの案内をお待ちください。"
      : "ご協力ありがとうございました。";
  const storageGuidance = visitType === "delayed" ? ""
    : "すべての課題が終わるまで、ZIPを開いたり録音を聞き返したりせずに保管してください。";
  return `${completion}${nextStep}\n\nここまでの回答と録音を含むZIPの自動ダウンロードを開始しました。Chromeのダウンロード一覧で「${safeFilename}」の完了を確認してください。開始されない・確認できない場合は、下のリンクからもう一度ダウンロードできます。\n\n${storageGuidance}ZIPには参加者IDと録音が含まれます。他の人へ共有しないでください。共用パソコンでは、担当者の案内に従い他の利用者に見えない場所へ移動するか削除してください。`;
}

export function validateBrowserEnvironment({ microphone, persistentStorage = true }) {
  const failures = [];
  const userAgent = navigator.userAgent ?? "";
  const isChrome = /Chrome\//u.test(userAgent) && !/Edg\/|OPR\/|CriOS/u.test(userAgent);
  const isMobile = /Android|iPhone|iPad|Mobile/u.test(userAgent);
  if (!isChrome) failures.push("パソコン版Google Chromeで開いてください。");
  if (isMobile) failures.push("スマートフォンやタブレットでは実施できません。パソコンを使用してください。");
  if (!window.isSecureContext) failures.push("安全なHTTPS接続で開いてください。");
  if (persistentStorage && !window.indexedDB) {
    failures.push("このブラウザでは一時保存機能を利用できません。");
  }
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
  participant_not_registered: "この参加者IDの事前課題を確認できません。先に事前課題を実施してください。",
  pre_not_completed: "先に事前課題を完了してください。完了済みの場合は担当者へ連絡してください。",
  immediate_not_completed: "先に本実験と直後の課題を完了してください。完了済みの場合は担当者へ連絡してください。",
  delayed_not_scheduled: "後日の課題の受付時刻を確認できません。担当者へ連絡してください。",
  reserved_test_participant_id: "この参加者IDは使用できません。担当者から案内されたIDを確認してください。",
  visit_closed: "この課題はすでに終了しています。担当者に知らせてください。",
  visit_not_available: "この課題はまだ開始できません。担当者の案内後に開き直してください。",
  invalid_session: "この画面の情報を確認できません。同じ課題ページを開き直してください。",
  session_expired: "この画面の有効時間が切れました。回答期限ではありません。同じ課題ページを開き直すと、続きから再開できます。",
  session_superseded: "別のタブまたは再開操作により、この画面は無効になりました。この画面では続行しないでください。",
  development_participants_blocked: "この開発用画面では通常の参加者IDを使用できません。担当者に知らせてください。",
  production_collection_blocked: "実験環境が本番開始条件を満たしていないため停止しました。担当者に知らせてください。",
  placeholder_assets_disabled: "本番刺激を確認できないため停止しました。担当者に知らせてください。",
  stimulus_asset_missing: "必要な刺激を読み込めないため停止しました。担当者に知らせてください。",
  participant_copy_before_completion: "今回の課題の完了を確認できません。担当者に知らせてください。",
  participant_copy_visits_incomplete: "ここまでの課題の完了を確認できず、結果ファイルを準備できません。担当者に知らせてください。",
  participant_copy_not_ready: "結果ファイルに必要な回答または録音を確認できません。担当者に知らせてください。",
  participant_copy_session_expired: "実験データは保存済みです。このパソコン向けZIPをもう一度取得する場合は、担当者へ依頼してください。",
  participation_termination_pending: "参加終了の処理中です。同じ課題ページを開き直して、終了確認を続けてください。新しい問題は開始されません。",
  local_outbox_inconsistent: "保存待ちの回答を確認できません。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  local_recording_missing: "前回の回答に対応する録音を確認できないため、この課題は完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  local_recording_unreadable: "前回の回答に対応する録音を読み出せないため、この課題は完了しておらず、安全に再開もできません。参加終了を選ばず停止しました。このまま課題を再開せず、お問い合わせ番号を担当者へ知らせてください。",
  request_timeout: "通信がタイムアウトしました。ネットワーク接続を確認し、同じ課題ページを開き直してください。",
  session_storage_unavailable: "このブラウザでは回答を一時保存できません。通常モードのGoogle Chromeで開き直し、担当者に知らせてください。",
  trial_visibility_interrupted: "試行中にこの画面が非表示になったため、課題を停止しました。この回の保存状態は、この画面では確認できません。「同じ課題を開き直す」を押し、同じ参加者IDを入力してください。サーバーで確認できた位置から再開します。この画面では新しい問題に答えないでください。",
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
    "同じ課題ページを開き直し、参加者IDを入力してください。画面が開いたら、新しい問題を始める前に「中断・終了」を選んでください。",
    "同じリンクを開けない場合や状態が分からない場合は、お問い合わせ番号とともに担当者へ連絡してください。",
  ].join("\n\n");
}

export class ExperimentUi {
  constructor() {
    this.welcome = document.getElementById("welcome");
    this.task = document.getElementById("task");
    this.fatalPanel = document.getElementById("fatal");
    this.fatalTitle = document.getElementById("fatal-title");
    this.fatalMessage = document.getElementById("fatal-message");
    this.fatalReload = document.getElementById("fatal-reload");
    this.fatalHelp = document.getElementById("fatal-help");
    this.badge = document.getElementById("connection-badge");
    this.participantIdForm = document.getElementById("participant-id-form");
    this.participantIdHeading = document.getElementById("participant-id-heading");
    this.participantIdGuidance = document.getElementById("participant-id-guidance");
    this.participantIdInput = document.getElementById("participant-id-input");
    this.participantIdSubmit = document.getElementById("participant-id-submit");
    this.participantIdStatus = document.getElementById("participant-id-status");
    this.participantIdConfirmation = document.getElementById("participant-id-confirmation");
    this.participantIdConfirmationHeading = document.getElementById("participant-id-confirmation-heading");
    this.participantIdConfirmationValue = document.getElementById("participant-id-confirmation-value");
    this.participantIdConfirm = document.getElementById("participant-id-confirm");
    this.participantIdEdit = document.getElementById("participant-id-edit");
    this.researcherTokenForm = document.getElementById("researcher-token-form");
    this.researcherTokenInput = document.getElementById("researcher-token-input");
    this.researcherTokenSubmit = document.getElementById("researcher-token-submit");
    this.researcherTokenStatus = document.getElementById("researcher-token-status");
    this.participationSetup = document.getElementById("participation-setup");
    this.summary = document.getElementById("participant-summary");
    this.readyCheck = document.getElementById("ready-check");
    this.startButton = document.getElementById("start-button");
    this.welcomeStatus = document.getElementById("welcome-status");
    this.progressTrack = document.getElementById("progress-track");
    this.progressFill = document.getElementById("progress-fill");
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
    this.activeImageUrl = null;
    this.activeDownloadUrl = null;
    this.responseTimerFrame = null;
    this.responseTimerRun = 0;
    this.activePromptFinish = null;
    this.interruptedPrompt = null;
    this.spaceHeld = false;
    this.interruptionHandler = null;
    this.interruptionControlEnabled = false;
    this.progressIsPractice = true;
    this.saveStateValue = "not_started";
    this.researcherTestMode = false;
    this.fatalReload?.addEventListener("click", () => window.location.reload());
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
    if (state && this.researcherTestMode) {
      this.badge.textContent = "研究者用テスト";
      this.badge.classList.remove("error");
      return;
    }
    this.badge.textContent = state ? "接続済み" : "接続エラー";
    this.badge.classList.toggle("error", !state);
  }

  activateResearcherTestMode(testModeInput, visitType = document.body.dataset.visitType) {
    const resolvedVisitType = testModeInput?.test_run?.visit_type ?? visitType;
    this.researcherTestMode = true;
    this.badge.textContent = "研究者用テスト";
    this.badge.classList.remove("error");
    this.setParticipant("999", resolvedVisitType);
    this.interruptionControlEnabled = false;
    for (const button of this.interruptionButtons) {
      button.hidden = true;
      button.disabled = true;
    }
  }

  setParticipant(id, visitType) {
    const visitLabel = {
      pre: "事前テスト",
      immediate: "直後課題",
      delayed: "遅延テスト",
    }[visitType] ?? "実験課題";
    if (this.researcherTestMode) {
      this.summary.textContent = `研究者用動作確認　／　${visitLabel}`;
    } else {
      this.summary.textContent = `参加者ID: ${id}　／　${visitLabel}`;
    }
    this.summary.hidden = false;
  }

  hideParticipantAccessSteps() {
    this.participantIdForm.hidden = true;
    this.participantIdConfirmation.hidden = true;
    if (this.researcherTokenForm) this.researcherTokenForm.hidden = true;
  }

  clearParticipantAccess() {
    this.participantIdInput.value = "";
    this.participantIdConfirmationValue.textContent = "";
    if (this.researcherTokenInput) this.researcherTokenInput.value = "";
    this.hideParticipantAccessSteps();
  }

  requestParticipantId(message = "", { researcherTest = false } = {}) {
    this.participationSetup.hidden = true;
    this.hideParticipantAccessSteps();
    this.participantIdForm.hidden = false;
    this.participantIdSubmit.disabled = false;
    this.participantIdInput.setAttribute("aria-invalid", "false");
    this.participantIdHeading.textContent = researcherTest
      ? "研究者用動作確認"
      : "参加者IDの確認";
    this.participantIdGuidance.textContent = researcherTest
      ? "参加者IDに「999」と入力してください。"
      : "担当者から案内された参加者IDを入力してください。";
    this.participantIdStatus.textContent = message || (researcherTest
      ? "研究者用の動作確認を開始します。"
      : "担当者から案内された参加者IDを入力してください。");
    this.welcomeStatus.textContent = researcherTest
      ? "この動作確認で行った回答と録音は、実験データとして保存・送信されません。"
      : "参加者IDは担当者から案内された番号を入力してください。";
    this.participantIdInput.focus();
    return new Promise((resolve) => {
      const onSubmit = (event) => {
        event.preventDefault();
        const participantId = this.participantIdInput.value.trim();
        if (researcherTest && participantId !== "999") {
          this.participantIdInput.setAttribute("aria-invalid", "true");
          this.participantIdStatus.textContent = "研究者用の動作確認では、半角数字で「999」と入力してください。";
          this.participantIdInput.focus();
          return;
        }
        if (!researcherTest && canonicalPositiveInteger(participantId) === null) {
          this.participantIdInput.setAttribute("aria-invalid", "true");
          this.participantIdStatus.textContent = "担当者から案内された参加者IDを、半角数字だけで入力してください。先頭に0は付けません。";
          this.participantIdInput.focus();
          return;
        }
        this.participantIdForm.removeEventListener("submit", onSubmit);
        this.participantIdSubmit.disabled = true;
        this.participantIdInput.setAttribute("aria-invalid", "false");
        this.participantIdStatus.textContent = researcherTest
          ? "研究者用テストモードを準備しています。"
          : "参加者IDを確認しています。";
        resolve(participantId);
      };
      this.participantIdForm.addEventListener("submit", onSubmit);
    });
  }

  requestResearcherToken(message = "") {
    this.hideParticipantAccessSteps();
    this.researcherTokenInput.value = "";
    this.researcherTokenInput.setAttribute("aria-invalid", message ? "true" : "false");
    this.researcherTokenStatus.textContent = message
      || "ID 999の回答と録音は保存・送信しません。";
    this.researcherTokenForm.hidden = false;
    this.researcherTokenSubmit.disabled = false;
    this.researcherTokenInput.focus();
    return new Promise((resolve) => {
      const onSubmit = (event) => {
        event.preventDefault();
        const token = this.researcherTokenInput.value;
        if (!token) {
          this.researcherTokenInput.setAttribute("aria-invalid", "true");
          this.researcherTokenStatus.textContent = "管理トークンを入力してください。";
          this.researcherTokenInput.focus();
          return;
        }
        this.researcherTokenForm.removeEventListener("submit", onSubmit);
        this.researcherTokenSubmit.disabled = true;
        this.researcherTokenInput.setAttribute("aria-invalid", "false");
        this.researcherTokenInput.value = "";
        this.researcherTokenStatus.textContent = "実素材を読み込んでいます。";
        resolve(token);
      };
      this.researcherTokenForm.addEventListener("submit", onSubmit);
    });
  }

  confirmParticipantId(participantId) {
    this.hideParticipantAccessSteps();
    this.participantIdConfirmationValue.textContent = String(participantId);
    this.participantIdConfirmation.hidden = false;
    this.participantIdConfirm.disabled = false;
    this.participantIdEdit.disabled = false;
    this.participantIdConfirmationHeading.focus();
    return new Promise((resolve) => {
      const finish = (decision) => {
        this.participantIdConfirm.removeEventListener("click", onConfirm);
        this.participantIdEdit.removeEventListener("click", onEdit);
        this.participantIdConfirm.disabled = true;
        this.participantIdEdit.disabled = true;
        this.participantIdConfirmation.hidden = true;
        this.participantIdConfirmationValue.textContent = "";
        resolve(decision);
      };
      const onConfirm = () => finish("confirm");
      const onEdit = () => finish("edit");
      this.participantIdConfirm.addEventListener("click", onConfirm);
      this.participantIdEdit.addEventListener("click", onEdit);
    });
  }

  showParticipationSetup() {
    this.clearParticipantAccess();
    this.participationSetup.hidden = false;
    if (this.welcomeInterruptionButton) {
      this.welcomeInterruptionButton.hidden = this.researcherTestMode;
      this.welcomeInterruptionButton.disabled = this.researcherTestMode;
    }
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
      button.disabled = this.researcherTestMode || !this.interruptionControlEnabled;
      if (this.researcherTestMode) button.hidden = true;
    }
  }

  releaseActivePromptForInterruption() {
    this.activePromptFinish?.("interrupt");
  }

  setInterruptionControlEnabled(enabled) {
    this.interruptionControlEnabled = Boolean(enabled) && !this.researcherTestMode;
    for (const button of this.interruptionButtons) {
      button.disabled = !this.interruptionControlEnabled;
      button.textContent = "中断・終了";
      if (this.researcherTestMode || !this.interruptionControlEnabled) button.hidden = true;
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
      this.interruptionButton,
      this.progressTrack,
    ]
      .forEach((element) => { if (element) element.hidden = true; });
    if (this.continueButton) this.continueButton.disabled = false;
    if (this.recording) this.recording.hidden = true;
  }

  showFixation() {
    this.resetStage();
    this.fixation.hidden = false;
    if (this.progressTrack && !this.progressIsPractice) {
      this.progressTrack.hidden = false;
    }
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

  setTaskStatus() {}

  updateProgress(label, completed, total, options = {}) {
    const progress = progressState(label, completed, total, options);
    this.progressIsPractice = options.practice === true;
    this.progressFill.style.width = `${progress.percent.toFixed(2)}%`;
    this.progressTrack.setAttribute("aria-valuemax", "100");
    this.progressTrack.setAttribute("aria-valuenow", progress.percent.toFixed(2));
    this.progressTrack.setAttribute("aria-valuetext", progress.valueText);
    const fixationVisible = this.fixation?.hidden === false;
    this.progressTrack.hidden = this.progressIsPractice || !fixationVisible;
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
    this.saveStateValue = this.researcherTestMode ? "not_persisted" : state;
  }

  async prompt(message, buttonLabel = "続ける", { allowInterruption = true } = {}) {
    this.resetStage();
    this.interruptedPrompt = { message: String(message), buttonLabel: String(buttonLabel) };
    this.stage.classList?.add("prompt-active");
    this.message.textContent = message;
    this.message.hidden = false;
    this.promptKeyboardHint.textContent = `キーボードのスペースキーを1回押すと「${buttonLabel}」へ進みます。クリックや他のキーでは進みません。`;
    this.promptKeyboardHint.hidden = false;
    this.continueKeyLabel.textContent = "Space";
    this.continueKeyLabel.hidden = false;
    if (allowInterruption
        && this.interruptionButton
        && this.interruptionControlEnabled
        && !this.researcherTestMode) {
      this.interruptionButton.textContent = "中断・終了";
      this.interruptionButton.disabled = false;
      this.interruptionButton.hidden = false;
    }
    this.stage.setAttribute("aria-keyshortcuts", "Space");
    await new Promise((resolve) => {
      const cleanup = () => {
        document.removeEventListener("keydown", onKey);
        this.stage.removeAttribute("aria-keyshortcuts");
      };
      const finish = (reason = "continue") => {
        if (this.activePromptFinish !== finish) return;
        this.activePromptFinish = null;
        cleanup();
        if (reason !== "interrupt") this.interruptedPrompt = null;
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
        finish("continue");
      };
      document.addEventListener("keydown", onKey);
      this.activePromptFinish = finish;
      this.stage.focus({ preventScroll: true });
    });
  }

  async chooseInterruptionMode() {
    const promptToResume = this.interruptedPrompt;
    this.resetStage();
    for (const button of this.interruptionButtons) button.disabled = true;
    this.interruptionChoiceTitle.textContent = "課題を中断・終了しますか？";
    this.interruptionChoiceDescription.textContent = "一時中断すると、ここまでを保存し、同じ課題ページから続きに戻れます。参加終了を選ぶと、実験への参加を終え、再開できません。";
    this.pauseParticipationButton.textContent = "一時中断する";
    this.pauseParticipationButton.hidden = false;
    this.terminateParticipationButton.textContent = "参加を終了する";
    this.terminateParticipationButton.hidden = false;
    this.cancelInterruptionButton.textContent = "課題に戻る";
    this.interruptionChoice.hidden = false;
    this.pauseParticipationButton.focus();
    const mode = await new Promise((resolve) => {
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
    if (mode) {
      this.interruptedPrompt = null;
      return mode;
    }
    if (promptToResume) {
      await this.prompt(promptToResume.message, promptToResume.buttonLabel, {
        allowInterruption: false,
      });
    }
    return null;
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
    this.message.textContent = mode === "pause"
      ? "一時中断が完了しました。このページは閉じて構いません。再開するときは、同じ課題ページを開いてください。"
      : partialData
        ? "参加終了が完了しました。一部の録音は保存できませんでしたが、すでに保存できたデータは残ります。このページは閉じて構いません。"
        : "参加終了が完了しました。ここまでのデータは保存されています。このページは閉じて構いません。参加終了後は課題を再開できません。";
    this.message.hidden = false;
    this.stage.focus();
  }

  async confirmTerminationWithPartialData() {
    this.resetStage();
    this.setInterruptionControlEnabled(false);
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

  downloadParticipantCopy({ blob, filename }) {
    this.resetStage();
    if (this.activeDownloadUrl) URL.revokeObjectURL(this.activeDownloadUrl);
    this.activeDownloadUrl = URL.createObjectURL(blob);
    this.downloadLink.href = this.activeDownloadUrl;
    this.downloadLink.download = filename;
    this.downloadLink.textContent = "ZIPをもう一度ダウンロード";
    this.downloadLink.hidden = false;
    this.downloadLink.click();
    this.downloadLink.focus();
  }

  completed(message, { preserveDownload = false } = {}) {
    document.body.classList.remove("experiment-active");
    this.stage.classList.add("completed");
    this.stopResponseTimer();
    if (this.researcherTestMode) {
      this.resetStage();
      this.message.textContent = message;
      this.message.hidden = false;
      return;
    }
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
    this.message.textContent = message;
    this.message.hidden = false;
    if (preserveDownload && this.activeDownloadUrl) {
      this.downloadLink.hidden = false;
    }
  }

  fatal(error, { interruptionRequested = false } = {}) {
    document.body.classList.remove("experiment-active");
    this.stopResponseTimer();
    this.welcome.hidden = true;
    this.task.hidden = true;
    const availability = !this.researcherTestMode && !interruptionRequested
      ? visitAvailabilityMessage(error) : null;
    this.fatalTitle.textContent = availability
      ? "まだ開始時刻になっていません" : "課題を続行できません";
    this.fatalPanel.classList.toggle("error-card", !availability);
    this.fatalPanel.setAttribute("role", availability ? "region" : "alert");
    this.fatalPanel.hidden = false;
    if (availability) {
      this.fatalMessage.textContent = availability;
      this.fatalReload.hidden = false;
      this.fatalReload.textContent = "受付状況を確認する";
      this.fatalHelp.textContent = "確認するときは、もう一度同じ参加者IDを入力してください。上の日時を過ぎても開始できない場合は、この画面の内容を担当者へ知らせてください。";
      this.fatalPanel.focus();
      return;
    }
    const supportCode = participantSupportCode(error);
    const visibilityInterrupted = error?.code === "trial_visibility_interrupted";
    const message = this.researcherTestMode
      ? visibilityInterrupted
        ? "研究者用動作確認中、試行中にこの画面が非表示になったため停止しました。この回を含む回答と録音は保存・送信されていません。「動作確認を最初からやり直す」を押し、参加者ID「999」と管理トークンをもう一度入力してください。再開後は、試行中、この画面を表示したままにしてください。"
        : "研究者用動作確認を続けられない問題が発生しました。回答と録音は保存・送信されていません。「動作確認を最初からやり直す」を押し、参加者ID「999」と管理トークンをもう一度入力してください。"
      : fatalErrorMessage(error, { interruptionRequested });
    this.fatalMessage.textContent = `${message}\n\nお問い合わせ番号: ${supportCode}`;
    const canReload = this.researcherTestMode || visibilityInterrupted;
    if (this.fatalReload) {
      this.fatalReload.hidden = !canReload;
      this.fatalReload.textContent = this.researcherTestMode
        ? "動作確認を最初からやり直す"
        : "同じ課題を開き直す";
    }
    if (this.fatalHelp) {
      this.fatalHelp.textContent = canReload
        ? "開き直せない場合や同じ問題が繰り返される場合は、お問い合わせ番号と画面の状況を担当者へ知らせてください。"
        : "お問い合わせ番号と画面の状況を担当者へ知らせてください。";
    }
    this.fatalPanel.focus();
  }
}
