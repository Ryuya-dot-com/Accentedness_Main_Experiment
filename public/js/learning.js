import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import {
  bootstrapWithParticipantAccess,
  redirectToCanonical,
  waitForStartOrParticipantExit,
} from "./flow-guards.js";
import { ExperimentRunner, ParticipantExitRequested } from "./runner.js";
import { ExperimentUi, participantGuidanceError, validateBrowserEnvironment } from "./ui.js";

const ui = new ExperimentUi();
let api = null;
let audio = null;
let runner = null;

async function main() {
  api = new ExperimentApi("immediate");
  audio = new ExperimentAudio(api);
  const failures = validateBrowserEnvironment({ microphone: false });
  if (failures.length) throw participantGuidanceError(failures.join(" "));
  let state = await bootstrapWithParticipantAccess(api, ui);
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
  const practiceTrials = learningTrials.filter((trial) => trial.practice);
  const mainTrials = learningTrials.filter((trial) => !trial.practice);
  const remainingLearning = learningTrials.filter((trial) => !accepted.has(trial.trial_id));
  if (!remainingLearning.length && state.next_trial_id && state.manifest.find((trial) => trial.trial_id === state.next_trial_id)?.segment !== "learning") {
    await ui.prompt("学習は保存済みです。直後テストへ進みます。", "直後テストを開く");
    await runner.handleParticipantExit();
    ui.setInterruptionControlEnabled(false);
    runner.stopMonitoring();
    audio.close();
    window.location.assign("/immediate-picture-naming/");
    return;
  }
  const completedMainBeforeStart = mainTrials.filter((trial) => accepted.has(trial.trial_id)).length;
  ui.updateProgress("単語学習 本番", completedMainBeforeStart, mainTrials.length, {
    inProgress: mainTrials.some((trial) => !accepted.has(trial.trial_id)),
  });
  await ui.prompt("ヘッドホンの音量を確認します。次の短い確認音が聞こえる音量に調整してください。", "確認音を再生");
  await runner.handleParticipantExit();
  await audio.playCalibrationTone();
  await runner.handleParticipantExit();
  await ui.prompt("確認音がはっきり聞こえたら続けてください。聞こえない場合は担当者に知らせてください。", "続ける");
  await runner.handleParticipantExit();
  const remainingPractice = practiceTrials.filter((trial) => !accepted.has(trial.trial_id));
  if (remainingPractice.length) {
    const completedPractice = practiceTrials.length - remainingPractice.length;
    ui.updateProgress("単語学習 練習", completedPractice, practiceTrials.length, { inProgress: true });
    await ui.prompt(
      completedPractice > 0
        ? `単語の練習は ${completedPractice}/${practiceTrials.length} 回まで終わっています。残り ${remainingPractice.length} 回です。\n中央の＋のあとに絵文字が出て、英単語の音声が流れます。絵文字と英単語の組み合わせを覚えてください。操作は必要なく、自動で次に進みます。`
        : `最初に${practiceTrials.length}回練習します。\n中央の＋のあとに絵文字が出て、英単語の音声が流れます。絵文字と英単語の組み合わせを覚えてください。操作は必要なく、自動で次に進みます。`,
      completedPractice > 0 ? "練習を再開" : "練習を開始",
    );
    await runner.handleParticipantExit();
    for (let trialIndex = 0; trialIndex < remainingPractice.length; trialIndex += 1) {
      const trial = remainingPractice[trialIndex];
      const nextTrial = remainingPractice[trialIndex + 1] ?? null;
      const completed = practiceTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
      ui.updateProgress("単語学習 練習", completed, practiceTrials.length, { inProgress: true });
      ui.showFixation();
      ui.setTaskStatus("中央の＋を見て、次の絵文字と英単語に備えてください。");
      await runner.handleParticipantExit();
      const loaded = await runner.preloadTrial(trial);
      await runner.handleParticipantExit();
      await runner.runLearningTrial(trial, loaded, nextTrial);
      accepted.add(trial.trial_id);
      ui.updateProgress(
        "単語学習 練習",
        practiceTrials.filter((candidate) => accepted.has(candidate.trial_id)).length,
        practiceTrials.length,
      );
      await runner.handleParticipantExit();
    }
    runner.resetInterTrialClock();
  }

  const remainingMain = mainTrials.filter((trial) => !accepted.has(trial.trial_id));
  if (remainingMain.length) {
    const completedMain = mainTrials.length - remainingMain.length;
    ui.updateProgress("単語学習 本番", completedMain, mainTrials.length, { inProgress: true });
    const mainIntroduction = "これから本番を144回行います。\n練習と同じ流れで、中央の＋のあとに絵が出て、英単語が流れます。絵と英単語の組み合わせを覚えてください。\n操作は必要なく自動で進み、24回ごとに休憩できます。";
    await ui.prompt(
      completedMain > 0
        ? `本番は ${completedMain}/${mainTrials.length} 回まで終わっています。\n残り ${remainingMain.length} 回を再開します。中央の＋を見続け、絵と音声が出ている間はキーを押さないでください。`
        : practiceTrials.length > 0
          ? `練習は終了です。${mainIntroduction}`
          : mainIntroduction,
      completedMain > 0 ? "本番を再開" : "本番を開始",
    );
    await runner.handleParticipantExit();
  }
  for (let trialIndex = 0; trialIndex < remainingMain.length; trialIndex += 1) {
    const trial = remainingMain[trialIndex];
    const nextTrial = remainingMain[trialIndex + 1] ?? null;
    const completed = mainTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("単語学習 本番", completed, mainTrials.length, { inProgress: true });
    ui.showFixation();
    ui.setTaskStatus("中央の＋を見て、次の絵と英単語に備えてください。");
    await runner.handleParticipantExit();
    const loaded = await runner.preloadTrial(trial);
    await runner.handleParticipantExit();
    await runner.runLearningTrial(trial, loaded, nextTrial);
    accepted.add(trial.trial_id);
    const learningCompleted = mainTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    ui.updateProgress("単語学習 本番", learningCompleted, mainTrials.length);
    await runner.handleParticipantExit();
    if (learningCompleted % 24 === 0 && learningCompleted < mainTrials.length) {
      await ui.prompt(
        `ここで休憩してください。\n${learningCompleted}/${mainTrials.length} 回まで終わり、ここまでの記録は保存されています。\n準備ができたらスペースキーを1回押してください。`,
        "学習を再開",
      );
      await runner.handleParticipantExit();
      runner.resetInterTrialClock();
    }
  }
  await runner.flushWithRetry();
  await runner.handleParticipantExit();
  ui.updateProgress("単語学習 本番", mainTrials.length, mainTrials.length);
  ui.setSaveState("saved");
  await ui.prompt("単語学習が終わり、ここまでの記録は保存されました。\n続けて、絵を見て英単語を答える直後テストを行います。", "直後テストを開く");
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
