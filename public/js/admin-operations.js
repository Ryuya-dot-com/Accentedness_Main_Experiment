import { participantCopyFilename, writeResponseToFile } from "./api.js";

const tokenInput = document.getElementById("admin-token");
const participantForm = document.getElementById("participant-form");
const participantInput = document.getElementById("participant-id");
const participantActions = document.getElementById("participant-actions");
const participantState = document.getElementById("participant-state");
const invitationUrl = document.getElementById("invitation-url");
const dueBody = document.getElementById("due-visits");
const summary = document.getElementById("summary");
const status = document.getElementById("status");
const downloadResults = document.getElementById("download-results");

let participant = null;

async function authorizedJson(path, { method = "GET", body } = {}) {
  const headers = new Headers({ Authorization: `Bearer ${tokenInput.value}` });
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
  if (!response.ok) throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  return payload;
}

function showInvitation(invitation) {
  invitationUrl.value = invitation.invitation_url;
  invitationUrl.focus();
  invitationUrl.select();
  status.textContent = `${invitation.visit_type}リンクを発行しました。URLを該当参加者だけに配布してください。`;
}

async function loadParticipant() {
  const payload = await authorizedJson("/api/admin/participants", {
    method: "POST",
    body: {
      participant_id: participantInput.value,
      issue_pre_invitation: false,
    },
  });
  participant = payload.participant;
  participantActions.hidden = false;
  participantState.textContent = `参加者ID ${participant.participant_id}（${payload.created ? "新規登録" : "登録済み"}、学習時accent: ${participant.training_accent}、cell: ${participant.counterbalance_cell}）`;
  invitationUrl.value = "";
  status.textContent = "visit情報を取得しました。必要な時点のリンクだけを発行してください。";
}

async function issueVisit(visitType) {
  if (!participant) throw new Error("先に参加者IDを参照してください。");
  const visitId = {
    pre: participant.pre_visit_id,
    immediate: participant.immediate_visit_id,
    delayed: participant.delayed_visit_id,
  }[visitType];
  const payload = await authorizedJson(`/api/admin/visits/${visitId}/invitations`, {
    method: "POST",
    body: {},
  });
  showInvitation(payload.invitation);
}

async function downloadParticipantResults() {
  if (!participant) throw new Error("先に参加者IDを参照してください。");
  const suggestedName = `accentedness_p${participant.participant_id}_results.zip`;
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
        status.textContent = "保存先の選択をキャンセルしました。";
        return;
      }
      fileHandle = null;
      status.textContent = "保存先を直接選択できないため、通常ダウンロードに切り替えます。";
    }
  }
  if (fileHandle) {
    status.textContent = "結果ZIPを準備しています。";
  } else if (typeof window.showSaveFilePicker !== "function") {
    status.textContent = "結果ZIPを準備しています。通常ダウンロードを使用します。";
  }
  const response = await fetch(
    `/api/admin/participants/${participant.participant_id}/results.zip`,
    {
      headers: { Authorization: `Bearer ${tokenInput.value}` },
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const payload = (response.headers.get("Content-Type") ?? "").includes("application/json")
      ? await response.json()
      : null;
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/zip")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("結果ファイルの形式を確認できませんでした。");
  }
  const filename = participantCopyFilename(
    response.headers.get("Content-Disposition"),
  );
  if (fileHandle) {
    await writeResponseToFile(response, fileHandle);
    status.textContent = `${filename} を保存しました。`;
    return;
  }
  const expectedSize = Number(response.headers.get("Content-Length"));
  const blob = await response.blob();
  if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && blob.size !== expectedSize) {
    throw new Error("結果ZIPを最後まで受信できませんでした。");
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename ?? suggestedName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  status.textContent = "収集済み結果ZIPのダウンロードを開始しました。";
}

async function loadDueVisits() {
  const payload = await authorizedJson("/api/admin/delayed/due");
  dueBody.replaceChildren();
  for (const visit of payload.visits) {
    const row = document.createElement("tr");
    for (const value of [
      visit.numeric_id,
      new Date(Number(visit.target_at_ms)).toLocaleString("ja-JP"),
      visit.status,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.append(cell);
    }
    const actionCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Delayedリンクを発行";
    button.addEventListener("click", () => authorizedJson(
      `/api/admin/visits/${visit.visit_uuid}/invitations`,
      { method: "POST", body: {} },
    ).then((result) => showInvitation(result.invitation)).catch(showError));
    actionCell.append(button);
    row.append(actionCell);
    dueBody.append(row);
  }
  status.textContent = `${payload.visits.length}件の受付可能な遅延visitを表示しました。`;
}

async function loadSummary() {
  const payload = await authorizedJson("/api/admin/summary");
  summary.textContent = JSON.stringify(payload, null, 2);
  const gaps = Number(payload.participant_id_span?.missing_ids_through_maximum ?? 0);
  status.textContent = gaps > 0
    ? `全体状態を更新しました。ID 1から最大IDまでに${gaps}件の欠番があります。発番台帳と照合してください。`
    : "全体状態を更新しました。ID 1から最大IDまでの欠番はありません。";
}

function showError(error) {
  status.textContent = error instanceof Error ? error.message : String(error);
}

participantForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadParticipant().catch(showError);
});
participantActions.addEventListener("click", (event) => {
  const visitType = event.target?.dataset?.visit;
  if (visitType) issueVisit(visitType).catch(showError);
});
document.getElementById("load-due").addEventListener("click", () => loadDueVisits().catch(showError));
document.getElementById("load-summary").addEventListener("click", () => loadSummary().catch(showError));
downloadResults.addEventListener("click", () => downloadParticipantResults().catch(showError));
window.addEventListener("pagehide", () => {
  tokenInput.value = "";
  invitationUrl.value = "";
}, { once: true });
