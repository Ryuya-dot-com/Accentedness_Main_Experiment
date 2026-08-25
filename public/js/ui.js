export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  session_expired: "セッションの有効時間が切れました。担当者から届いた招待リンクを開き直してください。",
  session_superseded: "別のタブまたは再開操作により、この画面は無効になりました。この画面では続行しないでください。",
  production_collection_blocked: "実験環境が本番開始条件を満たしていないため停止しました。担当者に知らせてください。",
  placeholder_assets_disabled: "本番刺激を確認できないため停止しました。担当者に知らせてください。",
  stimulus_asset_missing: "必要な刺激を読み込めないため停止しました。担当者に知らせてください。",
});

export function participantErrorMessage(error) {
  const code = String(error?.code ?? "");
  if (PARTICIPANT_ERROR_MESSAGES[code]) return PARTICIPANT_ERROR_MESSAGES[code];
  if (/^(invalid_|response_|recording_|trial_|stimulus_|idempotency_|canonical_)/u.test(code)) {
    return "データまたは課題状態の整合性を確認できないため停止しました。ページを閉じずに担当者へ知らせてください。";
  }
  return error?.message ?? String(error);
}

export class ExperimentUi {
  constructor() {
    this.welcome = document.getElementById("welcome");
    this.task = document.getElementById("task");
    this.fatalPanel = document.getElementById("fatal");
    this.fatalMessage = document.getElementById("fatal-message");
    this.badge = document.getElementById("connection-badge");
    this.summary = document.getElementById("participant-summary");
    this.readyCheck = document.getElementById("ready-check");
    this.startButton = document.getElementById("start-button");
    this.welcomeStatus = document.getElementById("welcome-status");
    this.progressLabel = document.getElementById("progress-label");
    this.progressFill = document.getElementById("progress-fill");
    this.saveState = document.getElementById("save-state");
    this.stage = document.getElementById("stage");
    this.fixation = document.getElementById("fixation");
    this.image = document.getElementById("stimulus-image");
    this.placeholder = document.getElementById("placeholder-card");
    this.placeholderGloss = document.getElementById("placeholder-gloss");
    this.audioCue = document.getElementById("audio-cue");
    this.recording = document.getElementById("recording-indicator");
    this.message = document.getElementById("stage-message");
    this.continueButton = document.getElementById("continue-button");
    this.taskStatus = document.getElementById("task-status");
    this.activeImageUrl = null;
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

  enableStartWhenReady() {
    const update = () => {
      this.startButton.disabled = !this.readyCheck.checked;
    };
    this.readyCheck.addEventListener("change", update);
    update();
  }

  waitForStart() {
    return new Promise((resolve) => {
      this.startButton.addEventListener("click", () => {
        this.startButton.disabled = true;
        resolve();
      }, { once: true });
    });
  }

  beginTask() {
    this.welcome.hidden = true;
    this.task.hidden = false;
  }

  resetStage() {
    if (this.activeImageUrl) {
      URL.revokeObjectURL(this.activeImageUrl);
      this.activeImageUrl = null;
    }
    [this.fixation, this.image, this.placeholder, this.audioCue, this.message, this.continueButton]
      .forEach((element) => { if (element) element.hidden = true; });
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

  updateProgress(label, completed, total) {
    const percent = total > 0 ? Math.max(0, Math.min(100, completed / total * 100)) : 0;
    this.progressLabel.textContent = `${label}　${completed}/${total}`;
    this.progressFill.style.width = `${percent.toFixed(2)}%`;
  }

  setSaveState(state) {
    const pending = state !== "saved";
    this.saveState.classList.toggle("pending", pending);
    this.saveState.textContent = state === "saving" ? "保存中…" : state === "queued" ? "再送待ち" : "保存済み";
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
        cleanup();
        resolve();
      };
      const onClick = () => finish();
      const onKey = (event) => {
        if (event.code !== "Space" && event.key !== "Enter") return;
        event.preventDefault();
        finish();
      };
      this.continueButton.addEventListener("click", onClick);
      document.addEventListener("keydown", onKey);
      this.continueButton.focus();
    });
  }

  completed(message) {
    this.resetStage();
    this.progressFill.style.width = "100%";
    this.message.textContent = message;
    this.message.hidden = false;
    this.saveState.textContent = "完了";
    this.saveState.classList.remove("pending");
  }

  fatal(error) {
    this.welcome.hidden = true;
    this.task.hidden = true;
    this.fatalPanel.hidden = false;
    const code = error?.code ? `（${error.code}）` : "";
    this.fatalMessage.textContent = `${participantErrorMessage(error)} ${code}`.trim();
    this.fatalPanel.focus();
  }
}
