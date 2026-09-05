const body = document.body;
const segment = body.dataset.segment;
const title = body.dataset.title ?? "実験課題";
const eyebrow = body.dataset.eyebrow ?? "英単語学習実験";
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
      <h2 id="participant-id-heading">参加者IDの確認</h2>
      <p id="participant-id-guidance">担当者から案内された参加者IDを入力してください。</p>
      <div class="identity-fields">
        <label>
          <span>参加者ID</span>
          <input
            id="participant-id-input"
            name="participant_id"
            type="text"
            inputmode="numeric"
            pattern="[1-9][0-9]*"
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
    <section
      id="participant-id-confirmation"
      class="identity-form"
      role="region"
      aria-labelledby="participant-id-confirmation-heading"
      hidden
    >
      <h2 id="participant-id-confirmation-heading" tabindex="-1">参加者IDの確認</h2>
      <p>次の参加者IDで開始します。</p>
      <p id="participant-id-confirmation-value" class="summary" aria-live="polite" aria-atomic="true"></p>
      <div class="actions">
        <button id="participant-id-confirm" type="button">はい、このIDで開始</button>
        <button id="participant-id-edit" class="secondary-button" type="button">IDを修正</button>
      </div>
    </section>
    <form
      id="researcher-token-form"
      class="identity-form"
      autocomplete="off"
      aria-labelledby="researcher-token-heading"
      aria-describedby="researcher-token-guidance researcher-token-status"
      hidden
    >
      <h2 id="researcher-token-heading">研究者用動作確認</h2>
      <p id="researcher-token-guidance">実素材を読み込むため、管理画面で使用している管理トークンを入力してください。トークンはこの画面を閉じると破棄され、実験データには保存されません。</p>
      <div class="identity-fields">
        <label>
          <span>管理トークン</span>
          <input
            id="researcher-token-input"
            name="researcher_token"
            type="password"
            autocomplete="off"
            spellcheck="false"
            required
          />
        </label>
      </div>
      <div class="actions">
        <button id="researcher-token-submit" type="submit">動作確認を準備</button>
      </div>
      <p id="researcher-token-status" class="status" role="status"></p>
    </form>
    <div id="participant-summary" class="summary" hidden></div>
    <div id="participation-setup" hidden>
      <div class="checklist">
        <p>開始前に確認してください。</p>
        <ul id="environment-checks"></ul>
      </div>
      <label class="consent-row">
        <input id="ready-check" type="checkbox" />
        <span>上の内容を確認しました。</span>
      </label>
      <div class="actions">
        <button id="start-button" type="button" disabled></button>
        <button id="welcome-interruption-button" class="secondary-button" type="button">中断・終了</button>
      </div>
    </div>
    <p id="welcome-status" class="status" role="status">参加者情報を確認しています。</p>
  </section>

  <section id="task" class="task" hidden>
    <div id="stage" class="stage" aria-live="polite" tabindex="-1">
      <div
        id="progress-track"
        class="stage-progress"
        role="progressbar"
        aria-label="進み具合"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="0"
        aria-valuetext="課題開始前"
        hidden
      ><div id="progress-fill"></div></div>
      <div id="fixation" class="fixation" aria-hidden="true" hidden>+</div>
      <img id="stimulus-image" class="stimulus-image" alt="" hidden />
      <div id="stimulus-emoji" class="stimulus-emoji" role="img" aria-label="" hidden></div>
      <div id="placeholder-card" class="placeholder-card" hidden>
        <span class="placeholder-kicker">画像を表示できません</span>
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
      <p id="prompt-keyboard-hint" class="prompt-keyboard-hint" hidden>キーボードのスペースキーを1回押してください。クリックや他のキーでは進みません。</p>
      <p id="continue-key-label" class="continue-key-label" hidden>Space</p>
      <button id="continue-button" class="continue-button" type="button" hidden>続ける</button>
      <a id="download-link" class="continue-button button-link" href="#" hidden>ZIPをこのパソコンに保存</a>
      <button id="interruption-button" class="interruption-button safe-screen-control" type="button" hidden>中断・終了</button>
      <section id="interruption-choice" class="interruption-choice" aria-labelledby="interruption-choice-title" hidden>
        <h2 id="interruption-choice-title">課題を中断・終了しますか？</h2>
        <p id="interruption-choice-description">一時中断すると、ここまでを保存し、同じ課題ページから続きに戻れます。参加終了を選ぶと、実験への参加を終え、再開できません。</p>
        <div class="interruption-actions">
          <button id="pause-participation-button" type="button">一時中断する</button>
          <button id="cancel-interruption-button" class="secondary-button" type="button">課題に戻る</button>
          <button id="terminate-participation-button" class="danger-button" type="button">参加を終了する</button>
        </div>
      </section>
    </div>
  </section>

  <section id="fatal" class="card error-card" role="alert" aria-labelledby="fatal-title" tabindex="-1" hidden>
    <h2 id="fatal-title">課題を続行できません</h2>
    <p id="fatal-message"></p>
    <div class="actions">
      <button id="fatal-reload" type="button" hidden>同じ課題を開き直す</button>
    </div>
    <p id="fatal-help">お問い合わせ番号と画面の状況を担当者へ知らせてください。</p>
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
  "課題中は別のタブやアプリに移動しないでください。",
];
if (microphone) {
  checks.push("ブラウザからマイクの許可を求められたら「許可」を選んでください。");
}
const checksElement = document.getElementById("environment-checks");
for (const check of checks) {
  const item = document.createElement("li");
  item.textContent = check;
  checksElement.append(item);
}

await import(segment === "learning" ? "/js/learning.js" : "/js/segment.js");
