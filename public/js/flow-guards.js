import { isCorrectableParticipantIdentityError } from "./api.js";

function normalizedPath(path) {
  return String(path ?? "").replace(/\/+$/u, "") || "/";
}

export async function bootstrapWithParticipantIdentity(api, ui) {
  if (!api.hasInvitationToken()) {
    const state = await api.bootstrap();
    ui.showParticipationSetup();
    return state;
  }
  let retryMessage = "";
  while (true) {
    const identity = await ui.requestParticipantIdentity(retryMessage);
    try {
      const state = await api.bootstrap(identity);
      ui.showParticipationSetup();
      return state;
    } catch (error) {
      if (!isCorrectableParticipantIdentityError(error)) throw error;
      retryMessage = "参加者IDと氏名の組み合わせを確認できませんでした。入力内容を確認して、もう一度お試しください。";
    }
  }
}

export async function waitForStartOrParticipantExit(ui, runner) {
  while (true) {
    const action = await ui.waitForStart();
    if (action === "start") return;
    ui.beginTask();
    await runner.handleParticipantExit();
    ui.returnToWelcome();
  }
}

export function redirectToCanonical(
  state,
  {
    runner = null,
    audio = null,
    location = window.location,
  } = {},
) {
  if (!state?.next_route) return false;
  if (normalizedPath(location.pathname) === normalizedPath(state.next_route)) return false;
  runner?.stopMonitoring();
  audio?.close();
  location.replace(state.next_route);
  return true;
}

export function microphoneCheckStorageKey(state, segment) {
  return [
    "microphone_checked",
    state.visit.visit_id,
    state.session.epoch,
    segment,
  ].join(":");
}
