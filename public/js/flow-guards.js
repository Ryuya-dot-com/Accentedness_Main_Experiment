import {
  ApiClientError,
  isCorrectableParticipantAccessError,
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
  { initialParticipantId = null, commonEntry = false } = {},
) {
  if (!commonEntry) {
    const state = await api.bootstrap();
    ui.showParticipationSetup();
    return state;
  }
  let retryMessage = "";
  let pendingParticipantId = initialParticipantId;
  while (true) {
    const participantId = pendingParticipantId
      ?? await ui.requestParticipantId(retryMessage);
    pendingParticipantId = null;
    const decision = await ui.confirmParticipantId(participantId);
    if (decision !== "confirm") continue;
    try {
      const state = await api[commonEntry ? "bootstrapCommon" : "bootstrap"]({
        participant_id: participantId,
        participant_id_confirmed: true,
      });
      ui.showParticipationSetup();
      return state;
    } catch (error) {
      if (!isCorrectableParticipantAccessError(error)) throw error;
      retryMessage = "参加者IDを確認できませんでした。入力内容を確認して、もう一度お試しください。";
    }
  }
}

export async function bootstrapTaskAccess(
  realApi,
  ui,
  {
    expectedVisitType,
    expectedSegment,
    beforePersistentParticipantAccess = null,
  },
) {
  if (realApi.hasStoredSession()) {
    await beforePersistentParticipantAccess?.();
    try {
      return {
        api: realApi,
        state: await bootstrapWithParticipantAccess(realApi, ui),
        testMode: false,
      };
    } catch (error) {
      if (!(error instanceof ApiClientError)
          || !new Set(["invalid_session", "session_expired", "session_superseded"]).has(error.code)) {
        throw error;
      }
      realApi.clearSession();
    }
  }

  const participantId = await ui.requestParticipantId("");

  if (participantId === "999") {
    const researcherTest = await researcherTestModeAvailable();
    if (!researcherTest) {
      throw new ApiClientError(
        400,
        "reserved_test_participant_id",
        "参加者IDを確認できません。",
      );
    }
    ui.activateResearcherTestMode(null, expectedVisitType);
    let tokenMessage = "";
    while (true) {
      const adminToken = await ui.requestResearcherToken(tokenMessage);
      const testApi = new ResearcherTestApi(expectedVisitType, expectedSegment, { adminToken });
      try {
        const state = await testApi.bootstrap("999");
        ui.showParticipationSetup();
        return { api: testApi, state, testMode: true };
      } catch (error) {
        testApi.clearSession();
        if (!(error instanceof ApiClientError) || error.code !== "admin_forbidden") throw error;
        tokenMessage = "管理トークンを確認できませんでした。入力内容を確認して、もう一度お試しください。";
      }
    }
  }

  await beforePersistentParticipantAccess?.();

  return {
    api: realApi,
    state: await bootstrapWithParticipantAccess(realApi, ui, {
      initialParticipantId: participantId,
      commonEntry: true,
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
