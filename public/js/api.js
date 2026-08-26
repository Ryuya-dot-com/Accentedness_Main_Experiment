const SESSION_TOKEN_KEY = "main_experiment_session_token";
const SESSION_VISIT_KEY = "main_experiment_session_visit";
const CLIENT_INSTANCE_KEY = "main_experiment_client_instance";
const JSON_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const STIMULUS_TIMEOUT_MS = 30_000;
const RECORDING_TIMEOUT_MS = 60_000;
const PARTICIPANT_COPY_HEADER_TIMEOUT_MS = 30_000;
const UNICODE_WHITESPACE = /\p{White_Space}+/gu;
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cs}\u0085\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_NAME_CODE_POINTS = 80;
const MAX_NAME_UTF8_BYTES = 256;
const textEncoder = new TextEncoder();

export class ApiClientError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ParticipantNameValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParticipantNameValidationError";
    this.code = "invalid_participant_name";
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

export function consumeInvitationToken(
  location = window.location,
  historyObject = window.history,
) {
  const token = new URLSearchParams(String(location.hash ?? "").slice(1)).get("t");
  if (token) {
    historyObject.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  return token;
}

export function isCorrectableParticipantAccessError(error) {
  return error instanceof ApiClientError
    && error.status === 409
    && new Set([
      "participant_access_mismatch",
      "participant_name_state_changed",
    ]).has(error.code);
}

export function isCorrectableParticipantNameError(error) {
  return error instanceof ApiClientError
    && error.status === 422
    && error.code === "invalid_participant_name";
}

// This mirrors only the server's stored display transformation. The server
// remains authoritative for type, length, control-character, and bidi checks.
export function canonicalizeParticipantNameForDisplay(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(UNICODE_WHITESPACE, " ")
    .trim();
}

export function validateParticipantNameForRegistration(value) {
  const canonicalName = canonicalizeParticipantNameForDisplay(value);
  if (!canonicalName) {
    throw new ParticipantNameValidationError("氏名を入力してください。");
  }
  if (FORBIDDEN_NAME_CHARACTERS.test(canonicalName)) {
    throw new ParticipantNameValidationError(
      "氏名には改行、制御文字、文字方向を変更する記号を使用できません。",
    );
  }
  if (Array.from(canonicalName).length > MAX_NAME_CODE_POINTS) {
    throw new ParticipantNameValidationError("氏名は80文字以内で入力してください。");
  }
  if (textEncoder.encode(canonicalName).byteLength > MAX_NAME_UTF8_BYTES) {
    throw new ParticipantNameValidationError(
      "氏名が長すぎます。UTF-8で256バイト以内になるよう短くしてください。",
    );
  }
  return canonicalName;
}

export function participantNamePreviewPayload({
  invitationToken,
  participantId,
  expectedVisitType,
}) {
  return {
    token: String(invitationToken ?? ""),
    participant_id: String(participantId ?? "").trim(),
    expected_visit_type: String(expectedVisitType ?? ""),
  };
}

export function invitationRedeemPayload({
  invitationToken,
  clientInstanceId,
  expectedVisitType,
  participantId,
  nameAction,
  participantName,
}) {
  const action = String(nameAction ?? "");
  const payload = {
    token: String(invitationToken ?? ""),
    client_instance_id: String(clientInstanceId ?? ""),
    expected_visit_type: String(expectedVisitType ?? ""),
    participant_id: String(participantId ?? "").trim(),
    name_action: action,
    participant_name_confirmed: true,
  };
  if (action === "register") {
    payload.participant_name = canonicalizeParticipantNameForDisplay(participantName);
  }
  return payload;
}

export function participantCopyFilename(contentDisposition) {
  const match = /filename="([A-Za-z0-9._-]+\.zip)"/u.exec(contentDisposition ?? "");
  return match?.[1] ?? "accentedness_results.zip";
}

function participantCopyFileError(cause) {
  const error = new Error("選択した保存先へZIPを書き込めませんでした。");
  error.code = "participant_copy_file_write_failed";
  error.cause = cause;
  return error;
}

export async function writeResponseToFile(response, fileHandle) {
  if (!response.body) throw new TypeError("結果コピーの受信streamを開始できませんでした。");
  const expectedSize = Number(response.headers.get("Content-Length"));
  let writable;
  try {
    writable = await fileHandle.createWritable();
  } catch (error) {
    await response.body.cancel(error).catch(() => {});
    throw participantCopyFileError(error);
  }
  const reader = response.body.getReader();
  let receivedSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedSize += value.byteLength;
      try {
        await writable.write(value);
      } catch (error) {
        throw participantCopyFileError(error);
      }
    }
    if (Number.isSafeInteger(expectedSize)
        && expectedSize > 0
        && receivedSize !== expectedSize) {
      throw new TypeError("結果コピーを最後まで受信できませんでした。");
    }
    try {
      await writable.close();
    } catch (error) {
      throw participantCopyFileError(error);
    }
    return receivedSize;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await writable.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
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
    this.invitationToken = consumeInvitationToken();
    try {
      this.sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
      this.clientInstanceId = getOrCreateClientInstanceId();
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

  hasInvitationToken() {
    return Boolean(this.invitationToken);
  }

  async previewParticipantName(participantIdInput) {
    const participantId = String(participantIdInput ?? "").trim();
    if (!this.invitationToken) {
      throw new ApiClientError(
        401,
        "invitation_required",
        "担当者から送られた招待リンクを開いてください。",
      );
    }
    if (!participantId) {
      throw new ApiClientError(400, "participant_id_required", "参加者IDを入力してください。");
    }
    const preview = await fetchWithDeadline(
      "/api/invitations/name-preview",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(participantNamePreviewPayload({
          invitationToken: this.invitationToken,
          participantId,
          expectedVisitType: this.expectedVisitType,
        })),
        cache: "no-store",
      },
      JSON_TIMEOUT_MS,
      parseApiResponse,
    );
    if (preview?.name_action === "register") {
      return { name_action: "register" };
    }
    if (preview?.name_action === "confirm"
        && typeof preview.participant_name === "string"
        && preview.participant_name.trim()) {
      return {
        name_action: "confirm",
        participant_name: preview.participant_name,
      };
    }
    throw new ApiClientError(
      502,
      "invalid_name_preview",
      "氏名確認情報の形式を確認できません。担当者に知らせてください。",
    );
  }

  async bootstrap(participantConfirmation = null) {
    if (this.invitationToken) {
      const participantId = String(participantConfirmation?.participant_id ?? "").trim();
      const nameAction = String(participantConfirmation?.name_action ?? "");
      const participantName = canonicalizeParticipantNameForDisplay(
        participantConfirmation?.participant_name,
      );
      if (!participantId
          || !["register", "confirm"].includes(nameAction)
          || participantConfirmation?.participant_name_confirmed !== true
          || (nameAction === "register" && !participantName)) {
        throw new ApiClientError(
          400,
          "participant_name_confirmation_required",
          "参加者IDの入力と氏名の確認を完了してください。",
        );
      }
      const state = await fetchWithDeadline(
        "/api/invitations/redeem",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invitationRedeemPayload({
            invitationToken: this.invitationToken,
            clientInstanceId: this.clientInstanceId,
            expectedVisitType: this.expectedVisitType,
            participantId,
            nameAction,
            participantName,
          })),
          cache: "no-store",
        },
        JSON_TIMEOUT_MS,
        parseApiResponse,
      );
      this.invitationToken = null;
      this.sessionToken = state.session_token;
      sessionStorage.setItem(SESSION_TOKEN_KEY, this.sessionToken);
      sessionStorage.setItem(SESSION_VISIT_KEY, state.visit.visit_type);
      return state;
    }
    const storedVisit = sessionStorage.getItem(SESSION_VISIT_KEY);
    if (!this.sessionToken || storedVisit !== this.expectedVisitType) {
      throw new ApiClientError(401, "invitation_required", "担当者から送られた招待リンクを開いてください。");
    }
    return this.state();
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

  async fetchParticipantCopy(fileHandle = null) {
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
    if (fileHandle) {
      const byteCount = await writeResponseToFile(response, fileHandle);
      return { blob: null, filename, byteCount, savedToDisk: true };
    }
    const blob = await response.blob();
    if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && blob.size !== expectedSize) {
      throw new TypeError("結果コピーを最後まで受信できませんでした。");
    }
    return {
      blob,
      filename,
      byteCount: blob.size,
      savedToDisk: false,
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
    this.invitationToken = null;
  }
}

export async function sha256Blob(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
