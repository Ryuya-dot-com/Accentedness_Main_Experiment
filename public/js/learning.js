import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import { ExperimentRunner } from "./runner.js";
import { ExperimentUi, validateBrowserEnvironment } from "./ui.js";

const ui = new ExperimentUi();
const api = new ExperimentApi("immediate");
const audio = new ExperimentAudio(api);
let runner = null;

function redirectToCanonical(state) {
  if (!state.next_route) return false;
  const current = window.location.pathname.replace(/\/+$/u, "") || "/";
  const expected = state.next_route.replace(/\/+$/u, "") || "/";
  if (current === expected) return false;
  window.location.replace(state.next_route);
  return true;
}

async function main() {
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
  if (redirectToCanonical(state)) return;
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
  await ui.prompt("ヘッドホンの音量を確認します。次の短い確認音が聞こえる音量に調整してください。", "確認音を再生");
  await audio.playCalibrationTone();
  await ui.prompt("確認音がはっきり聞こえたら続けてください。聞こえない場合は担当者に知らせてください。", "続ける");
  await ui.prompt(
    "これから学習を始めます。\n絵を見ながら、750ミリ秒後に流れる英単語をよく聞いて覚えてください。\n24試行ごとに休憩があります。",
    "開始",
  );
  for (let trialIndex = 0; trialIndex < remaining.length; trialIndex += 1) {
    const trial = remaining[trialIndex];
    const nextTrial = remaining[trialIndex + 1] ?? null;
    const completed = learningTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("語彙学習", completed, learningTrials.length);
    ui.setTaskStatus("教材を準備しています。");
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
  ui.completed("学習が終了し、すべて保存されました。これから直後テストへ進みます。");
  await ui.prompt("直後テストでは、絵を見て英単語を答え、その後、音声を聞いて日本語訳を答えます。", "直後テストを開く");
  audio.close();
  window.location.assign("/immediate-picture-naming/");
}

main().catch((error) => {
  runner?.stopMonitoring();
  ui.setConnected(false);
  ui.fatal(error);
  audio.close();
});

window.addEventListener("pagehide", () => audio.close(), { once: true });
