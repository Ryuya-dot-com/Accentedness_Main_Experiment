import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import { redirectToCanonical } from "./flow-guards.js";
import { ExperimentRunner } from "./runner.js";
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
  let state = await api.bootstrap();
  if (redirectToCanonical(state)) return;
  ui.setConnected(true);
  ui.setParticipant(state.participant.id, state.visit.visit_type);
  ui.welcomeStatus.textContent = state.accepted.length
    ? "保存済みの位置から再開できます。"
    : "招待情報を確認しました。";
  ui.enableStartWhenReady();
  await ui.waitForStart();
  await audio.initialize({ microphone: false });
  runner = new ExperimentRunner(api, ui, audio, state);
  ui.beginTask();
  runner.startMonitoring();
  state = await runner.reconcileOutbox();
  if (redirectToCanonical(state, { runner, audio })) return;
  const accepted = runner.acceptedTrialIds();
  const learningTrials = state.manifest.filter((trial) => trial.segment === "learning");
  const remaining = learningTrials.filter((trial) => !accepted.has(trial.trial_id));
  if (!remaining.length && state.next_trial_id && state.manifest.find((trial) => trial.trial_id === state.next_trial_id)?.segment !== "learning") {
    await ui.prompt("学習は保存済みです。直後テストへ進みます。", "直後テストを開く");
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
  await audio.playCalibrationTone();
  await ui.prompt("確認音がはっきり聞こえたら続けてください。聞こえない場合は担当者に知らせてください。", "続ける");
  await ui.prompt(
    "これから144試行の学習を始めます。\n中央の＋に続いて絵が5秒間表示され、絵が出てから750ミリ秒後に英単語が流れます。絵と英単語をよく覚えてください。\n各試行は自動で進み、24試行ごとに休憩があります。",
    "開始",
  );
  for (let trialIndex = 0; trialIndex < remaining.length; trialIndex += 1) {
    const trial = remaining[trialIndex];
    const nextTrial = remaining[trialIndex + 1] ?? null;
    const completed = learningTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("語彙学習", completed, learningTrials.length, { inProgress: true });
    ui.showFixation();
    ui.setTaskStatus("中央の＋を見て、次の絵と英単語に備えてください。");
    const loaded = await runner.preloadTrial(trial);
    await runner.runLearningTrial(trial, loaded, nextTrial);
    accepted.add(trial.trial_id);
    const learningCompleted = learningTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("語彙学習", learningCompleted, learningTrials.length);
    if (learningCompleted % 24 === 0 && learningCompleted < learningTrials.length) {
      await ui.prompt(
        `ここで休憩してください。\n現在 ${learningCompleted}/${learningTrials.length} 試行が保存済みです。\n準備ができたら続けてください。`,
        "学習を再開",
      );
      runner.resetInterTrialClock();
    }
  }
  await runner.flushWithRetry();
  runner.stopMonitoring();
  ui.updateProgress("語彙学習", learningTrials.length, learningTrials.length);
  ui.setSaveState("saved");
  await ui.prompt("学習144試行は、この時点まで研究用サーバーに保存されました。\n直後テストでは、絵を見て英単語を答え、その後、音声を聞いて日本語訳を答えます。", "直後テストを開く");
  audio.close();
  window.location.assign("/immediate-picture-naming/");
}

main().catch((error) => {
  runner?.stopMonitoring();
  ui.setConnected(false);
  ui.fatal(error);
  audio?.close();
});

window.addEventListener("pagehide", () => audio?.close(), { once: true });
