import { ApiClientError } from "./api.js";
import { ExperimentRunner, ParticipantExitRequested } from "./runner.js";

const TEST_BOOTSTRAP_PATH = "/api/test/bootstrap";
const HEALTH_PATH = "/api/health";
const VALID_VISITS = new Set(["pre", "immediate", "delayed"]);
const VALID_SEGMENTS = new Set(["learning", "picture_naming", "l2_to_l1"]);

export class ResearcherTestModeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResearcherTestModeError";
    this.code = code;
  }
}

function fetchImplementation(input) {
  const candidate = typeof input === "function" ? input : input?.fetchImpl;
  const implementation = candidate ?? globalThis.fetch;
  if (typeof implementation !== "function") {
    throw new TypeError("Fetch is unavailable");
  }
  return implementation.bind(globalThis);
}

async function apiError(response) {
  let body = null;
  try {
    if ((response.headers.get("Content-Type") ?? "").includes("application/json")) {
      body = await response.json();
    }
  } catch {
    body = null;
  }
  return new ApiClientError(
    response.status,
    body?.error?.code ?? "request_failed",
    body?.error?.message ?? `Request failed (${response.status})`,
    body?.error?.details ?? null,
  );
}

export async function researcherTestModeAvailable(options = {}) {
  const fetchImpl = fetchImplementation(options);
  const response = await fetchImpl(HEALTH_PATH, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) throw await apiError(response);
  const health = await response.json();
  return health?.environment === "development";
}

function literalTestId(input = "test") {
  const text = String(input ?? "").trim();
  if (text !== "test") {
    throw new ResearcherTestModeError(
      "invalid_test_id",
      "Researcher test mode requires the exact participant ID 'test'",
    );
  }
  return text;
}

function validateScope(expectedVisitType, expectedSegment) {
  if (!VALID_VISITS.has(expectedVisitType) || !VALID_SEGMENTS.has(expectedSegment)) {
    throw new ResearcherTestModeError(
      "invalid_test_mode_scope",
      "Researcher test visit or segment is invalid",
    );
  }
  if ((expectedVisitType === "pre" && expectedSegment !== "picture_naming")
      || (expectedVisitType === "delayed" && expectedSegment === "learning")) {
    throw new ResearcherTestModeError(
      "invalid_test_mode_scope",
      "Researcher test visit and segment are not a valid page combination",
    );
  }
}

function validateBootstrapState(state, expectedVisitType, expectedSegment) {
  const valid = state
    && typeof state === "object"
    && state.test_mode === true
    && state.participant?.id === "test"
    && state.visit?.visit_type === expectedVisitType
    && state.test_run?.visit_type === expectedVisitType
    && state.test_run?.segment === expectedSegment
    && state.test_run?.persistence === "none"
    && Array.isArray(state.manifest)
    && state.manifest.length > 0
    && state.manifest.every((trial) => trial?.segment === expectedSegment)
    && Array.isArray(state.accepted);
  if (!valid) {
    throw new ApiClientError(
      502,
      "invalid_test_bootstrap",
      "Researcher test bootstrap returned an invalid state",
    );
  }
  return state;
}

function forbiddenPersistence(operation) {
  throw new ResearcherTestModeError(
    "test_mode_persistence_forbidden",
    `${operation} is disabled in researcher test mode`,
  );
}

function staticStimulusEndpoint(endpoint, origin) {
  const value = String(endpoint ?? "").trim();
  if (!value) {
    throw new ResearcherTestModeError(
      "invalid_test_stimulus_url",
      "Researcher test stimulus URL is missing",
    );
  }

  // The test manifest intentionally uses an inline SVG placeholder. It is
  // decoded locally below and never passed to fetch().
  if (/^data:image\/svg\+xml(?:;charset=utf-8)?,/iu.test(value)) return value;

  let parsed;
  try {
    parsed = new URL(value, origin ?? "https://researcher-test.invalid");
  } catch {
    throw new ResearcherTestModeError(
      "invalid_test_stimulus_url",
      "Researcher test stimulus URL is invalid",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)
      || !/^\/placeholder-audio\/[A-Za-z0-9_-]+\.wav$/u.test(parsed.pathname)) {
    throw new ResearcherTestModeError(
      "invalid_test_stimulus_url",
      "Researcher test stimuli must be static assets",
    );
  }
  if (origin && parsed.origin !== origin) {
    throw new ResearcherTestModeError(
      "invalid_test_stimulus_url",
      "Researcher test stimuli must use the current origin",
    );
  }
  return value;
}

function inlineSvgBlob(endpoint) {
  const match = /^data:image\/svg\+xml(?:;charset=utf-8)?,(.*)$/isu.exec(endpoint);
  if (!match) return null;
  try {
    return new Blob([decodeURIComponent(match[1])], {
      type: "image/svg+xml;charset=utf-8",
    });
  } catch {
    throw new ResearcherTestModeError(
      "invalid_test_stimulus_url",
      "Researcher test placeholder image cannot be decoded",
    );
  }
}

export class ResearcherTestApi {
  constructor(expectedVisitType, expectedSegment, options = {}) {
    validateScope(expectedVisitType, expectedSegment);
    this.expectedVisitType = expectedVisitType;
    this.expectedSegment = expectedSegment;
    this.isTestMode = true;
    this.fetchImpl = fetchImplementation(options);
    this.origin = options.origin ?? globalThis.location?.origin ?? null;
    this.testId = null;
    this.currentState = null;
    this.bootstrapPromise = null;
  }

  hasInvitationToken() {
    return false;
  }

  hasStoredSession() {
    return false;
  }

  async bootstrap(testIdInput) {
    const testId = literalTestId(testIdInput);
    if (this.currentState) {
      if (testId !== this.testId) {
        throw new ResearcherTestModeError(
          "test_mode_already_bootstrapped",
          "This page is already using a different researcher test ID",
        );
      }
      return this.currentState;
    }
    if (this.bootstrapPromise) {
      if (testId !== this.testId) {
        throw new ResearcherTestModeError(
          "test_mode_already_bootstrapped",
          "This page is already starting with a different researcher test ID",
        );
      }
      return this.bootstrapPromise;
    }

    this.testId = testId;
    this.bootstrapPromise = (async () => {
      const response = await this.fetchImpl(TEST_BOOTSTRAP_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participant_id: testId,
          expected_visit_type: this.expectedVisitType,
          expected_segment: this.expectedSegment,
        }),
        cache: "no-store",
      });
      if (!response.ok) throw await apiError(response);
      const state = validateBootstrapState(
        await response.json(),
        this.expectedVisitType,
        this.expectedSegment,
      );
      this.currentState = state;
      return state;
    })();

    try {
      return await this.bootstrapPromise;
    } catch (error) {
      this.testId = null;
      this.bootstrapPromise = null;
      throw error;
    }
  }

  async state() {
    if (!this.currentState) {
      throw new ResearcherTestModeError(
        "test_mode_not_bootstrapped",
        "Researcher test mode has not been started",
      );
    }
    return this.currentState;
  }

  async fetchStimulus(endpoint) {
    if (!this.currentState) {
      throw new ResearcherTestModeError(
        "test_mode_not_bootstrapped",
        "Researcher test mode has not been started",
      );
    }
    const staticEndpoint = staticStimulusEndpoint(endpoint, this.origin);
    const inlineImage = inlineSvgBlob(staticEndpoint);
    if (inlineImage) return inlineImage;
    const response = await this.fetchImpl(staticEndpoint, { method: "GET" });
    if (!response.ok) throw await apiError(response);
    return response.blob();
  }

  heartbeat() {
    return Promise.resolve({ ok: true, test_mode: true });
  }

  events() {
    return Promise.resolve({ ok: true, test_mode: true });
  }

  clearSession() {}

  startTrial() {
    return forbiddenPersistence("Trial authorization");
  }

  saveResponse() {
    return forbiddenPersistence("Response persistence");
  }

  uploadRecording() {
    return forbiddenPersistence("Recording upload");
  }

  completeVisit() {
    return forbiddenPersistence("Visit persistence");
  }

  requestParticipationInterruption() {
    return forbiddenPersistence("Interruption persistence");
  }

  finalizeParticipationInterruption() {
    return forbiddenPersistence("Interruption persistence");
  }

  fetchParticipantCopy() {
    return forbiddenPersistence("Participant-copy generation");
  }
}

function nextMemoryState(state, acceptedTrialIds) {
  const nextTrial = state.manifest.find((trial) => !acceptedTrialIds.has(trial.trial_id)) ?? null;
  for (const trial of state.manifest) trial.current = trial === nextTrial;
  state.next_trial_id = nextTrial?.trial_id ?? null;
  // Test bootstraps are scoped to one page; navigation never represents a
  // durable continuation and is therefore deliberately not synthesized here.
  state.next_route = null;
  return state;
}

export class ResearcherTestRunner extends ExperimentRunner {
  constructor(api, ui, audio, state) {
    if (api?.isTestMode !== true || state?.test_mode !== true) {
      throw new TypeError("ResearcherTestRunner requires researcher test-mode state");
    }
    super(api, ui, audio, state);
    this.pageAcceptedTrialIds = new Set(
      state.accepted.map((entry) => entry.trial_id),
    );
    this.memoryAttempts = new Map();
  }

  startMonitoring() {
    // Preserve the trial-local visibility guard, but do not install a
    // heartbeat, beforeunload guard, or event transport.
    this.running = true;
    globalThis.document?.addEventListener?.("visibilitychange", this.onVisibility);
  }

  stopMonitoring() {
    this.running = false;
    globalThis.document?.removeEventListener?.("visibilitychange", this.onVisibility);
    if (this.heartbeatTimer && globalThis.window?.clearInterval) {
      globalThis.window.clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = null;
  }

  acceptedTrialIds() {
    return new Set(this.pageAcceptedTrialIds);
  }

  async authorizeTrial(trial) {
    const trialId = String(trial?.trial_id ?? "");
    if (!trialId || this.pageAcceptedTrialIds.has(trialId)) {
      throw new ResearcherTestModeError(
        "invalid_test_trial_start",
        "Researcher test trial cannot be started",
      );
    }
    const existing = this.memoryAttempts.get(trialId);
    if (existing) return existing;
    const authorization = {
      attempt_id: `researcher-test-${crypto.randomUUID()}`,
      test_mode: true,
    };
    this.memoryAttempts.set(trialId, authorization);
    return authorization;
  }

  async markTrialStimulusShown() {}

  async persistTrial(trial, authorization) {
    const trialId = String(trial?.trial_id ?? "");
    const attemptId = String(authorization?.attempt_id ?? "");
    const expectsRecording = Boolean(trial?.expects_recording);

    if (!trialId || !attemptId || this.memoryAttempts.get(trialId)?.attempt_id !== attemptId) {
      throw new ResearcherTestModeError(
        "invalid_test_trial_response",
        "Researcher test response does not match its in-memory trial start",
      );
    }
    if (!this.pageAcceptedTrialIds.has(trialId)) {
      this.pageAcceptedTrialIds.add(trialId);
      this.state.accepted.push({
        trial_id: trialId,
        ordinal: trial.ordinal,
        attempt_id: attemptId,
        response_key: null,
        server_received_at_ms: null,
        recording_state: expectsRecording ? "discarded" : "not_required",
        test_mode: true,
      });
    }
    this.memoryAttempts.delete(trialId);
    nextMemoryState(this.state, this.pageAcceptedTrialIds);
    this.ui.setSaveState?.("saved");
  }

  sendEvent() {
    return Promise.resolve({ ok: true, test_mode: true });
  }

  async reconcileOutbox() {
    return this.state;
  }

  async flushWithRetry() {
    return this.state;
  }

  async completeVisitWithRetry() {
    this.state.visit.status = "test_complete";
    return { ok: true, test_mode: true };
  }

  async prepareParticipantCopyWithRetry() {
    return forbiddenPersistence("Participant-copy generation");
  }

  async handleParticipantExit(preselectedMode = null) {
    if (!this.participantExitRequested || this.trialInFlight) return false;

    let shouldExit = true;
    if (!preselectedMode && typeof this.ui.chooseResearcherTestExit === "function") {
      const decision = await this.ui.chooseResearcherTestExit();
      shouldExit = decision === true
        || decision === "exit"
        || decision === "terminate";
    }
    if (!shouldExit) {
      this.participantExitRequested = false;
      this.ui.clearInterruptionPending?.();
      this.resetInterTrialClock();
      return false;
    }

    this.interruptionFlowActive = true;
    this.stopMonitoring();
    this.ui.setInterruptionControlEnabled?.(false);
    if (typeof this.ui.researcherTestInterrupted === "function") {
      this.ui.researcherTestInterrupted(
        "動作確認を終了しました。この画面で行った回答と録音は保存・送信していません。このページは閉じて構いません。",
      );
    } else {
      this.ui.completed?.(
        "研究者用テストを終了しました。この画面で行った回答と録音は保存・送信していません。",
      );
    }
    throw new ParticipantExitRequested("terminate");
  }
}
