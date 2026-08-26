import {
  ApiClientError,
  isCorrectableParticipantAccessError,
  isCorrectableParticipantNameError,
  ParticipantNameValidationError,
  validateParticipantNameForRegistration,
} from "./api.js";
import {
  ResearcherTestApi,
  researcherTestModeAvailable,
} from "./test-mode.js";

function normalizedPath(path) {
  return String(path ?? "").replace(/\/+$/u, "") || "/";
}

export async function bootstrapWithParticipantAccess(
  api,
  ui,
  { initialParticipantId = null } = {},
) {
  if (!api.hasInvitationToken()) {
    const state = await api.bootstrap();
    ui.showParticipationSetup();
    return state;
  }
  let retryMessage = "";
  let pendingParticipantId = initialParticipantId;
  participantAccessLoop:
  while (true) {
    const participantId = pendingParticipantId
      ?? await ui.requestParticipantId(retryMessage);
    pendingParticipantId = null;
    let preview;
    try {
      preview = await api.previewParticipantName(participantId);
    } catch (error) {
      if (!isCorrectableParticipantAccessError(error)) throw error;
      retryMessage = "参加者IDを確認できませんでした。入力内容を確認して、もう一度お試しください。";
      continue;
    }

    if (preview.name_action === "register") {
      let draftName = "";
      let nameInputMessage = "";
      while (true) {
        const enteredName = await ui.requestParticipantName(draftName, nameInputMessage);
        let participantName;
        try {
          participantName = validateParticipantNameForRegistration(enteredName);
        } catch (error) {
          if (!(error instanceof ParticipantNameValidationError)) throw error;
          draftName = String(enteredName ?? "");
          nameInputMessage = error.message;
          continue;
        }
        const decision = await ui.confirmParticipantName(participantName, { allowEdit: true });
        if (decision !== "confirm") {
          draftName = participantName;
          nameInputMessage = "";
          continue;
        }
        try {
          const state = await api.bootstrap({
            participant_id: participantId,
            name_action: "register",
            participant_name_confirmed: true,
            participant_name: participantName,
          });
          ui.showParticipationSetup();
          return state;
        } catch (error) {
          if (isCorrectableParticipantNameError(error)) {
            draftName = participantName;
            nameInputMessage = "氏名を登録できませんでした。表示内容を修正して、もう一度確認してください。";
            continue;
          }
          if (!isCorrectableParticipantAccessError(error)) throw error;
          retryMessage = "参加者情報を確定できませんでした。参加者IDを確認して、もう一度お試しください。";
          continue participantAccessLoop;
        }
      }
    }

    const decision = await ui.confirmParticipantName(preview.participant_name);
    if (decision !== "confirm") {
      retryMessage = "表示された氏名がご自身のものではありません。参加者IDを確認してください。正しいIDでも氏名が違う場合は、このまま進まず担当者へ連絡してください。";
      continue;
    }
    try {
      const state = await api.bootstrap({
        participant_id: participantId,
        name_action: "confirm",
        participant_name_confirmed: true,
      });
      ui.showParticipationSetup();
      return state;
    } catch (error) {
      if (!isCorrectableParticipantAccessError(error)) throw error;
      retryMessage = "参加者情報を確定できませんでした。参加者IDを確認して、もう一度お試しください。";
    }
  }
}

export async function bootstrapTaskAccess(
  realApi,
  ui,
  { expectedVisitType, expectedSegment },
) {
  if (realApi.hasStoredSession()) {
    try {
      return {
        api: realApi,
        state: await bootstrapWithParticipantAccess(realApi, ui),
        testMode: false,
      };
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.code !== "invalid_session") throw error;
      realApi.clearSession();
    }
  }

  const hasInvitationToken = realApi.hasInvitationToken();
  const researcherTest = !hasInvitationToken
    && await researcherTestModeAvailable();
  if (!hasInvitationToken && !researcherTest) {
    throw new ApiClientError(
      401,
      "invitation_required",
      "担当者から送られた招待リンクを開いてください。",
    );
  }
  const participantId = await ui.requestParticipantId("", { researcherTest });

  if (participantId === "test" && researcherTest) {
    const testApi = new ResearcherTestApi(expectedVisitType, expectedSegment);
    ui.activateResearcherTestMode(null, expectedVisitType);
    const state = await testApi.bootstrap("test");
    ui.showParticipationSetup();
    return { api: testApi, state, testMode: true };
  }

  if (!hasInvitationToken) {
    throw new ApiClientError(
      401,
      "invitation_required",
      "数値の参加者IDで実施する場合は、担当者から送られた招待リンクを開いてください。",
    );
  }
  return {
    api: realApi,
    state: await bootstrapWithParticipantAccess(realApi, ui, {
      initialParticipantId: participantId,
    }),
    testMode: false,
  };
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
