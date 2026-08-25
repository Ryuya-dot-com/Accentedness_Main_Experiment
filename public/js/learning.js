import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import {
  bootstrapWithParticipantIdentity,
  redirectToCanonical,
  waitForStartOrParticipantExit,
} from "./flow-guards.js";
import { ExperimentRunner, ParticipantExitRequested } from "./runner.js";
import { ExperimentUi, validateBrowserEnvironment } from "./ui.js";

const ui = new ExperimentUi();
let api = null;
let audio = null;
let runner = null;

async function main() {
  api = new ExperimentApi("immediate");
  audio = new ExperimentAudio(api);
  const failures = validateBrowserEnvironment({ microphone: false });
  if (failures.length) throw new Error(failures.join(" "));
  let state = await bootstrapWithParticipantIdentity(api, ui);
  if (redirectToCanonical(state)) return;
  ui.setConnected(true);
  ui.setParticipant(state.participant.id, state.visit.visit_type);
  ui.welcomeStatus.textContent = state.accepted.length
    ? "保存済みの位置から再開できます。"
    : "招待情報を確認しました。";
  runner = new ExperimentRunner(api, ui, audio, state);
  if (state.participation_control?.interruption?.state === "requested") {
    ui.beginTask();
    runner.startMonitoring();
    await runner.handleParticipantExit();
    return;
  }
  ui.enableStartWhenReady();
  runner.startMonitoring();
  await waitForStartOrParticipantExit(ui, runner);
  ui.beginTask();
  ui.setInterruptionControlEnabled(true);
  await audio.initialize({ microphone: false });
  state = await runner.reconcileOutbox();
  await runner.handleParticipantExit();
  if (redirectToCanonical(state, { runner, audio })) return;
  const accepted = runner.acceptedTrialIds();
  const learningTrials = state.manifest.filter((trial) => trial.segment === "learning");
  const remaining = learningTrials.filter((trial) => !accepted.has(trial.trial_id));
  if (!remaining.length && state.next_trial_id && state.manifest.find((trial) => trial.trial_id === state.next_trial_id)?.segment !== "learning") {
    await ui.prompt("学習は保存済みです。直後テストへ進みます。", "直後テストを開く");
    await runner.handleParticipantExit();
    ui.setInterruptionControlEnabled(false);
    runner.stopMonitoring();
    audio.close();
    window.location.assign("/immediate-picture-naming/");
    return;
  }
  const completedBeforeStart = learningTrials.filter((trial) => accepted.has(trial.trial_id)).length;
  ui.updateProgress("語彙学習", completedBeforeStart, learningTrials.length, {
    inProgress: remaining.length > 0,
  });
  await ui.prompt("ヘッドホンの音量を確認します。次の短い確認音が聞こえる音量に調整してください。", "確認音を再生");
  await runner.handleParticipantExit();
  await audio.playCalibrationTone();
  await runner.handleParticipantExit();
  await ui.prompt("確認音がはっきり聞こえたら続けてください。聞こえない場合は担当者に知らせてください。", "続ける");
  await runner.handleParticipantExit();
  await ui.prompt(
    "これから144試行の学習を始めます。\n中央の＋に続いて絵が5秒間表示され、絵が出てから750ミリ秒後に英単語が流れます。絵と英単語をよく覚えてください。\n各試行は自動で進み、24試行ごとに休憩があります。",
    "開始",
  );
  await runner.handleParticipantExit();
  for (let trialIndex = 0; trialIndex < remaining.length; trialIndex += 1) {
    const trial = remaining[trialIndex];
    const nextTrial = remaining[trialIndex + 1] ?? null;
    const completed = learningTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("語彙学習", completed, learningTrials.length, { inProgress: true });
    ui.showFixation();
    ui.setTaskStatus("中央の＋を見て、次の絵と英単語に備えてください。");
    await runner.handleParticipantExit();
    const loaded = await runner.preloadTrial(trial);
    await runner.handleParticipantExit();
    await runner.runLearningTrial(trial, loaded, nextTrial);
    accepted.add(trial.trial_id);
    const learningCompleted = learningTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("語彙学習", learningCompleted, learningTrials.length);
    await runner.handleParticipantExit();
    if (learningCompleted % 24 === 0 && learningCompleted < learningTrials.length) {
      await ui.prompt(
        `ここで休憩してください。\n現在 ${learningCompleted}/${learningTrials.length} 試行が保存済みです。\n準備ができたら続けてください。`,
        "学習を再開",
      );
      await runner.handleParticipantExit();
      runner.resetInterTrialClock();
    }
  }
  await runner.flushWithRetry();
  await runner.handleParticipantExit();
  ui.updateProgress("語彙学習", learningTrials.length, learningTrials.length);
  ui.setSaveState("saved");
  await ui.prompt("学習144試行は、この時点まで研究用サーバーに保存されました。\n直後テストでは、絵を見て英単語を答え、その後、音声を聞いて日本語訳を答えます。", "直後テストを開く");
  await runner.handleParticipantExit();
  ui.setInterruptionControlEnabled(false);
  runner.stopMonitoring();
  audio.close();
  window.location.assign("/immediate-picture-naming/");
}

main().catch((error) => {
  runner?.stopMonitoring();
  if (error instanceof ParticipantExitRequested) {
    audio?.close();
    return;
  }
  ui.setConnected(false);
  ui.fatal(error, { interruptionRequested: Boolean(runner?.participantExitRequested) });
  audio?.close();
});

window.addEventListener("pagehide", () => audio?.close(), { once: true });
