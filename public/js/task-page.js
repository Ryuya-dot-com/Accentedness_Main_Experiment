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
    <form
      id="participant-id-form"
      class="identity-form"
      autocomplete="off"
      aria-labelledby="participant-id-heading"
      aria-describedby="participant-id-guidance participant-id-status"
      hidden
    >
      <h2 id="participant-id-heading">参加者情報の確認</h2>
      <p id="participant-id-guidance">担当者から案内された参加者IDを入力してください。氏名は、正しい参加者記録であることを次の画面で確認するために使います。</p>
      <div class="identity-fields">
        <label>
          <span>参加者ID</span>
          <input
            id="participant-id-input"
            name="participant_id"
            type="text"
            inputmode="numeric"
            pattern="[0-9]+"
            maxlength="32"
            autocomplete="off"
            required
          />
        </label>
      </div>
      <div class="actions">
        <button id="participant-id-submit" type="submit">参加者IDを確認</button>
      </div>
      <p id="participant-id-status" class="status" role="status"></p>
    </form>
    <form
      id="participant-name-form"
      class="identity-form"
      autocomplete="off"
      aria-labelledby="participant-name-heading"
      aria-describedby="participant-name-guidance participant-name-status"
      hidden
    >
      <h2 id="participant-name-heading">氏名の登録</h2>
      <p id="participant-name-guidance">ご自身の氏名を入力してください。入力後、保存前に確認画面を表示します。</p>
      <div class="identity-fields">
        <label>
          <span>氏名</span>
          <input
            id="participant-name-input"
            name="participant_name"
            type="text"
            maxlength="256"
            autocomplete="off"
            aria-describedby="participant-name-status"
            required
          />
        </label>
      </div>
      <div class="actions">
        <button id="participant-name-submit" type="submit">入力した氏名を確認</button>
      </div>
      <p id="participant-name-status" class="status" role="status"></p>
    </form>
    <section
      id="participant-name-confirmation"
      class="identity-form"
      role="region"
      aria-labelledby="participant-name-confirmation-heading"
      aria-describedby="participant-name-confirmation-prompt participant-name-confirmation-status"
      hidden
    >
      <h2 id="participant-name-confirmation-heading" tabindex="-1">氏名の確認</h2>
      <p id="participant-name-confirmation-prompt">次の氏名がご自身のものであることを確認してください。</p>
      <p id="participant-name-confirmation-value" class="summary" aria-live="polite" aria-atomic="true"></p>
      <div class="actions">
        <button id="participant-name-confirm" type="button">はい、この氏名です</button>
        <button id="participant-name-edit" class="secondary-button" type="button" hidden>氏名を修正</button>
        <button id="participant-name-reject" class="secondary-button" type="button">いいえ、違います</button>
      </div>
      <p id="participant-name-confirmation-status" class="status" role="status"></p>
    </section>
    <div id="participant-summary" class="summary" hidden></div>
    <div id="participation-setup" hidden>
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
        <button id="welcome-interruption-button" class="secondary-button" type="button">中断・終了</button>
      </div>
    </div>
    <p id="welcome-status" class="status" role="status">招待情報を確認しています。</p>
  </section>

  <section id="task" class="task" hidden>
    <div class="task-progress">
      <div class="progress-row">
        <strong id="progress-label">課題を準備しています</strong>
        <div class="progress-controls">
          <span id="save-state" class="save-state pending">データ保存：未開始</span>
          <button id="interruption-button" class="interruption-button" type="button">中断・終了</button>
        </div>
      </div>
      <div
        id="progress-track"
        class="progress-track"
        role="progressbar"
        aria-labelledby="progress-label"
        aria-valuemin="0"
        aria-valuemax="1"
        aria-valuenow="0"
        aria-valuetext="課題開始前"
      ><div id="progress-fill"></div></div>
      <p id="progress-detail" class="progress-detail">回答は各試行後に保存されます。通常完了時には「全試行・録音の保存完了」と表示します。途中で続けられなくなった場合は「中断・終了」を選んでください。</p>
    </div>
    <div id="stage" class="stage" aria-live="polite" tabindex="-1">
      <div id="fixation" class="fixation" aria-hidden="true" hidden>+</div>
      <img id="stimulus-image" class="stimulus-image" alt="" hidden />
      <div id="placeholder-card" class="placeholder-card" hidden>
        <span class="placeholder-kicker">画像プレースホルダー</span>
        <strong id="placeholder-gloss"></strong>
      </div>
      <div id="audio-cue" class="audio-cue" hidden aria-label="音声再生中"><span>♪</span></div>
      <div id="recording-indicator" class="recording-indicator" hidden><span></span>録音中</div>
      <div id="response-timer" class="response-timer" role="timer" aria-live="off" hidden>
        <div class="response-timer-row">
          <span id="response-timer-label">回答時間</span>
          <strong id="response-timer-value">残り10秒</strong>
        </div>
        <div class="response-timer-track" aria-hidden="true">
          <div id="response-timer-fill"></div>
        </div>
      </div>
      <div id="stage-message" class="stage-message" hidden></div>
      <button id="continue-button" class="continue-button" type="button" hidden>続ける</button>
      <a id="download-link" class="continue-button button-link" href="#" hidden>ZIPをこのパソコンに保存</a>
      <section id="interruption-choice" class="interruption-choice" aria-labelledby="interruption-choice-title" hidden>
        <h2 id="interruption-choice-title">課題を中断・終了しますか？</h2>
        <p id="interruption-choice-description">一時中断は、同じ招待リンクから研究用サーバーが受け付けた位置へ戻れます。参加終了を選ぶと、これ以降の課題には参加せず、再開できません。送信待ちデータがあれば、確定前に送信を試みます。</p>
        <div class="interruption-actions">
          <button id="pause-participation-button" type="button">一時中断する</button>
          <button id="terminate-participation-button" class="danger-button" type="button">参加を終了する</button>
          <button id="cancel-interruption-button" class="secondary-button" type="button">課題に戻る</button>
        </div>
      </section>
    </div>
    <p id="task-status" class="task-status" role="status"></p>
  </section>

  <section id="fatal" class="card error-card" role="alert" tabindex="-1" hidden>
    <h2>課題を続行できません</h2>
    <p id="fatal-message"></p>
    <p>表示されたコードを記録し、担当者へ知らせてください。</p>
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
