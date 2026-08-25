const body = document.body;
const segment = body.dataset.segment;
const title = body.dataset.title ?? "実験課題";
const eyebrow = body.dataset.eyebrow ?? "Main Experiment";
const description = body.dataset.description ?? "担当者の案内に従って課題を進めてください。";
const microphone = segment !== "learning";

document.title = title;
document.getElementById("app").innerHTML = `
  <section id="welcome" class="card">
    <div class="header-row">
      <div>
        <p id="visit-eyebrow" class="eyebrow"></p>
        <h1 id="page-title"></h1>
      </div>
      <span id="connection-badge" class="badge">確認中</span>
    </div>
    <p id="page-description" class="lead"></p>
    <div id="participant-summary" class="summary" hidden></div>
    <div class="checklist">
      <p>開始前に確認してください。</p>
      <ul id="environment-checks"></ul>
    </div>
    <label class="consent-row">
      <input id="ready-check" type="checkbox" />
      <span>上記を確認し、担当者から開始の案内を受けました。</span>
    </label>
    <div class="actions">
      <button id="start-button" type="button" disabled></button>
    </div>
    <p id="welcome-status" class="status" role="status">招待情報を確認しています。</p>
  </section>

  <section id="task" class="task" hidden>
    <div class="progress-row">
      <span id="progress-label"></span>
      <span id="save-state" class="save-state">保存済み</span>
    </div>
    <div class="progress-track" aria-hidden="true"><div id="progress-fill"></div></div>
    <div id="stage" class="stage" aria-live="polite">
      <div id="fixation" class="fixation" hidden>+</div>
      <img id="stimulus-image" class="stimulus-image" alt="" hidden />
      <div id="placeholder-card" class="placeholder-card" hidden>
        <span class="placeholder-kicker">画像プレースホルダー</span>
        <strong id="placeholder-gloss"></strong>
      </div>
      <div id="audio-cue" class="audio-cue" hidden aria-label="音声再生中"><span>♪</span></div>
      <div id="recording-indicator" class="recording-indicator" hidden><span></span>録音中</div>
      <div id="stage-message" class="stage-message" hidden></div>
      <button id="continue-button" class="continue-button" type="button" hidden>続ける</button>
    </div>
    <p id="task-status" class="task-status" role="status"></p>
  </section>

  <section id="fatal" class="card error-card" role="alert" tabindex="-1" hidden>
    <h2>課題を開始できません</h2>
    <p id="fatal-message"></p>
    <p>ページを閉じずに、表示内容を担当者へ知らせてください。</p>
  </section>
`;

document.getElementById("visit-eyebrow").textContent = eyebrow;
document.getElementById("page-title").textContent = title;
document.getElementById("page-description").textContent = description;
document.getElementById("start-button").textContent = microphone ? "音声・マイク確認へ" : "学習を開始";
const checks = [
  "静かな場所で、パソコン版Google Chromeを使用してください。",
  microphone
    ? "ヘッドホンまたはイヤホンを装着し、マイクを接続してください。"
    : "ヘッドホンまたはイヤホンを装着してください。",
  microphone
    ? "ブラウザからマイクの許可を求められたら「許可」を選んでください。"
    : "途中で別のタブやアプリに移動しないでください。",
];
const checksElement = document.getElementById("environment-checks");
for (const check of checks) {
  const item = document.createElement("li");
  item.textContent = check;
  checksElement.append(item);
}

await import(segment === "learning" ? "/js/learning.js" : "/js/segment.js");
