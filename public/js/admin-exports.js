const form = document.getElementById("search-form");
const tokenInput = document.getElementById("admin-token");
const participantInput = document.getElementById("participant-id");
const status = document.getElementById("status");
const tableBody = document.getElementById("exports");

function attachmentFilename(header, fallback) {
  const match = /filename="([A-Za-z0-9._-]+)"/u.exec(header ?? "");
  return match?.[1] ?? fallback;
}

async function authorizedFetch(path) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${tokenInput.value}` },
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (response.headers.get("Content-Type") ?? "").includes("application/json")
      ? await response.json()
      : null;
    throw new Error(payload?.error?.message ?? `Request failed (${response.status})`);
  }
  return response;
}

async function downloadExport(item, button) {
  button.disabled = true;
  status.textContent = `${item.phase_code} をダウンロードしています。`;
  try {
    const response = await authorizedFetch(item.download_path);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachmentFilename(response.headers.get("Content-Disposition"), item.filename);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = `${anchor.download} のダウンロードを開始しました。`;
  } finally {
    button.disabled = false;
  }
}

async function refresh() {
  status.textContent = "ZIP状態を取得しています。";
  const response = await authorizedFetch(
    `/api/admin/exports?participant_id=${encodeURIComponent(participantInput.value)}`,
  );
  const payload = await response.json();
  tableBody.replaceChildren();
  for (const item of payload.exports) {
    const row = document.createElement("tr");
    for (const value of [
      item.phase_code,
      item.state,
      String(item.member_count),
      item.zip_byte_count === null ? "—" : `${item.zip_byte_count} bytes`,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.state === "ready" ? "ZIPをダウンロード" : "生成待ち";
    button.disabled = item.state !== "ready";
    button.addEventListener("click", () => downloadExport(item, button).catch((error) => {
      status.textContent = error.message;
    }));
    action.append(button);
    row.append(action);
    tableBody.append(row);
  }
  status.textContent = payload.exports.length
    ? `${payload.exports.length}件を表示しました。`
    : "この参加者の完成済み／生成中ZIPはありません。";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  refresh().catch((error) => {
    status.textContent = error.message;
  });
});
