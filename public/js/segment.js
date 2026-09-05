import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import {
  bootstrapTaskAccess,
  microphoneCheckStorageKey,
  redirectToCanonical,
  waitForStartOrParticipantExit,
} from "./flow-guards.js";
import { ExperimentRunner, ParticipantExitRequested } from "./runner.js";
import { ResearcherTestRunner } from "./test-mode.js";
import {
  ExperimentUi,
  participantCopyCompletionMessage,
  participantGuidanceError,
  validateBrowserEnvironment,
} from "./ui.js";

const expectedVisit = document.body.dataset.visitType;
const expectedSegment = document.body.dataset.segment;
if (!new Set(["pre", "immediate", "delayed"]).has(expectedVisit)) {
  throw new Error("Visit configuration is invalid");
}
if (!new Set(["picture_naming", "l2_to_l1"]).has(expectedSegment)) {
  throw new Error("Segment configuration is invalid");
}

const ui = new ExperimentUi();
let api = null;
let audio = null;
let runner = null;

const copy = {
  picture_naming: {
    title: "絵を見て英単語を答える課題",
    responseRule: "絵が出たら、答えが分かった時点ですぐに、英単語だけを1回はっきり答えてください。\n「えーと」「うーんと」「あっ」などの前置きや言い直しはしないでください。分からないときは、何も言わずに待ってください。\n10秒後に自動で次へ進みます。",
    fixationStatus: "中央の＋を見て、次の絵に備えてください。",
  },
  l2_to_l1: {
    title: "英語を聞いて日本語で答える課題",
    responseRule: "英語を最後まで聞き、意味が分かった時点ですぐに、日本語の答えだけを1回はっきり答えてください。\n「えーと」「うーんと」「あっ」などの前置きや言い直しはしないでください。分からないときは、何も言わずに待ってください。\n音声が終わってから10秒後に自動で次へ進みます。",
    fixationStatus: "中央の＋を見て、次の英語音声に備えてください。",
  },
}[expectedSegment];

async function finishVisit({ alreadyCompleted = false } = {}) {
  ui.setInterruptionControlEnabled(false);
  runner.stopMonitoring();
  audio.close();
  await runner.completeVisitWithRetry();
  if (api.isTestMode) {
    ui.completed("この画面の動作確認が終了しました。回答と録音は保存・送信されていません。別の画面を確認する場合は、そのURLを開いて参加者IDに「999」と入力してください。");
    return;
  }
  ui.resetStage();
  ui.setTaskStatus("回答と録音は保存済みです。ZIPを準備しています。画面を閉じないでください。");
  const archive = await runner.prepareParticipantCopyWithRetry();
  ui.downloadParticipantCopy(archive);
  ui.completed(participantCopyCompletionMessage({
    visitType: expectedVisit,
    alreadyCompleted,
    filename: archive.filename,
  }), { preserveDownload: true });
}

async function runMicrophoneCheck(state) {
  const checkKey = api.isTestMode
    ? null
    : microphoneCheckStorageKey(state, expectedSegment);
  if (checkKey && sessionStorage.getItem(checkKey) === "yes") return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await ui.prompt("マイク確認を行います。次の画面で「テスト」と普段の声で話してください。", "録音を開始");
    await runner.handleParticipantExit();
    ui.showAudioCue();
    ui.setRecording(true);
    ui.setTaskStatus("「テスト」と話してください。");
    const recording = await audio.microphoneCheck(2500);
    ui.setRecording(false);
    await runner.handleParticipantExit();
    const tooQuiet = recording.quality.rms_amplitude < 0.008;
    const clipped = recording.quality.clipping_ratio > 0.01;
    const warning = tooQuiet
      ? "音量が小さい可能性があります。マイクに少し近づいてください。"
      : clipped
        ? "音量が大きすぎる可能性があります。マイクから少し離れてください。"
        : "音量を確認できました。";
    await ui.prompt(`${warning}\n録音を再生して確認します。`, "再生");
    await runner.handleParticipantExit();
    await audio.playBlob(recording.blob);
    await runner.handleParticipantExit();
    if (!tooQuiet && !clipped) {
      await ui.prompt("自分の声が聞こえたら続けてください。聞こえない場合は担当者に知らせてください。");
      await runner.handleParticipantExit();
      if (checkKey) sessionStorage.setItem(checkKey, "yes");
      return;
    }
    if (attempt === 1) {
      await ui.prompt("マイク位置を調整して、もう一度確認してください。", "再確認");
      await runner.handleParticipantExit();
    }
  }
  throw new Error("マイク音量を確認できませんでした。担当者に知らせてください。");
}

async function main() {
  const realApi = new ExperimentApi(expectedVisit);
  const failures = validateBrowserEnvironment({
    microphone: true,
    persistentStorage: false,
  });
  if (failures.length) throw participantGuidanceError(failures.join(" "));
  const requirePersistentParticipantEnvironment = () => {
    const participantFailures = validateBrowserEnvironment({
      microphone: true,
      persistentStorage: true,
    });
    if (participantFailures.length) {
      throw participantGuidanceError(participantFailures.join(" "));
    }
  };
  const access = await bootstrapTaskAccess(realApi, ui, {
    expectedVisitType: expectedVisit,
    expectedSegment,
    beforePersistentParticipantAccess: requirePersistentParticipantEnvironment,
  });
  api = access.api;
  let state = access.state;
  const testMode = access.testMode;
  audio = new ExperimentAudio(api);
  if (redirectToCanonical(state)) return;
  ui.setConnected(true);
  ui.setParticipant(state.participant.id, state.visit.visit_type);
  ui.welcomeStatus.textContent = testMode
    ? "研究者用テストモードです。回答と録音は保存・送信されません。"
    : state.accepted.length
      ? "保存済みの位置から再開できます。"
      : "参加者情報を確認しました。";
  runner = testMode
    ? new ResearcherTestRunner(api, ui, audio, state)
    : new ExperimentRunner(api, ui, audio, state);
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
  state = await runner.reconcileOutbox();
  await runner.handleParticipantExit();
  if (redirectToCanonical(state, { runner, audio })) return;
  const nextTrial = state.manifest.find((trial) => trial.trial_id === state.next_trial_id);
  if (!nextTrial) {
    await finishVisit({ alreadyCompleted: true });
    return;
  }
  if (nextTrial.segment !== expectedSegment) {
    throw new Error("現在の課題段階とURLが一致しません。担当者へ知らせてください。");
  }

  await audio.initialize({ microphone: true });
  await runner.handleParticipantExit();
  await runMicrophoneCheck(state);
  await runner.handleParticipantExit();
  const accepted = runner.acceptedTrialIds();
  const segmentTrials = state.manifest.filter((trial) => trial.segment === expectedSegment);
  const remaining = segmentTrials.filter((trial) => !accepted.has(trial.trial_id));
  const practiceTrials = segmentTrials.filter((trial) => trial.practice);
  const mainTrials = segmentTrials.filter((trial) => !trial.practice);
  let announcedPractice = false;
  let announcedMain = false;

  for (let trialIndex = 0; trialIndex < remaining.length; trialIndex += 1) {
    const trial = remaining[trialIndex];
    const nextWithinSegment = remaining[trialIndex + 1] ?? null;
    const phaseTrials = segmentTrials.filter((candidate) => candidate.practice === trial.practice);
    const completed = phaseTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    const progressLabel = `${copy.title} ${trial.practice ? "練習" : "本番"}`;
    ui.updateProgress(progressLabel, completed, phaseTrials.length, {
      inProgress: true,
      practice: trial.practice,
    });
    if (trial.practice && !announcedPractice) {
      announcedPractice = true;
      runner.resetInterTrialClock();
      const completedPractice = practiceTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
      const practiceLead = completedPractice > 0
        ? "練習を途中から再開します。"
        : "最初に、やさしい英単語で短い練習をします。";
      await ui.prompt(`${practiceLead}\n\n${copy.responseRule}`, completedPractice > 0 ? "練習を再開" : "練習を開始");
      await runner.handleParticipantExit();
    }
    if (!trial.practice && !announcedMain) {
      announcedMain = true;
      runner.resetInterTrialClock();
      const completedMain = mainTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
      const mainLead = completedMain > 0
        ? "本番の途中から再開します。"
        : "練習は終了です。これから本番です。";
      await ui.prompt(
        `${mainLead}\n\n${copy.responseRule}`,
        completedMain > 0 ? "本番を再開" : "本番を開始",
      );
      await runner.handleParticipantExit();
    }
    ui.showFixation();
    ui.setTaskStatus(copy.fixationStatus);
    await runner.handleParticipantExit();
    const loaded = await runner.preloadTrial(trial);
    await runner.handleParticipantExit();
    if (expectedSegment === "picture_naming") {
      await runner.runPictureNamingTrial(trial, loaded, nextWithinSegment);
    } else {
      await runner.runL2Trial(trial, loaded, nextWithinSegment);
    }
    accepted.add(trial.trial_id);
    ui.updateProgress(
      progressLabel,
      phaseTrials.filter((candidate) => accepted.has(candidate.trial_id)).length,
      phaseTrials.length,
      { practice: trial.practice },
    );
    await runner.handleParticipantExit();
  }

  await runner.flushWithRetry();
  await runner.handleParticipantExit();
  state = await api.state();
  await runner.handleParticipantExit();
  if (state.next_route) {
    await ui.prompt("この課題は終わり、ここまでの記録は保存されました。続けて次の課題へ進みます。", "次の課題を開く");
    await runner.handleParticipantExit();
    ui.setInterruptionControlEnabled(false);
    runner.stopMonitoring();
    audio.close();
    window.location.assign(state.next_route);
    return;
  }
  await finishVisit();
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
