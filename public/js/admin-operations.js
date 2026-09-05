import { participantCopyFilename } from "./api.js";

const VISIT_LABELS = Object.freeze({
  pre: "事前課題",
  immediate: "本実験・直後課題",
  delayed: "後日の課題",
});

const VISIT_PATHS = Object.freeze({
  pre: "/pre-picture-naming/",
  immediate: "/main-experiment/",
  delayed: "/delayed-picture-naming/",
});

const VISIT_STATUS_LABELS = Object.freeze({
  planned: "未開始",
  scheduled: "受付待ち",
  invited: "案内済み",
  started: "実施中",
  awaiting_uploads: "回答済み・音声保存待ち",
  completed: "保存完了",
  withdrawn: "参加終了",
});

const SEGMENT_LABELS = Object.freeze({
  learning: "単語学習",
  picture_naming: "Picture Naming",
  l2_to_l1: "L2-to-L1",
});

const SEGMENT_STATUS_LABELS = Object.freeze({
  pending: "未開始",
  started: "実施中",
  completed: "完了",
});

const INTERRUPTION_MODE_LABELS = Object.freeze({
  pause: "一時中断",
  terminate: "参加終了",
});

const INTERRUPTION_STATE_LABELS = Object.freeze({
  requested: "端末で処理中",
  paused: "中断中",
  resumed: "再開済み",
  cancelled: "取消済み",
  terminated: "終了済み",
});

const COPYABLE_ACTIONS = new Set([
  "start_pre",
  "resume_pre",
  "start_immediate",
  "resume_immediate",
  "start_delayed",
  "resume_delayed",
]);

const ACTION_COPY = Object.freeze({
  start_pre: {
    message: "事前課題を案内できます。",
    button: "事前課題の案内をコピー",
    instruction: "事前課題を開始してください。",
  },
  resume_pre: {
    message: "事前課題の続きから再開できます。",
    button: "再開案内をコピー",
    instruction: "事前課題の続きから再開してください。",
  },
  start_immediate: {
    message: "本実験・直後課題を案内できます。",
    button: "本実験の案内をコピー",
    instruction: "本実験と直後課題を開始してください。",
  },
  resume_immediate: {
    message: "本実験・直後課題の続きから再開できます。",
    button: "再開案内をコピー",
    instruction: "本実験・直後課題の続きから再開してください。",
  },
  start_delayed: {
    message: "後日の課題を案内できます。",
    button: "後日の課題の案内をコピー",
    instruction: "後日の課題を開始してください。",
  },
  resume_delayed: {
    message: "後日の課題の続きから再開できます。",
    button: "再開案内をコピー",
    instruction: "後日の課題の続きから再開してください。",
  },
});

const ACTION_MESSAGES = Object.freeze({
  retry_pre_uploads: "事前課題の音声を保存中です。新しい課題は案内しないでください。",
  retry_immediate_uploads: "本実験・直後課題の音声を保存中です。新しい課題は案内しないでください。",
  retry_delayed_uploads: "後日の課題の音声を保存中です。新しい課題は案内しないでください。",
  finalize_pre: "事前課題の保存確定を待っています。新しい課題は案内しないでください。",
  finalize_immediate: "本実験・直後課題の保存確定を待っています。後日の課題は案内しないでください。",
  finalize_delayed: "後日の課題の保存確定を待っています。",
  wait_pre_recording_upload: "事前課題の音声保存完了を待っています。新しい課題は案内しないでください。",
  wait_immediate_recording_upload: "本実験・直後課題の音声保存完了を待っています。後日の課題は案内しないでください。",
  wait_delayed_recording_upload: "後日の課題の音声保存完了を待っています。",
  finish_interruption: "中断または参加終了の処理中です。課題は案内しないでください。",
  resume_paused_visit: "一時中断中です。参加者から再開希望があるまで案内しないでください。",
  complete: "全時点の回答と本番音声が保存済みです。",
  participation_ended: "参加終了済みです。課題は案内しないでください。",
  review_state: "状態の確認が必要です。課題は案内しないでください。",
});

const ACTION_CATEGORY_BY_CODE = Object.freeze({
  start_pre: "ready",
  start_immediate: "ready",
  start_delayed: "ready",
  resume_pre: "in_progress",
  resume_immediate: "in_progress",
  resume_delayed: "in_progress",
  wait_delayed: "waiting",
  wait_pre_recording_upload: "waiting",
  wait_immediate_recording_upload: "waiting",
  wait_delayed_recording_upload: "waiting",
  retry_pre_uploads: "attention",
  retry_immediate_uploads: "attention",
  retry_delayed_uploads: "attention",
  finalize_pre: "attention",
  finalize_immediate: "attention",
  finalize_delayed: "attention",
  finish_interruption: "attention",
  resume_paused_visit: "attention",
  complete: "completed",
  participation_ended: "ended",
  review_state: "attention",
});

const FILTER_LABELS = Object.freeze({
  all: "全員",
  attention: "対応が必要な参加者",
  delayed: "後日の課題を案内できる参加者",
  complete: "完了・終了した参加者",
});

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function canonicalParticipantId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) return null;
  const numeric = Number(text);
  if (!Number.isSafeInteger(numeric) || numeric < 1) return null;
  return String(numeric);
}

function copyActionSignature(participant) {
  const participantId = canonicalParticipantId(participant?.participant_id);
  const action = participant?.next_action;
  if (!participantId || !action) return null;
  return [
    participantId,
    String(action.code ?? ""),
    String(action.category ?? ""),
    String(action.visit_type ?? ""),
    String(action.path ?? ""),
  ].join("|");
}

export function freshCopyDecision(originalParticipant, freshParticipants, freshHealth) {
  if (!freshHealth?.canDistribute) {
    return { copyable: false, reason: "environment_changed", participant: null };
  }
  const participantId = canonicalParticipantId(originalParticipant?.participant_id);
  const latest = (Array.isArray(freshParticipants) ? freshParticipants : []).find(
    (candidate) => canonicalParticipantId(candidate?.participant_id) === participantId,
  ) ?? null;
  if (!participantId || !latest) {
    return { copyable: false, reason: "participant_missing", participant: null };
  }
  if (!operatorActionView(latest, freshHealth).copyable) {
    return { copyable: false, reason: "action_blocked", participant: latest };
  }
  if (copyActionSignature(originalParticipant) !== copyActionSignature(latest)) {
    return { copyable: false, reason: "action_changed", participant: latest };
  }
  return { copyable: true, reason: "current", participant: latest };
}

export function participantListFromAdminPayload(payload) {
  if (!payload
      || payload.ok !== true
      || !Number.isFinite(Number(payload.server_now_ms))
      || Number(payload.server_now_ms) <= 0
      || !Array.isArray(payload.participants)) {
    const error = new TypeError("invalid_admin_response");
    error.code = "invalid_admin_response";
    throw error;
  }
  const seen = new Set();
  for (const participant of payload.participants) {
    const participantId = canonicalParticipantId(participant?.participant_id);
    if (!participantId
        || seen.has(participantId)
        || !Array.isArray(participant?.visits)
        || !participant.visits.every(
          (visit) => Object.hasOwn(VISIT_LABELS, String(visit?.visit_type ?? ""))
            && typeof visit?.status === "string",
        )
        || !participant?.next_action
        || typeof participant.next_action.code !== "string"
        || typeof participant.next_action.category !== "string"
        || !actionContractIsKnown(participant.next_action)) {
      const error = new TypeError("invalid_admin_response");
      error.code = "invalid_admin_response";
      throw error;
    }
    seen.add(participantId);
  }
  return payload.participants;
}

export function classifyAdminHealth(payload) {
  if (!payload || payload.ok !== true) {
    return {
      mode: "unknown",
      canDistribute: false,
      showQa: false,
      tone: "blocked",
      message: "環境を確認できません・参加者への案内は禁止",
    };
  }
  const environment = String(payload.environment ?? "").toLowerCase();
  if (environment === "development") {
    return {
      mode: "development",
      canDistribute: false,
      showQa: true,
      tone: "development",
      message: "開発環境・一般参加者への案内は禁止（ID 999のみ）",
    };
  }
  if (environment === "production"
      && payload.collection_ready === true
      && payload.placeholder_assets === false) {
    return {
      mode: "production",
      canDistribute: true,
      showQa: false,
      tone: "ready",
      message: "本番環境・参加者への案内が可能",
    };
  }
  if (environment === "production") {
    return {
      mode: "production-blocked",
      canDistribute: false,
      showQa: false,
      tone: "blocked",
      message: "本番環境・収集準備未完了のため案内禁止",
    };
  }
  return {
    mode: "unknown",
    canDistribute: false,
    showQa: false,
    tone: "blocked",
    message: "環境設定が不明です・参加者への案内は禁止",
  };
}

export function visitStatusLabel(status) {
  return VISIT_STATUS_LABELS[String(status ?? "")] ?? "状態確認が必要";
}

export function visitIsVerifiedComplete(visit) {
  return visit?.status === "completed"
    && visit.finalized_at_ms !== null
    && visit.finalized_at_ms !== undefined
    && numberOrZero(visit.accepted_trials) === numberOrZero(visit.expected_trials)
    && numberOrZero(visit.accepted_recording_trials) === numberOrZero(visit.expected_recordings)
    && numberOrZero(visit.uploaded_recordings) === numberOrZero(visit.expected_recordings)
    && numberOrZero(visit.pending_recordings) === 0
    && numberOrZero(visit.missing_recordings) === 0
    && numberOrZero(visit.abandoned_recordings) === 0;
}

export function participantCategory(participant) {
  const serverCategory = String(participant?.next_action?.category ?? "");
  const code = String(participant?.next_action?.code ?? "");
  const action = participant?.next_action;
  if (!actionContractIsKnown(action)) return "attention";
  if ((code === "start_delayed" || code === "resume_delayed")
      && expectedPathForAction(action) === VISIT_PATHS.delayed
      && action?.path === VISIT_PATHS.delayed
      && actionCategoryIsSafe(action)) {
    return "delayed";
  }
  if (serverCategory === "attention") return "attention";
  if (serverCategory === "completed" || serverCategory === "ended") return "complete";
  if (["in_progress", "ready", "waiting"].includes(serverCategory)) return "in_progress";
  return "attention";
}

export function zipLabelForParticipant(participant) {
  return participant?.next_action?.code === "complete"
    ? "全時点完了データZIPを保存"
    : "現在保存済みの部分データZIPを保存";
}

export function formatJst(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function expectedPathForAction(action) {
  const code = String(action?.code ?? "");
  const visitType = String(action?.visit_type ?? "");
  if (!COPYABLE_ACTIONS.has(code)) return null;
  if (!code.endsWith(`_${visitType}`)) return null;
  return VISIT_PATHS[visitType] ?? null;
}

function actionCategoryIsSafe(action) {
  const code = String(action?.code ?? "");
  const category = String(action?.category ?? "");
  if (code.startsWith("start_")) return category === "ready";
  if (code.startsWith("resume_")) return category === "in_progress";
  return false;
}

function actionContractIsKnown(action) {
  const code = String(action?.code ?? "");
  const expectedCategory = ACTION_CATEGORY_BY_CODE[code];
  if (!expectedCategory || action?.category !== expectedCategory) return false;
  if (COPYABLE_ACTIONS.has(code)) {
    const expectedPath = expectedPathForAction(action);
    return expectedPath !== null && action?.path === expectedPath;
  }
  return action?.path === null;
}

export function operatorActionView(participant, healthState = classifyAdminHealth(null)) {
  const action = participant?.next_action;
  const code = String(action?.code ?? "");
  if (!actionContractIsKnown(action)) {
    return {
      code: "unknown",
      message: "状態判断を取得できません。手動更新し、課題は案内しないでください。",
      buttonLabel: null,
      instruction: null,
      path: null,
      copyable: false,
    };
  }
  const copy = ACTION_COPY[code];
  if (copy) {
    const expectedPath = expectedPathForAction(action);
    const pathIsSafe = expectedPath !== null
      && action?.path === expectedPath
      && actionCategoryIsSafe(action);
    const copyable = pathIsSafe && healthState.canDistribute === true;
    let message = copy.message;
    if (!pathIsSafe) {
      message = "案内先を安全に確認できません。手動更新し、課題は案内しないでください。";
    } else if (healthState.canDistribute !== true) {
      message = `${copy.message} 現在の環境では案内をコピーできません。`;
    }
    return {
      code,
      message,
      buttonLabel: copy.button,
      instruction: copy.instruction,
      path: pathIsSafe ? expectedPath : null,
      copyable,
    };
  }
  if (code === "wait_delayed") {
    const available = formatJst(action?.available_at_ms);
    return {
      code,
      message: available === "—"
        ? "後日の課題はまだ案内できません。手動更新して受付時刻を確認してください。"
        : `後日の課題は ${available}（日本時間）以降に案内できます。`,
      buttonLabel: null,
      instruction: null,
      path: null,
      copyable: false,
    };
  }
  if (Object.hasOwn(ACTION_MESSAGES, code)) {
    return {
      code,
      message: ACTION_MESSAGES[code],
      buttonLabel: null,
      instruction: null,
      path: null,
      copyable: false,
    };
  }
  return {
    code: "unknown",
    message: "状態判断を取得できません。手動更新し、課題は案内しないでください。",
    buttonLabel: null,
    instruction: null,
    path: null,
    copyable: false,
  };
}

export function buildInvitationMessage({ participantId, nextAction, origin }) {
  const canonicalId = canonicalParticipantId(participantId);
  if (!canonicalId) throw new TypeError("有効な参加者IDが必要です。");
  const view = operatorActionView(
    { next_action: nextAction },
    { canDistribute: true },
  );
  if (!view.copyable || !view.path) {
    throw new TypeError("この状態では案内を作成できません。");
  }
  const url = new URL(view.path, origin).href;
  const identityInstruction = "画面で参加者IDを入力し、表示された同じIDを確認してください。";
  return `参加者ID：${canonicalId}\n${VISIT_LABELS[nextAction.visit_type]}：${url}\n${view.instruction}${identityInstruction}途中からの場合も、同じURLと参加者IDで再開できます。`;
}

export function transferProgressText(receivedBytes, expectedBytes) {
  const received = Math.max(0, numberOrZero(receivedBytes));
  const expected = Math.max(0, numberOrZero(expectedBytes));
  const receivedMb = (received / (1024 * 1024)).toFixed(1);
  if (expected > 0) {
    const percent = Math.min(100, Math.floor((received / expected) * 100));
    const expectedMb = (expected / (1024 * 1024)).toFixed(1);
    return `${percent}%（${receivedMb} / ${expectedMb} MB）`;
  }
  return `${receivedMb} MB受信`;
}

function segmentLabel(visit) {
  const code = String(
    visit?.current_segment
      ?? visit?.current_segment_code
      ?? "",
  );
  const label = SEGMENT_LABELS[code];
  return label ? `${label}中` : null;
}

function visitFor(participant, visitType) {
  return Array.isArray(participant?.visits)
    ? participant.visits.find((visit) => visit.visit_type === visitType) ?? null
    : null;
}

function visitOverview(participant, visitType) {
  const visit = visitFor(participant, visitType);
  if (!visit) return { primary: "状態確認が必要", secondary: "手動更新してください" };
  if (visit.status === "completed" && !visitIsVerifiedComplete(visit)) {
    return { primary: "状態確認が必要", secondary: "保存完了の整合性を確認してください" };
  }
  const segment = segmentLabel(visit);
  let secondary = segment;
  if (visitType === "delayed"
      && participant?.next_action?.code === "wait_delayed") {
    const available = formatJst(participant.next_action.available_at_ms ?? visit.available_at_ms);
    secondary = available === "—" ? "受付時刻を確認中" : `${available}以降`;
  }
  if (!secondary && visit.last_seen_at_ms) {
    secondary = `最終アクセス ${formatJst(visit.last_seen_at_ms)}`;
  }
  return {
    primary: visitStatusLabel(visit.status),
    secondary,
  };
}

function storageOverview(participant) {
  const visits = Array.isArray(participant?.visits) ? participant.visits : [];
  const responses = visits.reduce((total, visit) => total + numberOrZero(visit.accepted_trials), 0);
  const expectedResponses = visits.reduce((total, visit) => total + numberOrZero(visit.expected_trials), 0);
  const recordings = visits.reduce((total, visit) => total + numberOrZero(visit.uploaded_recordings), 0);
  const expectedRecordings = visits.reduce(
    (total, visit) => total + numberOrZero(visit.expected_recordings),
    0,
  );
  const pending = visits.reduce((total, visit) => total + numberOrZero(visit.pending_recordings), 0);
  return {
    primary: `全3時点計画：回答 ${responses}/${expectedResponses}・音声 ${recordings}/${expectedRecordings}`,
    secondary: pending > 0 ? `音声保存待ち ${pending}件` : "サーバー受理分を表示",
  };
}

function setStatus(element, message = "", tone = "") {
  element.textContent = message;
  element.classList.toggle("is-error", tone === "error");
  element.classList.toggle("is-success", tone === "success");
}

function element(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  return node;
}

function appendTextLines(cell, primary, secondary = null) {
  cell.append(element("span", { className: "cell-primary", text: primary }));
  if (secondary) {
    cell.append(element("span", { className: "cell-secondary", text: secondary }));
  }
}

async function jsonRequest(path, { token = "", method = "GET", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? null : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = (response.headers.get("Content-Type") ?? "").includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = new Error("管理サーバーへの接続に失敗しました。");
    error.code = String(payload?.error?.code ?? "request_failed");
    error.status = response.status;
    error.requestId = response.headers.get("X-Request-ID");
    throw error;
  }
  return payload;
}

function localizedError(error) {
  const requestId = error?.requestId ? ` 問い合わせ番号: ${error.requestId}` : "";
  if (error?.code === "invalid_admin_response") {
    return "管理サーバーの応答を確認できないため、参加者への案内を停止しました。";
  }
  if (error?.code === "file_write_failed") {
    return "選択した保存先へZIPを書き込めませんでした。別の保存先を選んでください。";
  }
  if (error?.code === "zip_length_mismatch") {
    return "ZIPを最後まで受信できませんでした。ネットワーク接続を確認して再度保存してください。";
  }
  if (["zip_content_type_invalid", "zip_stream_unavailable"].includes(error?.code)) {
    return "結果ZIPの形式を確認できませんでした。手動更新してから再度保存してください。";
  }
  if (error?.status === 401) return `管理トークンが正しくありません。${requestId}`.trim();
  if (error?.status === 403) return `管理トークンまたはアクセス権限を確認してください。${requestId}`.trim();
  if (error?.status === 404) return `対象を確認できませんでした。手動更新してください。${requestId}`.trim();
  if (error?.status === 409) return `保存状態が更新されています。手動更新してから確認してください。${requestId}`.trim();
  if (error?.status >= 500) return `サーバーで処理できませんでした。時間をおいて手動更新してください。${requestId}`.trim();
  if (error instanceof TypeError && !error.status) {
    return "通信できませんでした。ネットワーク接続を確認してください。";
  }
  return `処理を完了できませんでした。${requestId}`.trim();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy") === true;
  textarea.remove();
  if (!copied) throw new TypeError("clipboard_unavailable");
}

function guideMessageForNewPre(participantId, origin) {
  const canonicalId = canonicalParticipantId(participantId);
  if (!canonicalId || canonicalId === "999") {
    throw new TypeError("invalid_participant_id");
  }
  return buildInvitationMessage({
    participantId: canonicalId,
    nextAction: {
      code: "start_pre",
      category: "ready",
      visit_type: "pre",
      path: VISIT_PATHS.pre,
    },
    origin,
  });
}

export async function consumeZipResponse(response, fileHandle, onProgress) {
  if (!response.body) {
    const error = new TypeError("zip_stream_unavailable");
    error.code = "zip_stream_unavailable";
    throw error;
  }
  const expected = Number(response.headers.get("Content-Length"));
  const expectedSize = Number.isSafeInteger(expected) && expected > 0 ? expected : 0;
  const reader = response.body.getReader();
  let writable = null;
  const chunks = [];
  let received = 0;
  try {
    if (fileHandle) {
      try {
        writable = await fileHandle.createWritable();
      } catch (cause) {
        const error = new Error("file_write_failed", { cause });
        error.code = "file_write_failed";
        throw error;
      }
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (writable) {
        try {
          await writable.write(value);
        } catch (cause) {
          const error = new Error("file_write_failed", { cause });
          error.code = "file_write_failed";
          throw error;
        }
      }
      else chunks.push(value);
      onProgress(received, expectedSize);
    }
    if (expectedSize > 0 && received !== expectedSize) {
      const error = new TypeError("zip_length_mismatch");
      error.code = "zip_length_mismatch";
      throw error;
    }
    if (writable) {
      try {
        await writable.close();
      } catch (cause) {
        const error = new Error("file_write_failed", { cause });
        error.code = "file_write_failed";
        throw error;
      }
    }
    return {
      blob: writable ? null : new Blob(chunks, { type: "application/zip" }),
      received,
      expected: expectedSize,
    };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (writable) await writable.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function createVisitCard(visitType, visit) {
  const card = element("section", { className: "visit-card" });
  card.append(element("h3", { text: VISIT_LABELS[visitType] }));
  if (!visit) {
    card.append(element("p", { text: "状態を取得できませんでした。" }));
    return card;
  }
  const segment = segmentLabel(visit);
  const statusLabel = visit.status === "completed" && !visitIsVerifiedComplete(visit)
    ? "状態確認が必要"
    : visitStatusLabel(visit.status);
  card.append(element("p", {
    text: `状態：${statusLabel}${segment ? `（${segment}）` : ""}`,
  }));
  card.append(element("p", {
    text: `回答保存：${numberOrZero(visit.accepted_trials)}/${numberOrZero(visit.expected_trials)}`,
  }));
  card.append(element("p", {
    text: `本番音声：${numberOrZero(visit.uploaded_recordings)}/${numberOrZero(visit.expected_recordings)}`,
  }));
  const pending = numberOrZero(visit.pending_recordings);
  const missing = numberOrZero(visit.missing_recordings);
  const abandoned = numberOrZero(visit.abandoned_recordings);
  if (pending > 0) card.append(element("p", { text: `音声保存待ち：${pending}件` }));
  if (missing > 0) card.append(element("p", { text: `不足音声：${missing}件` }));
  if (abandoned > 0) card.append(element("p", { text: `再開・終了に伴う非採用音声：${abandoned}件` }));
  card.append(element("p", { text: `開始：${formatJst(visit.first_started_at_ms)}` }));
  card.append(element("p", { text: `最終アクセス：${formatJst(visit.last_seen_at_ms)}` }));
  card.append(element("p", { text: `回答完了：${formatJst(visit.behavioral_completed_at_ms)}` }));
  card.append(element("p", { text: `保存確定：${formatJst(visit.finalized_at_ms)}` }));
  if (visitType === "delayed") {
    card.append(element("p", { text: `受付開始：${formatJst(visit.available_at_ms)}` }));
  }
  if (Array.isArray(visit.segments) && visit.segments.length > 0) {
    card.append(element("p", { text: "課題内訳：" }));
    for (const segment of visit.segments) {
      const label = SEGMENT_LABELS[segment.segment] ?? "状態確認が必要";
      const status = SEGMENT_STATUS_LABELS[segment.status] ?? "状態確認が必要";
      card.append(element("p", {
        text: `${label} ${status}・回答 ${numberOrZero(segment.accepted_trials)}/${numberOrZero(segment.expected_trials)}`,
      }));
    }
  }
  return card;
}

function interruptionText(interruption) {
  if (!interruption) return null;
  const visit = VISIT_LABELS[interruption.visit_type] ?? "課題";
  const mode = INTERRUPTION_MODE_LABELS[interruption.mode] ?? "中断・終了";
  const state = INTERRUPTION_STATE_LABELS[interruption.state] ?? "状態確認が必要";
  return `${visit}：${mode}（${state}、申請 ${formatJst(interruption.requested_at_ms)}）`;
}

function groupedCount(rows, key, value) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (total, row) => total + (row?.[key] === value ? numberOrZero(row.count) : 0),
    0,
  );
}

function createCountCard(label, value) {
  const card = element("div", { className: "count-card" });
  card.append(element("span", { text: label }));
  card.append(element("strong", { text: String(value) }));
  return card;
}

export function initializeAdminPage() {
  const nodes = {
    environmentBanner: document.getElementById("environment-banner"),
    connectionForm: document.getElementById("connection-form"),
    tokenInput: document.getElementById("admin-token"),
    connectButton: document.getElementById("connect-button"),
    disconnectButton: document.getElementById("disconnect-button"),
    connectionStatus: document.getElementById("connection-status"),
    workspace: document.getElementById("admin-workspace"),
    qaPanel: document.getElementById("qa-panel"),
    prePanel: document.getElementById("pre-invitation-panel"),
    preForm: document.getElementById("pre-invitation-form"),
    preInput: document.getElementById("pre-participant-id"),
    preButton: document.getElementById("copy-pre-invitation"),
    preUrl: document.getElementById("pre-url-preview"),
    preStatus: document.getElementById("pre-invitation-status"),
    refreshButton: document.getElementById("refresh-button"),
    overviewCounts: document.getElementById("overview-counts"),
    searchForm: document.getElementById("participant-search-form"),
    searchInput: document.getElementById("participant-search"),
    clearSearch: document.getElementById("clear-search"),
    participantRows: document.getElementById("participant-rows"),
    listStatus: document.getElementById("participant-list-status"),
    diagnostics: document.getElementById("diagnostics-content"),
  };

  const state = {
    token: "",
    connected: false,
    health: classifyAdminHealth(null),
    participants: [],
    summary: null,
    filter: "all",
    searchId: null,
    refreshGeneration: 0,
  };

  nodes.preUrl.textContent = new URL(VISIT_PATHS.pre, window.location.origin).href;

  function renderEnvironment() {
    nodes.environmentBanner.className = `environment-banner is-${state.health.tone}`;
    nodes.environmentBanner.textContent = state.health.message;
    nodes.qaPanel.hidden = !(state.connected && state.health.showQa);
    const distributionEnabled = state.connected && state.health.canDistribute;
    nodes.preInput.disabled = !distributionEnabled;
    nodes.preButton.disabled = !distributionEnabled;
    nodes.prePanel.setAttribute("aria-disabled", distributionEnabled ? "false" : "true");
  }

  function countsByCategory() {
    const counts = {
      all: state.participants.length,
      attention: 0,
      delayed: 0,
      complete: 0,
      preComplete: 0,
      immediateComplete: 0,
      delayedComplete: 0,
    };
    for (const participant of state.participants) {
      const category = participantCategory(participant);
      if (Object.hasOwn(counts, category)) counts[category] += 1;
      if (visitIsVerifiedComplete(visitFor(participant, "pre"))) counts.preComplete += 1;
      if (visitIsVerifiedComplete(visitFor(participant, "immediate"))) {
        counts.immediateComplete += 1;
      }
      if (visitIsVerifiedComplete(visitFor(participant, "delayed"))) {
        counts.delayedComplete += 1;
      }
    }
    return counts;
  }

  function renderOverview() {
    const counts = countsByCategory();
    nodes.overviewCounts.replaceChildren(
      createCountCard("開始済み", counts.all),
      createCountCard("事前課題 保存完了", counts.preComplete),
      createCountCard("本実験・直後課題 保存完了", counts.immediateComplete),
      createCountCard("後日の課題 保存完了", counts.delayedComplete),
      createCountCard("対応必要", counts.attention),
    );
    for (const countNode of document.querySelectorAll("[data-filter-count]")) {
      countNode.textContent = String(counts[countNode.dataset.filterCount] ?? 0);
    }
  }

  function visibleParticipants() {
    if (state.searchId) {
      return state.participants.filter(
        (participant) => String(participant.participant_id) === state.searchId,
      );
    }
    if (state.filter === "all") return state.participants;
    return state.participants.filter(
      (participant) => participantCategory(participant) === state.filter,
    );
  }

  async function copyParticipantAction(participant, feedback) {
    setStatus(feedback, "最新の保存状態を確認しています。", "");
    try {
      const refreshed = await refreshData({ announce: false });
      if (!refreshed) {
        setStatus(nodes.listStatus, "別の更新処理が行われたため、案内をコピーしませんでした。", "error");
        return;
      }
    } catch (error) {
      setStatus(nodes.listStatus, localizedError(error), "error");
      return;
    }
    const decision = freshCopyDecision(participant, state.participants, state.health);
    if (!decision.copyable) {
      const statusMessage = decision.reason === "environment_changed"
        ? "環境の準備状態が変わったため、案内をコピーしませんでした。"
        : decision.reason === "participant_missing"
          ? "参加者を最新一覧で確認できないため、案内をコピーしませんでした。"
          : "参加者の保存状態が変わったため、案内をコピーしませんでした。最新の「次の対応」を確認してください。";
      setStatus(nodes.listStatus, statusMessage, "error");
      return;
    }
    const latest = decision.participant;
    const message = buildInvitationMessage({
      participantId: latest.participant_id,
      nextAction: latest.next_action,
      origin: window.location.origin,
    });
    try {
      await copyText(message);
      setStatus(nodes.listStatus, `参加者ID ${latest.participant_id} の案内をコピーしました。`, "success");
    } catch {
      setStatus(nodes.listStatus, `コピーできませんでした。次を手動でコピーしてください。\n${message}`, "error");
    }
  }

  async function downloadParticipantZip(participant, button, progressWrap, progress, progressText) {
    const participantId = canonicalParticipantId(participant.participant_id);
    if (!participantId) {
      setStatus(progressText, "参加者IDを確認できないため保存できません。", "error");
      return;
    }
    button.disabled = true;
    progressWrap.hidden = false;
    progress.removeAttribute("value");
    setStatus(progressText, "ZIPを準備しています。", "");
    const suggestedName = `accentedness_p${participantId}_results.zip`;
    let fileHandle = null;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: "ZIP archive",
            accept: { "application/zip": [".zip"] },
          }],
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          setStatus(progressText, "保存先の選択をキャンセルしました。", "");
          progressWrap.hidden = true;
          button.disabled = false;
          return;
        }
        fileHandle = null;
      }
    }
    try {
      const response = await fetch(
        `/api/admin/participants/${encodeURIComponent(participantId)}/results.zip`,
        {
          headers: { Authorization: `Bearer ${state.token}` },
          cache: "no-store",
        },
      );
      if (!response.ok) {
        const error = new Error("zip_request_failed");
        error.status = response.status;
        error.requestId = response.headers.get("X-Request-ID");
        throw error;
      }
      if (!(response.headers.get("Content-Type") ?? "").includes("application/zip")) {
        await response.body?.cancel().catch(() => {});
        const error = new TypeError("zip_content_type_invalid");
        error.code = "zip_content_type_invalid";
        throw error;
      }
      const filename = participantCopyFilename(response.headers.get("Content-Disposition"));
      const result = await consumeZipResponse(
        response,
        fileHandle,
        (received, expected) => {
          if (expected > 0) {
            progress.max = expected;
            progress.value = Math.min(received, expected);
          } else {
            progress.removeAttribute("value");
          }
          setStatus(progressText, transferProgressText(received, expected), "");
        },
      );
      if (result.blob) {
        const objectUrl = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename ?? suggestedName;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        setStatus(progressText, "ZIPを受信し、ブラウザのダウンロードを開始しました。", "success");
      } else {
        setStatus(progressText, `${filename ?? suggestedName} を保存しました。`, "success");
      }
    } catch (error) {
      if ([401, 403].includes(error?.status)) {
        const message = localizedError(error);
        disconnect();
        setStatus(nodes.connectionStatus, message, "error");
      } else {
        setStatus(progressText, localizedError(error), "error");
      }
    } finally {
      button.disabled = false;
    }
  }

  function createParticipantRows(participant) {
    const category = participantCategory(participant);
    const mainRow = element("tr", { className: "participant-row" });
    mainRow.id = `participant-${participant.participant_id}`;
    if (state.searchId) mainRow.classList.add("is-highlighted");

    const idCell = element("th");
    idCell.scope = "row";
    idCell.append(element("span", {
      className: "participant-id",
      text: String(participant.participant_id),
    }));
    const chipText = category === "attention"
      ? "対応必要"
      : category === "delayed"
        ? "後日案内可"
        : category === "complete"
          ? "完了・終了"
          : category === "in_progress"
            ? "進行中"
            : "状態確認";
    idCell.append(document.createElement("br"));
    idCell.append(element("span", {
      className: `status-chip is-${category}`,
      text: chipText,
    }));
    mainRow.append(idCell);

    for (const visitType of ["pre", "immediate", "delayed"]) {
      const cell = element("td");
      const overview = visitOverview(participant, visitType);
      appendTextLines(cell, overview.primary, overview.secondary);
      mainRow.append(cell);
    }

    const saveCell = element("td");
    const saved = storageOverview(participant);
    appendTextLines(saveCell, saved.primary, saved.secondary);
    mainRow.append(saveCell);

    const nextCell = element("td");
    const action = operatorActionView(participant, state.health);
    nextCell.append(element("span", { className: "cell-primary", text: action.message }));
    const feedback = element("p", { className: "row-feedback" });
    if (action.buttonLabel) {
      const button = element("button", {
        className: "row-action",
        text: action.buttonLabel,
        type: "button",
      });
      button.disabled = !action.copyable;
      button.addEventListener("click", () => copyParticipantAction(participant, feedback));
      nextCell.append(button);
    }
    nextCell.append(feedback);
    mainRow.append(nextCell);

    const detailCell = element("td");
    const detailButton = element("button", {
      className: "secondary-button row-action",
      text: "詳細を表示",
      type: "button",
    });
    detailButton.setAttribute("aria-expanded", "false");
    detailCell.append(detailButton);
    mainRow.append(detailCell);

    const detailRow = element("tr", { className: "detail-row" });
    detailRow.hidden = true;
    const expandedCell = element("td");
    expandedCell.colSpan = 7;
    const details = element("div", { className: "participant-details" });
    const visitGrid = element("div", { className: "visit-grid" });
    for (const visitType of ["pre", "immediate", "delayed"]) {
      visitGrid.append(createVisitCard(visitType, visitFor(participant, visitType)));
    }
    details.append(visitGrid);
    const interruption = interruptionText(participant.open_interruption);
    if (interruption) {
      details.append(element("p", { text: `中断・終了状態：${interruption}` }));
    }
    details.append(element("p", {
      className: "supporting-text",
      text: `初回開始：${formatJst(participant.created_at_ms)}`,
    }));

    const actions = element("div", { className: "detail-actions" });
    const zipButton = element("button", {
      className: "secondary-button",
      text: zipLabelForParticipant(participant),
      type: "button",
    });
    const progressWrap = element("div", { className: "zip-progress" });
    progressWrap.hidden = true;
    const progress = document.createElement("progress");
    const progressText = element("p", { className: "operation-status" });
    progressWrap.append(progress, progressText);
    zipButton.addEventListener("click", () => downloadParticipantZip(
      participant,
      zipButton,
      progressWrap,
      progress,
      progressText,
    ));
    actions.append(zipButton, progressWrap);
    details.append(actions);
    expandedCell.append(details);
    detailRow.append(expandedCell);

    detailButton.addEventListener("click", () => {
      const expand = detailRow.hidden;
      detailRow.hidden = !expand;
      detailButton.setAttribute("aria-expanded", String(expand));
      detailButton.textContent = expand ? "詳細を閉じる" : "詳細を表示";
    });
    return [mainRow, detailRow];
  }

  function renderParticipantTable() {
    renderOverview();
    nodes.participantRows.replaceChildren();
    const visible = visibleParticipants().sort(
      (left, right) => Number(left.participant_id) - Number(right.participant_id),
    );
    if (visible.length === 0) {
      const row = element("tr", { className: "empty-row" });
      const cell = element("td", {
        text: state.searchId
          ? `参加者ID ${state.searchId} はまだ開始されていません。`
          : `${FILTER_LABELS[state.filter]}はいません。`,
      });
      cell.colSpan = 7;
      row.append(cell);
      nodes.participantRows.append(row);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const participant of visible) {
      fragment.append(...createParticipantRows(participant));
    }
    nodes.participantRows.append(fragment);
  }

  function renderDiagnostics() {
    nodes.diagnostics.replaceChildren();
    const summary = state.summary;
    if (!summary) {
      nodes.diagnostics.append(element("p", { text: "全体集計を取得できませんでした。手動更新してください。" }));
      return;
    }
    const grid = element("div", { className: "diagnostics-grid" });
    const active = groupedCount(summary.participants, "status", "active");
    const withdrawn = groupedCount(summary.participants, "status", "withdrawn");
    const pending = numberOrZero(summary.recording_integrity?.canonical_pending_uploads);
    const gaps = numberOrZero(summary.participant_id_span?.missing_ids_through_maximum);
    grid.append(
      createCountCard("参加中", active),
      createCountCard("参加終了", withdrawn),
      createCountCard("正本音声の保存待ち", pending),
      createCountCard("最大IDまでの欠番", gaps),
      createCountCard(
        "再開に伴う非採用音声",
        numberOrZero(summary.recording_integrity?.noncanonical_abandoned_slots),
      ),
      createCountCard(
        "参加終了時の不足音声",
        numberOrZero(summary.recording_integrity?.canonical_recordings_abandoned_after_termination),
      ),
    );
    nodes.diagnostics.append(grid);

    const flow = Array.isArray(summary.assignment_flow) ? summary.assignment_flow : [];
    if (flow.length === 0) return;
    const scroll = element("div", { className: "diagnostics-table-scroll" });
    const table = element("table", { className: "diagnostics-table" });
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of [
      "学習時アクセント",
      "セル",
      "割当",
      "事前 保存完了",
      "直後 保存完了",
      "後日 保存完了",
      "中断中",
      "参加終了",
    ]) {
      const th = element("th", { text: label });
      th.scope = "col";
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement("tbody");
    const accentLabels = {
      english: "American English",
      chinese: "Mandarin-accented English",
      japanese: "Japanese-accented English",
    };
    for (const row of flow) {
      const tr = document.createElement("tr");
      for (const value of [
        accentLabels[row.training_accent] ?? "状態確認が必要",
        numberOrZero(row.counterbalance_cell),
        numberOrZero(row.assigned_count),
        numberOrZero(row.pre_finalized_count),
        numberOrZero(row.immediate_finalized_count),
        numberOrZero(row.delayed_finalized_count),
        numberOrZero(row.currently_paused_count),
        numberOrZero(row.terminated_count),
      ]) {
        tr.append(element("td", { text: String(value) }));
      }
      body.append(tr);
    }
    table.append(head, body);
    scroll.append(table);
    nodes.diagnostics.append(scroll);
  }

  function renderAll() {
    renderEnvironment();
    renderParticipantTable();
    renderDiagnostics();
  }

  async function refreshData({ announce = true } = {}) {
    if (!state.token) throw new TypeError("admin_token_missing");
    const generation = ++state.refreshGeneration;
    nodes.refreshButton.disabled = true;
    if (announce) setStatus(nodes.listStatus, "サーバーの保存状態を更新しています。", "");
    const [healthResult, participantsResult, summaryResult] = await Promise.allSettled([
      jsonRequest("/api/health"),
      jsonRequest("/api/admin/participants", { token: state.token }),
      jsonRequest("/api/admin/summary", { token: state.token }),
    ]);
    if (generation !== state.refreshGeneration) return false;
    nodes.refreshButton.disabled = false;
    state.health = classifyAdminHealth(
      healthResult.status === "fulfilled" ? healthResult.value : null,
    );
    if (participantsResult.status === "rejected") {
      state.health = classifyAdminHealth(null);
      state.participants = [];
      state.summary = null;
      if ([401, 403].includes(participantsResult.reason?.status)) {
        state.token = "";
        state.connected = false;
        nodes.tokenInput.value = "";
        setConnectedUi(false);
        setStatus(nodes.connectionStatus, localizedError(participantsResult.reason), "error");
      }
      renderAll();
      throw participantsResult.reason;
    }
    try {
      state.participants = participantListFromAdminPayload(participantsResult.value);
    } catch (error) {
      state.health = classifyAdminHealth(null);
      state.participants = [];
      state.summary = null;
      renderAll();
      throw error;
    }
    state.summary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
    renderAll();
    if (announce) {
      const serverTime = formatJst(participantsResult.value?.server_now_ms);
      setStatus(
        nodes.listStatus,
        `${state.participants.length}名を更新しました。サーバー時刻 ${serverTime}（日本時間）`,
        "success",
      );
    }
    return true;
  }

  function setConnectedUi(connected) {
    state.connected = connected;
    nodes.workspace.hidden = !connected;
    nodes.disconnectButton.hidden = !connected;
    nodes.connectButton.hidden = connected;
    nodes.tokenInput.hidden = connected;
    nodes.tokenInput.previousElementSibling.hidden = connected;
    renderEnvironment();
  }

  function disconnect() {
    state.refreshGeneration += 1;
    state.token = "";
    state.connected = false;
    state.participants = [];
    state.summary = null;
    state.searchId = null;
    state.health = classifyAdminHealth(null);
    nodes.tokenInput.value = "";
    nodes.searchInput.value = "";
    nodes.clearSearch.hidden = true;
    nodes.refreshButton.disabled = false;
    setConnectedUi(false);
    setStatus(nodes.connectionStatus, "接続を解除しました。", "");
  }

  nodes.connectionForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = nodes.tokenInput.value;
    if (!token) return;
    nodes.connectButton.disabled = true;
    setStatus(nodes.connectionStatus, "接続しています。", "");
    state.token = token;
    try {
      await refreshData({ announce: false });
      state.connected = true;
      nodes.tokenInput.value = "";
      setConnectedUi(true);
      const message = state.health.canDistribute
        ? "接続しました。参加者の保存状態を表示しています。"
        : "接続しました。環境確認結果により、一般参加者への案内は無効です。";
      setStatus(nodes.connectionStatus, message, state.health.canDistribute ? "success" : "error");
      setStatus(nodes.listStatus, `${state.participants.length}名を表示しています。`, "success");
    } catch (error) {
      state.token = "";
      state.connected = false;
      nodes.workspace.hidden = true;
      setStatus(nodes.connectionStatus, localizedError(error), "error");
    } finally {
      nodes.connectButton.disabled = false;
    }
  });

  nodes.disconnectButton.addEventListener("click", disconnect);

  nodes.refreshButton.addEventListener("click", async () => {
    try {
      await refreshData();
    } catch (error) {
      nodes.refreshButton.disabled = false;
      setStatus(
        state.connected ? nodes.listStatus : nodes.connectionStatus,
        localizedError(error),
        "error",
      );
    }
  });

  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      state.searchId = null;
      nodes.searchInput.value = "";
      nodes.clearSearch.hidden = true;
      for (const candidate of document.querySelectorAll("[data-filter]")) {
        const selected = candidate === button;
        candidate.classList.toggle("is-selected", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      }
      renderParticipantTable();
      setStatus(nodes.listStatus, `${FILTER_LABELS[state.filter]}を表示しています。`, "");
    });
  }

  nodes.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const participantId = canonicalParticipantId(nodes.searchInput.value);
    if (!participantId) {
      setStatus(nodes.listStatus, "参加者IDは先頭ゼロのない半角数字で入力してください。", "error");
      return;
    }
    state.searchId = participantId;
    nodes.clearSearch.hidden = false;
    renderParticipantTable();
    const found = state.participants.some(
      (participant) => String(participant.participant_id) === participantId,
    );
    setStatus(
      nodes.listStatus,
      found
        ? `参加者ID ${participantId} を表示しています。`
        : `参加者ID ${participantId} はまだ開始されていません。`,
      found ? "success" : "error",
    );
  });

  nodes.clearSearch.addEventListener("click", () => {
    state.searchId = null;
    nodes.searchInput.value = "";
    nodes.clearSearch.hidden = true;
    renderParticipantTable();
    setStatus(nodes.listStatus, `${FILTER_LABELS[state.filter]}を表示しています。`, "");
  });

  nodes.preForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(nodes.preStatus, "", "");
    const participantId = canonicalParticipantId(nodes.preInput.value);
    if (!participantId || participantId === "999") {
      setStatus(
        nodes.preStatus,
        participantId === "999"
          ? "ID 999は開発用です。一般参加者には使用できません。"
          : "参加者IDは先頭ゼロのない半角数字で入力してください。",
        "error",
      );
      return;
    }
    if (!state.health.canDistribute) {
      setStatus(nodes.preStatus, "現在の環境では参加者へ案内できません。", "error");
      return;
    }
    nodes.preButton.disabled = true;
    setStatus(nodes.preStatus, "開始済みIDを確認しています。", "");
    try {
      const refreshed = await refreshData({ announce: false });
      if (!refreshed) {
        setStatus(nodes.preStatus, "別の更新処理が行われたため、案内をコピーしませんでした。", "error");
        return;
      }
      if (!state.health.canDistribute) {
        setStatus(
          nodes.preStatus,
          "環境の準備状態が変わったため、案内をコピーしませんでした。",
          "error",
        );
        return;
      }
      const existing = state.participants.some(
        (participant) => String(participant.participant_id) === participantId,
      );
      if (existing) {
        state.searchId = participantId;
        nodes.searchInput.value = participantId;
        nodes.clearSearch.hidden = false;
        renderParticipantTable();
        document.getElementById(`participant-${participantId}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        setStatus(
          nodes.preStatus,
          `参加者ID ${participantId} は開始済みです。新しい案内はコピーせず、該当行を表示しました。`,
          "error",
        );
        return;
      }
      const message = guideMessageForNewPre(participantId, window.location.origin);
      try {
        await copyText(message);
        setStatus(
          nodes.preStatus,
          `参加者ID ${participantId} と事前課題URLをコピーしました。発番台帳へ記録してください。`,
          "success",
        );
      } catch {
        setStatus(
          nodes.preStatus,
          `コピーできませんでした。次を手動でコピーしてください。\n${message}`,
          "error",
        );
      }
    } catch (error) {
      setStatus(nodes.preStatus, localizedError(error), "error");
    } finally {
      nodes.preButton.disabled = !state.health.canDistribute;
    }
  });

  window.addEventListener("pagehide", disconnect);

  renderEnvironment();
}

if (typeof document !== "undefined") {
  initializeAdminPage();
}
