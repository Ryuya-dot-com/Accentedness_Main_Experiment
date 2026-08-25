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
  session_expired: "安全のため一時セッションを更新します。参加期限ではありません。担当者から届いた同じ招待リンクを開き直すと、保存済み位置から再開できます。",
  session_superseded: "別のタブまたは再開操作により、この画面は無効になりました。この画面では続行しないでください。",
  production_collection_blocked: "実験環境が本番開始条件を満たしていないため停止しました。担当者に知らせてください。",
  placeholder_assets_disabled: "本番刺激を確認できないため停止しました。担当者に知らせてください。",
  stimulus_asset_missing: "必要な刺激を読み込めないため停止しました。担当者に知らせてください。",
  participant_copy_before_completion: "研究用サーバーで遅延セッションの完了を確認できません。担当者に知らせてください。",
  participant_copy_visits_incomplete: "3回分の結果コピーを準備できません。研究用サーバーのvisit状態を担当者に確認してもらってください。",
  participant_copy_not_ready: "3回分の回答または録音が研究用サーバーで不足しています。担当者に知らせてください。",
  participant_copy_session_expired: "実験データは研究用サーバーに保存済みです。このパソコン向けZIPの再取得は、研究担当者へ依頼してください。",
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
    this.downloadLink = document.getElementById("download-link");
    this.taskStatus = document.getElementById("task-status");
    this.activeImageUrl = null;
    this.activeDownloadUrl = null;
    window.addEventListener("pagehide", () => {
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
    [
      this.fixation,
      this.image,
      this.placeholder,
      this.audioCue,
      this.message,
      this.continueButton,
      this.downloadLink,
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
    this.downloadLink.hidden = false;
    await new Promise((resolve) => {
      this.downloadLink.addEventListener("click", () => {
        window.setTimeout(resolve, 0);
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
    this.message.textContent = message;
    this.message.hidden = false;
    if (preserveDownload && this.activeDownloadUrl) {
      this.downloadLink.hidden = false;
    } else if (preserveDownload) {
      this.continueButton.textContent = "ZIPをもう一度保存";
      this.continueButton.hidden = false;
      this.continueButton.addEventListener("click", () => window.location.reload(), { once: true });
    }
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
