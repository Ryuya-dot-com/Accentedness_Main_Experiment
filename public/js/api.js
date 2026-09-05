const SESSION_TOKEN_KEY = "main_experiment_session_token";
const SESSION_VISIT_KEY = "main_experiment_session_visit";
const CLIENT_INSTANCE_KEY = "main_experiment_client_instance";
const JSON_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STIMULUS_TIMEOUT_MS = 30_000;
const RECORDING_TIMEOUT_MS = 60_000;
const PARTICIPANT_COPY_HEADER_TIMEOUT_MS = 30_000;

export class ApiClientError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getOrCreateClientInstanceId() {
  let value = sessionStorage.getItem(CLIENT_INSTANCE_KEY);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_INSTANCE_KEY, value);
  }
  return value;
}

export function isCorrectableParticipantAccessError(error) {
  return error instanceof ApiClientError
    && new Set([400, 404, 409]).has(error.status)
    && new Set([
      "invalid_participant_id",
      "participant_access_mismatch",
      "participant_access_start_conflict",
      "participant_not_registered",
    ]).has(error.code);
}

export function commonParticipantStartPayload({
  clientInstanceId,
  expectedVisitType,
  participantId,
}) {
  return {
    client_instance_id: String(clientInstanceId ?? ""),
    expected_visit_type: String(expectedVisitType ?? ""),
    participant_id: String(participantId ?? "").trim(),
    participant_id_confirmed: true,
  };
}

export function participantCopyFilename(contentDisposition) {
  const match = /filename="([A-Za-z0-9._-]+\.zip)"/u.exec(contentDisposition ?? "");
  return match?.[1] ?? "accentedness_results.zip";
}


async function fetchWithHeaderDeadline(path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const timeout = new TypeError("通信の開始がタイムアウトしました。ネットワーク接続を確認してください。");
      timeout.code = "request_timeout";
      timeout.status = 408;
      throw timeout;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function parseApiResponse(response) {
  const contentType = response.headers.get("Content-Type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      body?.error?.code ?? "request_failed",
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.details ?? null,
    );
  }
  return body;
}

async function fetchWithDeadline(path, options, timeoutMs, consume) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const timeout = new TypeError("通信がタイムアウトしました。ネットワーク接続を確認してください。");
      timeout.code = "request_timeout";
      timeout.status = 408;
      throw timeout;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export class ExperimentApi {
  constructor(expectedVisitType) {
    this.expectedVisitType = expectedVisitType;
    try {
      this.sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
      const storedVisit = sessionStorage.getItem(SESSION_VISIT_KEY);
      if (this.sessionToken && storedVisit !== this.expectedVisitType) {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        sessionStorage.removeItem(SESSION_VISIT_KEY);
        this.sessionToken = null;
      }
      // Do not create browser state before distinguishing a real participant
      // from the non-persistent researcher test path.
      this.clientInstanceId = sessionStorage.getItem(CLIENT_INSTANCE_KEY);
    } catch {
      throw new ApiClientError(
        0,
        "session_storage_unavailable",
        "このブラウザでは回答を一時保存できません。通常モードのGoogle Chromeで開き直し、担当者に知らせてください。",
      );
    }
  }

  async request(path, options = {}) {
    const headers = new Headers(options.headers ?? {});
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (this.sessionToken) headers.set("Authorization", `Bearer ${this.sessionToken}`);
    return fetchWithDeadline(
      path,
      {
        method: options.method ?? "GET",
        headers,
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
        cache: "no-store",
        keepalive: Boolean(options.keepalive),
      },
      options.timeoutMs ?? JSON_TIMEOUT_MS,
      parseApiResponse,
    );
  }

  hasStoredSession() {
    return Boolean(this.sessionToken);
  }

  async bootstrap() {
    const storedVisit = sessionStorage.getItem(SESSION_VISIT_KEY);
    if (!this.sessionToken || storedVisit !== this.expectedVisitType) {
      throw new ApiClientError(401, "session_required", "参加者IDを入力してください。");
    }
    return this.state();
  }

  async bootstrapCommon(participantConfirmation) {
    const participantId = String(participantConfirmation?.participant_id ?? "").trim();
    if (!participantId || participantConfirmation?.participant_id_confirmed !== true) {
      throw new ApiClientError(
        400,
        "participant_id_confirmation_required",
        "参加者IDを確認してください。",
      );
    }
    this.clientInstanceId = getOrCreateClientInstanceId();
    const state = await fetchWithDeadline(
      "/api/participant-access/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commonParticipantStartPayload({
          clientInstanceId: this.clientInstanceId,
          expectedVisitType: this.expectedVisitType,
          participantId,
        })),
        cache: "no-store",
      },
      JSON_TIMEOUT_MS,
      parseApiResponse,
    );
    this.sessionToken = state.session_token;
    sessionStorage.setItem(SESSION_TOKEN_KEY, this.sessionToken);
    sessionStorage.setItem(SESSION_VISIT_KEY, state.visit.visit_type);
    return state;
  }

  state() {
    return this.request("/api/session");
  }

  heartbeat() {
    return this.request("/api/session/heartbeat", {
      method: "POST",
      json: {},
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    });
  }

  startTrial(trialId, startKey, clientStartedPerfMs, resumeAfterStimulus = false) {
    return this.request(`/api/trials/${trialId}/start`, {
      method: "POST",
      json: {
        start_key: startKey,
        client_started_perf_ms: clientStartedPerfMs,
        resume_after_stimulus: Boolean(resumeAfterStimulus),
      },
    });
  }

  saveResponse(trialId, attemptId, responseKey, payload) {
    return this.request(`/api/trials/${trialId}/response`, {
      method: "PUT",
      json: { attempt_id: attemptId, response_key: responseKey, payload },
    });
  }

  uploadRecording(attemptId, blob, sha256) {
    return this.request(`/api/recordings/${attemptId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "audio/wav",
        "X-Content-SHA256": sha256,
      },
      body: blob,
      timeoutMs: RECORDING_TIMEOUT_MS,
    });
  }

  events(events, keepalive = false) {
    return this.request("/api/events", { method: "POST", json: { events }, keepalive });
  }

  completeVisit() {
    return this.request("/api/visit/complete", { method: "POST", json: {} });
  }

  requestParticipationInterruption(mode, requestId) {
    return this.request("/api/participation/interruptions", {
      method: "POST",
      json: { request_id: requestId, mode },
    });
  }

  finalizeParticipationInterruption(interruptionId, requestId) {
    return this.request(
      `/api/participation/interruptions/${encodeURIComponent(interruptionId)}/finalize`,
      {
        method: "POST",
        json: { request_id: requestId },
      },
    );
  }

  async fetchParticipantCopy() {
    const response = await fetchWithHeaderDeadline(
      "/api/visit/results.zip",
      {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
        cache: "no-store",
      },
      PARTICIPANT_COPY_HEADER_TIMEOUT_MS,
    );
    if (!response.ok) await parseApiResponse(response);
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/zip")) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError("結果コピーの形式を確認できませんでした。");
    }
    const expectedSize = Number(response.headers.get("Content-Length"));
    const filename = participantCopyFilename(
      response.headers.get("Content-Disposition"),
    );
    // ponytail: buffer one ZIP (up to ~528 MiB); revisit delivery if full-size Chrome QA fails.
    const blob = await response.blob();
    if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && blob.size !== expectedSize) {
      throw new TypeError("結果コピーを最後まで受信できませんでした。");
    }
    return {
      blob,
      filename,
      byteCount: blob.size,
    };
  }

  async fetchStimulus(endpoint) {
    return fetchWithDeadline(
      endpoint,
      {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
        cache: "no-store",
      },
      STIMULUS_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) await parseApiResponse(response);
        return response.blob();
      },
    );
  }

  clearSession() {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_VISIT_KEY);
    this.sessionToken = null;
  }
}

export async function sha256Blob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
