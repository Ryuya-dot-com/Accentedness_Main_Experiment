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
  PARTICIPANT_COPY_DELIVERY,
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

async function saveParticipantCopy() {
  while (true) {
    let fileHandle;
    try {
      fileHandle = await ui.chooseParticipantCopyTarget();
    } catch (error) {
      if (error?.code !== "participant_copy_picker_failed") throw error;
      await ui.prompt(
        "保存先を直接選択できませんでした。通常のダウンロードでZIPの取得を試します。開始後にChromeのダウンロード一覧を確認してください。",
        "通常ダウンロードを試す",
      );
      const archive = await runner.prepareParticipantCopyWithRetry(null);
      const download = await ui.downloadParticipantCopy(archive);
      return { ...archive, ...download };
    }
    try {
      const archive = await runner.prepareParticipantCopyWithRetry(fileHandle);
      if (archive.savedToDisk === true) {
        return {
          ...archive,
          delivery: PARTICIPANT_COPY_DELIVERY.DIRECT_WRITE_CONFIRMED,
        };
      }
      if (archive.blob) {
        const download = await ui.downloadParticipantCopy(archive);
        return { ...archive, ...download };
      }
      throw new TypeError("参加者向けZIPの保存方法を確認できませんでした。");
    } catch (error) {
      if (error?.code !== "participant_copy_file_write_failed") throw error;
      await ui.prompt(
        "選択した場所へZIPを書き込めませんでした。空き容量と保存権限を確認し、別の保存先を選んでください。",
        "別の保存先を選ぶ",
      );
    }
  }
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

async function finalizeAlreadyCompleted(state) {
  ui.setInterruptionControlEnabled(false);
  runner.stopMonitoring();
  audio.close();
  await runner.completeVisitWithRetry();
  const participantCopy = state.visit.visit_type === "delayed"
    ? await saveParticipantCopy()
    : null;
  if (state.visit.visit_type !== "delayed") api.clearSession();
  ui.completed(state.visit.visit_type === "pre"
    ? "事前テストは終了し、回答と録音は保存済みです。単語学習のリンクは担当者から別途お送りします。"
    : state.visit.visit_type === "immediate"
      ? "直後テストは保存済みです。遅延テストの案内をお待ちください。"
      : participantCopyCompletionMessage(participantCopy.delivery, {
        alreadyCompleted: true,
        filename: participantCopy.filename,
      }), {
    preserveDownload: state.visit.visit_type === "delayed",
  });
}

async function main() {
  const realApi = new ExperimentApi(expectedVisit);
  const persistentStorage = realApi.hasInvitationToken() || realApi.hasStoredSession();
  const failures = validateBrowserEnvironment({
    microphone: true,
    persistentStorage,
  });
  if (failures.length) throw participantGuidanceError(failures.join(" "));
  const access = await bootstrapTaskAccess(realApi, ui, {
    expectedVisitType: expectedVisit,
    expectedSegment,
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
      : "招待情報を確認しました。";
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
    await finalizeAlreadyCompleted(state);
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
    ui.updateProgress(progressLabel, completed, phaseTrials.length, { inProgress: true });
    if (trial.practice && !announcedPractice) {
      announcedPractice = true;
      runner.resetInterTrialClock();
      const completedPractice = practiceTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
      const practiceLead = completedPractice > 0
        ? `練習は ${completedPractice}/${practiceTrials.length} 回まで終わっています。残り ${practiceTrials.length - completedPractice} 回を再開します。`
        : `最初に、やさしい英単語で${practiceTrials.length}回練習します。`;
      await ui.prompt(`${practiceLead}\n\n${copy.responseRule}`, completedPractice > 0 ? "練習を再開" : "練習を開始");
      await runner.handleParticipantExit();
    }
    if (!trial.practice && !announcedMain) {
      announcedMain = true;
      runner.resetInterTrialClock();
      const completedMain = mainTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
      const mainLead = completedMain > 0
        ? `本番は ${completedMain}/${mainTrials.length} 回まで終わっています。残り ${mainTrials.length - completedMain} 回を再開します。`
        : `練習は終了です。これから本番を${mainTrials.length}回行います。`;
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
  ui.setInterruptionControlEnabled(false);
  runner.stopMonitoring();
  audio.close();
  await runner.completeVisitWithRetry();
  if (testMode) {
    ui.completed("この画面の動作確認が終了しました。回答と録音は保存・送信されていません。別の画面を確認する場合は、そのURLを開いて参加者IDに「test」と入力してください。");
    return;
  }
  const participantCopy = expectedVisit === "delayed"
    ? await saveParticipantCopy()
    : null;
  if (expectedVisit !== "delayed") api.clearSession();
  ui.completed(expectedVisit === "pre"
    ? "事前テストは終了し、回答と録音は保存されました。単語学習のリンクは担当者から別途お送りします。"
    : expectedVisit === "immediate"
      ? "直後テストは終了し、回答と録音は保存されました。遅延テストの案内をお待ちください。"
      : participantCopyCompletionMessage(participantCopy.delivery, {
        filename: participantCopy.filename,
      }), {
    preserveDownload: expectedVisit === "delayed",
  });
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
