import { ExperimentApi } from "./api.js";
import { ExperimentAudio } from "./audio-engine.js";
import { ExperimentRunner } from "./runner.js";
import { ExperimentUi, validateBrowserEnvironment } from "./ui.js";

const expectedVisit = document.body.dataset.visitType;
const expectedSegment = document.body.dataset.segment;
if (!new Set(["pre", "immediate", "delayed"]).has(expectedVisit)) {
  throw new Error("Visit configuration is invalid");
}
if (!new Set(["picture_naming", "l2_to_l1"]).has(expectedSegment)) {
  throw new Error("Segment configuration is invalid");
}

const ui = new ExperimentUi();
const api = new ExperimentApi(expectedVisit);
const audio = new ExperimentAudio(api);
let runner = null;

const copy = {
  picture_naming: {
    title: "Picture Naming",
    instruction: "絵を見て、対応する英単語を声に出してください。絵が出ると同時に録音が始まり、10秒後に自動で次へ進みます。",
  },
  l2_to_l1: {
    title: "L2-to-L1",
    instruction: "英語音声を聞き、その日本語訳を声に出してください。音声が終わってから10秒間録音します。",
  },
}[expectedSegment];

function redirectToCanonical(state) {
  if (!state.next_route) return false;
  const current = window.location.pathname.replace(/\/+$/u, "") || "/";
  const expected = state.next_route.replace(/\/+$/u, "") || "/";
  if (current === expected) return false;
  window.location.replace(state.next_route);
  return true;
}

async function runMicrophoneCheck(state) {
  const checkKey = `microphone_checked:${state.visit.visit_id}:${state.session.epoch}`;
  if (sessionStorage.getItem(checkKey) === "yes") return;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await ui.prompt("マイク確認を行います。次の画面で「テスト」と普段の声で話してください。", "録音を開始");
    ui.showAudioCue();
    ui.setRecording(true);
    ui.setTaskStatus("「テスト」と話してください。");
    const recording = await audio.microphoneCheck(2500);
    ui.setRecording(false);
    const tooQuiet = recording.quality.rms_amplitude < 0.008;
    const clipped = recording.quality.clipping_ratio > 0.01;
    const warning = tooQuiet
      ? "音量が小さい可能性があります。マイクに少し近づいてください。"
      : clipped
        ? "音量が大きすぎる可能性があります。マイクから少し離れてください。"
        : "音量を確認できました。";
    await ui.prompt(`${warning}\n録音を再生して確認します。`, "再生");
    await audio.playBlob(recording.blob);
    if (!tooQuiet && !clipped) {
      await ui.prompt("自分の声が聞こえたら続けてください。聞こえない場合は担当者に知らせてください。");
      sessionStorage.setItem(checkKey, "yes");
      return;
    }
    if (attempt === 1) await ui.prompt("マイク位置を調整して、もう一度確認してください。", "再確認");
  }
  throw new Error("マイク音量を確認できませんでした。担当者に知らせてください。");
}

async function finalizeAlreadyCompleted(state) {
  await api.completeVisit();
  api.clearSession();
  ui.completed(state.visit.visit_type === "pre"
    ? "Pre Picture Namingは保存済みです。Main Experimentのリンクは担当者から別途お送りします。"
    : state.visit.visit_type === "immediate"
      ? "直後テストは保存済みです。遅延テストの案内をお待ちください。"
      : "遅延テストは保存済みです。ご協力ありがとうございました。");
}

async function main() {
  const failures = validateBrowserEnvironment({ microphone: true });
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
  ui.beginTask();
  runner = new ExperimentRunner(api, ui, audio, state);
  runner.startMonitoring();
  state = await runner.reconcileOutbox();
  if (redirectToCanonical(state)) return;
  const nextTrial = state.manifest.find((trial) => trial.trial_id === state.next_trial_id);
  if (!nextTrial) {
    await finalizeAlreadyCompleted(state);
    runner.stopMonitoring();
    return;
  }
  if (nextTrial.segment !== expectedSegment) {
    throw new Error("現在の課題段階とURLが一致しません。担当者へ知らせてください。");
  }

  await audio.initialize({ microphone: true });
  await runMicrophoneCheck(state);
  const accepted = runner.acceptedTrialIds();
  const segmentTrials = state.manifest.filter((trial) => trial.segment === expectedSegment);
  const remaining = segmentTrials.filter((trial) => !accepted.has(trial.trial_id));
  let announcedPractice = false;
  let announcedMain = false;

  for (let trialIndex = 0; trialIndex < remaining.length; trialIndex += 1) {
    const trial = remaining[trialIndex];
    const nextWithinSegment = remaining[trialIndex + 1] ?? null;
    if (trial.practice && !announcedPractice) {
      announcedPractice = true;
      runner.resetInterTrialClock();
      await ui.prompt(`${copy.title}\n\n${copy.instruction}`, "練習を開始");
    }
    if (!trial.practice && !announcedMain) {
      announcedMain = true;
      runner.resetInterTrialClock();
      await ui.prompt(
        announcedPractice
          ? `${copy.title} の練習は終了です。\nこれから本番24試行を行います。`
          : `${copy.title}\n\n${copy.instruction}\n\n保存済みの位置から本番を再開します。`,
        announcedPractice ? "本番を開始" : "本番を再開",
      );
    }
    const phaseTrials = segmentTrials.filter((candidate) => candidate.practice === trial.practice);
    const completed = phaseTrials.filter((candidate) => accepted.has(candidate.trial_id)).length;
    const progressLabel = `${copy.title} ${trial.practice ? "練習" : "本番"}`;
    ui.updateProgress(progressLabel, completed, phaseTrials.length);
    ui.setTaskStatus("教材を準備しています。");
    const loaded = await runner.preloadTrial(trial);
    const recording = expectedSegment === "picture_naming"
      ? await runner.runPictureNamingTrial(trial, loaded, nextWithinSegment)
      : await runner.runL2Trial(trial, loaded, nextWithinSegment);
    accepted.add(trial.trial_id);
    ui.updateProgress(
      progressLabel,
      phaseTrials.filter((candidate) => accepted.has(candidate.trial_id)).length,
      phaseTrials.length,
    );
    if (trial.practice) {
      await runner.reviewPracticeRecording(recording);
      runner.resetInterTrialClock();
    }
  }

  await runner.flushWithRetry();
  state = await api.state();
  runner.stopMonitoring();
  audio.close();
  if (state.next_route) {
    await ui.prompt("この課題は保存されました。続けて次の課題へ進みます。", "次の課題を開く");
    window.location.assign(state.next_route);
    return;
  }
  await api.completeVisit();
  api.clearSession();
  ui.completed(expectedVisit === "pre"
    ? "Pre Picture Namingは終了しました。Main Experimentのリンクは担当者から別途お送りします。"
    : expectedVisit === "immediate"
      ? "直後テストは終了しました。すべての回答と録音が保存されました。遅延テストの案内をお待ちください。"
      : "遅延テストは終了しました。すべての回答と録音が保存されました。ご協力ありがとうございました。");
}

main().catch((error) => {
  runner?.stopMonitoring();
  ui.setConnected(false);
  ui.fatal(error);
  audio.close();
});

window.addEventListener("pagehide", () => audio.close(), { once: true });
