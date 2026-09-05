# Cloudflare運用手順

本書のgateは本番環境でデータを回収できるかを判定するものであり、リポジトリのコード完成判定ではありません。研究ガバナンス上の判断は本書のscope外です。

## 1. 構成

- Worker: API、認証、manifest配信、現在試行と条件付き1試行先だけの刺激配信
- Static Assets: HTML、CSS、JavaScript、開発用プレースホルダー音声
- D1: 参加者、割当、visit、試行、応答、イベント、監査ログ
- R2 `STIMULI`: 非公開の本番画像・音声
- R2 `RECORDINGS`: 非公開の参加者録音

管理APIはBearer tokenで保護されています。本番ではそれに加え、`/api/admin/*` をCloudflare Accessで研究チームだけに制限してください。参加者IDには学籍番号や氏名を使わず、研究用の連番だけを使います。氏名は参加者画面、管理画面、API、D1、R2、browser storage、監査、ZIPのどこにも収集・表示・保存しません。旧`participant_names` tableはschema互換性のため残しますが、runtimeは読み書きせず0行を維持します。

## 2. 非本番pilotのセットアップと配備履歴

top-levelの非本番設定は`ENVIRONMENT=development`、`ASSET_VERSION=main-assets-v2`、`ALLOW_PLACEHOLDER_ASSETS=false`、`TEST_TOKEN_POLICY=same_token`を維持し、通常IDの受付は`ALLOW_DEVELOPMENT_PARTICIPANTS=false`を既定にします。公開push前にこの停止設定を配備し、healthの`development_participants_allowed=false`を確認します。`collection_ready=true`は素材・鍵の準備状態であり、developmentの受付許可とは別です。管理tokenが必要なID `999`は利用できます。新しい`env.pilot`は追加しません。

継続中pilotの実ID・正確な受付日時・照合hashは、Git対象外の`PILOT_PRIVATE.md`だけに記録します。監督下で永続保存pilotを実施するときだけ、下記の一時overrideで受付を開き、終了後は既定設定で閉じます。開放値をcommitせず、IDや受付時刻を公開文書へ転記しません。IDだけの導線は強い本人認証ではないため、開放中の第三者アクセスを技術的に防ぐ保証はありません。待機中は閉じたままとし、productionには適用しません。

```bash
# 承認済みpilotの実施直前だけ一時開放
npx wrangler deploy --env="" --var ALLOW_DEVELOPMENT_PARTICIPANTS:true --strict --no-x-provision
# 終了後は既定の受付停止へ戻す
npx wrangler deploy --env="" --strict --no-x-provision
```

2026-09-05、全261 tests・4,320 design監査・backup self-check・型・両環境dry-run・独立レビューPASS後、承認済みの各visit参加者ZIP自動配布をdevelopment version `58b00d67-d065-4bee-baa4-2707cff1db38`へ配備しました。`--env="" --strict --no-x-provision`で既存development Workerだけを更新し、migration・secret・production・D1/R2内容は変更していません。health 200、変更した5 asset（api.js／runner.js／segment.js／ui.js／styles.css）のローカルbyte一致、未認証・無効token・queryによるID指定の参加者ZIP拒否（401）、未認証研究者ZIP拒否（401）、Chromeの3共通入口のID入力画面を確認しました。通常IDは送信せず、実課題・マイク・参加者端末ZIPの実環境完了経路は実施していません。

配備前後に永続保存pilotのparticipant指定field、3 visit全field、24 item割付、290 manifest行、231 attempt全field、78 recording全fieldを順序付きでハッシュ化し、6比較すべて一致しました。研究者ZIPも前後とも78,673,909 B・83 entry・231回答・78 WAVで、CRCと全WAVのSHA-256／byte数／sample rate／sample数／長さを照合しました。ZIP生成時刻を除いた内容hashはともに`b1b094e3197164be538ed6e55ba1dcd3a2732820109110ed2c53cf6e82a6a28f`です。Delayed受付は`{DELAYED_AVAILABLE_AT_MS}`（非公開運用メモの受付日時）、scheduled・0回答・0 WAVのままです。永続保存pilotのPre・Immediateは旧version `56e4c04a-131d-41bd-8e7c-081ff5e257e0`の記録として保持し、以後のDelayedは新version・同一manifestから継続します。以下の旧履歴にある同一build継続予定はこの配備記録で更新し、同一build全visit E2Eとは扱いません。G2 liveと本収集NO-GOは維持します。

同日、Delayed受付前の中立日時案内をdevelopment version `c791f746-dcc1-4f82-b8b4-0063ed087de9`へ配備しました。変更は`ui.js`・`task-page.js`・`styles.css`の3 assetで、server・gate・設定は変更していません。22 files・264 tests、4,320 design監査、backup self-check、型、両環境dry-run、独立レビューを通過しました。local Chromeの合成ID 901・受付前403 mockで900×600の全文表示と手動再確認を確認し、配備後はhealth 200と3 assetのローカルbyte一致を確認しました。実Chromeの共通Delayed入口で永続保存pilotを確認すると、「受付日時（日本時間・秒切上げ）以降」と表示され、再確認ボタンで同じ入口のID入力へ戻りました。案内には赤い警告・お問い合わせ番号を出さず、実課題・マイク確認は開始していません。

この配備・受付前操作の前後でも、上記と同じ6比較のハッシュはすべて一致し、Delayedのsession・内部invitation・visit監査は各0件でした。受付の正本は引き続き`{DELAYED_AVAILABLE_AT_MS}`で、画面上だけ秒単位へ切り上げています。今回R2の全WAV再取得はしておらず、上記ZIP照合は前回配備時の証拠です。以後のDelayedはこの現行version・同一manifestで継続し、G2 live・実環境での参加者完了時ZIP取得は未完了、productionは未変更です。

現行実装は、参加者が共通Pre入口で入力したIDと、次画面に表示された同じIDを確認した後に、参加者ID・3 visit・24 item割当・6 segment・290 trial・監査記録をD1へ一括保存します。途中失敗後も同じIDの保存済みdesignを再利用し、条件を再抽選しません。確認前はD1を書き換えません。

resourceを変更する前に、Wranglerの認証先、採用plan、主担当・代替担当を確認し、exact nameの衝突をread-onlyで再点検します。

```bash
npm install
npx wrangler whoami
npx wrangler deployments list --env=""
npx wrangler d1 list
npx wrangler r2 bucket list
```

2026-08-26の監査時点では、`accentedness-main-experiment`、`main-experiment`、`main-experiment-recordings`、`main-experiment-stimuli`の衝突はありませんでした。ただし、この記録だけを将来の作成根拠にせず、変更直前に再確認します。

accountと変更範囲を確定した後、明示的に非本番resourceだけを作成します。production名のresourceはこの段階で作りません。

```bash
npx wrangler d1 create main-experiment
npx wrangler r2 bucket create main-experiment-recordings
npx wrangler r2 bucket create main-experiment-stimuli
```

locationを指定しない場合、D1とR2は作成要求元に近いregionを選ぶAutomaticになります。本pilotはこの公式推奨defaultを使います。location hintは性能上の希望であり、data residency保証ではありません。

D1作成時の`database_id`を`wrangler.jsonc`のtop-level `DB` bindingだけへ追記し、差分とresource名を照合します。

`0006_identity_and_participation_interruptions.sql`は2026-08-26に非本番D1へ適用済みで、remote migrationのpendingが0件であることを確認しています。現行Workerも`0006`を前提に配備済みです。新しい環境ではmigration `0001`から`0006`までを順に適用してからWorkerをdeployします。適用済みmigrationは書き換えず、今後のschema変更はforward-onlyの追加migrationにします。

```bash
npx wrangler d1 migrations list DB --remote --env="" --no-x-provision
npx wrangler d1 migrations apply DB --remote --env="" --no-x-provision
npx wrangler deploy --env="" --strict --no-x-provision
```

Wranglerの自動resource provisioningは既定で有効です。明示作成後は`--no-x-provision`を付け、binding不足を黙って新規resource作成で補わせません。`--strict`はDashboard等の競合するremote変更がある場合にuploadを止めます。

`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`がまだない新規環境では、互いに異なる長い乱数値を設定します。氏名は収集しないため`IDENTITY_SECRET`は設定しません。値をcommand引数、文書、chat、shell historyへ書きません。

```bash
npx wrangler secret put ADMIN_TOKEN --env=""
npx wrangler secret put RANDOMIZATION_SECRET --env=""
npx wrangler secret list --env=""
```

現在のWranglerでは`secret put`自体が新しいWorker versionを作り、直ちにdeployします。単なる設定保存とは扱いません。`ADMIN_TOKEN`は24文字以上かつ`[A-Za-z0-9._~-]+`だけで構成します。hexはこの条件を満たします。`RANDOMIZATION_SECRET`も24文字以上とし、`ADMIN_TOKEN`とは別値にします。`RANDOMIZATION_SECRET`は同じassignment version中固定します。

初回deployへsecretを同梱する場合は、Git・Dropbox外の権限`0600`一時fileを`--secrets-file`へ渡し、成功直後にそのfileを削除します。`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`を同梱し、secret値をcommand引数、標準出力、shell historyへ出しません。2026-08-26の旧非本番bootstrapも`--secrets-file`方式でした。

2026-08-26以降、非本番`ADMIN_TOKEN`の暫定正本はrepository外の親directoryにある`.env`です。file modeは`0600`とし、この単一keyだけを標準入力経由でWranglerへ渡します。`.env`全体またはtoken値を表示・記録しません。rotation後に新tokenでHTTP 200、旧tokenでHTTP 403を確認し、bootstrap用の一時handoff directoryは削除済みです。この`.env`はDropbox同期対象なので、現時点の非本番運用にだけ用い、production secretの恒久正本とはみなしません。`RANDOMIZATION_SECRET`、production resource、production secretはこのrotationで変更していません。

`0006`適用後の非本番`GET /api/health`の期待値は、`environment=development`、`development_participants_allowed=false`、`placeholder_assets=true`、`test_token_policy=undecided`、`test_token_policy_ready=false`、`admin_authentication_ready=true`、`randomization_ready=true`、`secrets_independent=true`、`collection_ready=false`です。これは通常参加者向けの収集をサーバー側で止めた正常なplaceholder状態です。研究者用ID `999`だけは、`RESEARCHER_TEST_ASSET_VERSION=main-assets-v2`のprivate R2刺激を既存`ADMIN_TOKEN`で認証して読みます。配備後QAは6つのcanonical pageを`999`で個別に確認し、実施前後でD1 application tableと`RECORDINGS` R2が増えていないことを確認します。ID `999`では通常参加者のID確認、永続manifest、D1/R2保存、再開、5日gate、結果ZIPを検証できません。通常IDによる永続保存pilotは別途明示承認され、対象の非本番環境で`ALLOW_DEVELOPMENT_PARTICIPANTS=true`を明示した場合だけ実施します。過去の技術検証結果は現行共通入口の証拠に流用しません。現在の非本番URLは`https://accentedness-main-experiment.komuro-4121.workers.dev`です。

2026-09-05、`main-assets-v2`の26 WebPと515 WAVを非本番`STIMULI`の`stimuli/main-assets-v2/`へ配置し、全541 objectを別の一時領域へ再取得して元bundleとbyte単位で一致することを確認しました。development Worker version `fb92ebab-f356-47a8-b205-73d9da3e44b3`は、通常参加者向け`main-v10-english-practice-placeholder`／`placeholder-v2`のNO-GOを維持し、ID `999`だけが管理token付きで`main-assets-v2`を読みます。ID `999` live APIは6 scopeすべてHTTP 200、trial数26 / 146 / 26 / 33 / 26 / 33、`persistence=none`を満たし、重複を除く実刺激169件（WAV 143、WebP 26）をすべて正しい形式で取得しました。未認証bootstrapと刺激取得は401、ID `998`は422で拒否され、前後ともD1主要6表と`RECORDINGS`は0件でした。実画面・再生・実マイクはbrowser操作先を利用できず未確認であり、永続manifestの証拠にもならないためG0は未完了です。productionは変更していません。

同日、通常IDが公開development URLから開始できる不整合を修正し、version `d997b8a6-b079-4106-9f87-e63fe45974a0`をdevelopmentだけへ配備しました。healthは`development_participants_allowed=false`／`collection_ready=false`で、未使用通常IDのvisit startはHTTP 503 `development_participants_blocked`です。ID `999`の6 scopeは引き続きHTTP 200・`persistence=none`で、代表WAV / WebPも正しい形式で取得しました。確認前後でdevelopment D1の13 application tableと`RECORDINGS`は全件0でした。productionは配備していません。

同日、PI／ユーザーから、ID `999`で6つのcanonical pageを実Chrome・実マイクにより完遂し、G0が完了したとの報告を受領しました。個別画面の観測値は提供されていないため推定追記していません。完了後にdevelopment D1の13 application tableが全件0、`RECORDINGS`が0 object / 0 Bであることをread-onlyで確認しました。これは通常参加者の永続保存・再開・5日gate・ZIPの証拠ではなく、G1以降と本収集は未承認です。

同日、G1は永続保存pilotで明示承認されました。開始前のread-only確認ではdevelopment D1の13 application tableがすべて0行、development `RECORDINGS`が0 object / 0 Bであり、削除対象の既存実験データはありませんでした。`d1_migrations`、development `STIMULI`、production D1/R2は初期化対象外です。G1では`main-v10-english-practice-real-assets`／`main-assets-v2`、`ALLOW_PLACEHOLDER_ASSETS=false`、`ALLOW_DEVELOPMENT_PARTICIPANTS=true`、`TEST_TOKEN_POLICY=same_token`をdevelopmentだけに適用し、既存`RANDOMIZATION_SECRET`を変更しません。永続保存pilotは本番参加者へ再利用せず、pilot途中に削除・再作成して割付を引き直しません。

同日、development version `56e4c04a-131d-41bd-8e7c-081ff5e257e0`でG1 Preの26回答・24 WAV・保存位置からの再開・研究者ZIPの自動回収を確認しました。続く永続保存pilotのImmediateも205回答・54 WAV・送信待ち0件で完了しました。最終回答の受理時刻は`{IMMEDIATE_ACCEPTED_AT_MS}`、保存確定時刻は`{IMMEDIATE_FINALIZED_AT_MS}`です。Delayed受付は最終回答の受理から正確に120時間後の`{DELAYED_AVAILABLE_AT_MS}`（非公開運用メモの受付日時）に設定され、受付前の開始拒否を実Chromeでも確認しました。累積231回答・78 WAVの研究者ZIPを自動回収し、全録音をmetadataと照合済みです。G2のDelayed・参加者端末ZIPは承認済みですが未完了です。永続保存pilotは受付時刻以降に同じbuild・manifestでDelayedから続けますが、ソフトウェアの検証をその日まで止めません。参加者ZIPは次節のローカル合成環境で前倒し確認します。Pre・Immediateの再実施、remote時刻の手動書換え、データ削除、割付再生成はしません。これは操作補助付きの技術pilotであり、独立参加者のユーザビリティ・絶対RTの証拠ではありません。本収集はNO-GOのままです。

### 研究者用の非保存test

この導線は`ENVIRONMENT=development`の非本番だけで有効です。productionでは入口を表示せず、test APIも認証処理より先に404で拒否します。6つのcanonical URLを通常参加者の保存済みsessionがない隔離Chrome profileで開き、参加者ID欄へ正確に`999`、続けて管理画面と同じ管理トークンを入力します。氏名入力と管理者側の事前参加者作成はありません。管理トークンはJavaScript memoryだけに保持し、入力直後にpassword欄を空にします。URL、sessionStorage、localStorage、IndexedDB、API body、実験データへ入れません。bootstrapと`GET /api/test/stimuli/{audio|image}`の両方がBearer認証を要求し、後者は`RESEARCHER_TEST_ASSET_VERSION`配下の正規刺激keyだけをprivate R2からstreamします。各起動はfresh random manifestで独立し、回答・録音をD1、`RECORDINGS`、IndexedDBへ書きません。文字列`test`、`0999`、`P999`はtestモードになりません。「研究者用テスト」と「保存・送信なし」は開始前と完了後に確認し、注視点・刺激・回答時間には表示されないことを確認します。testモード専用の終了buttonは設けず、途中で止める場合はtabを閉じます。

この導線で確認できるのは、そのpageの説明、練習、注視点、実画像・実音声、発話収録、回答時間、進捗barと計測中HUDの非表示です。通常参加者のID確認、page間session、D1/R2 ACK、再開、Immediateから5日以上のDelayed gate、参加者ZIPは確認できません。それらのpilotを`999`で代替しません。配備後QAでは実施前後のD1 application table件数と`RECORDINGS` R2 object数を照合し、増加があればtest成功と扱わず停止します。Cloudflare側の通常のrequest metadata logまで存在しないという意味ではありません。

試行中に別タブ・別アプリへ移ると、刺激提示前を含め、その回を測定用に継続せず警告画面にします。ID `999`では回答・録音が保存されていないことを表示し、「動作確認を最初からやり直す」で同じページを再読み込みして、`999`と管理トークンを再入力します。通常参加者では現在の回の保存状態を断定せず、「同じ課題を開き直す」から同じIDを再入力・確認し、サーバーが確認できた位置から再開します。開き直せない、または同じ警告が繰り返される場合だけ、表示されたお問い合わせ番号を担当者へ伝えます。

### 5日を待たないローカル参加者ZIP検証

`npm run preview:participant-copy`は、既存Workerと画面をWranglerの一時ローカルD1/R2で起動します。権限0700の空の一時rootから起動し、repositoryの`.dev.vars`／`.env`探索を分離します。実secret・remote binding・実刺激・永続storageは使わず、起動時にdummy認証値との一致（値は非表示）、空DB、loopback URLを検査します。終了はCtrl-Cで、harnessと一時rootを破棄します。公開seed APIや本番用bypassはありません。

`npm run preview:participant-copy -- pre`／`-- immediate`／`-- delayed`で対象visitを選びます（省略時delayed、不正引数は起動前に拒否）。既存自動testと共用するfixtureで、ローカル専用ID `901`に選択visitまでの回答と10秒／48 kHz／PCM16 mono無音WAVを準備します。全3 visitの場合は290回答・132 WAV（計126,725,808 B）です。`901`はremoteで使う検証IDではありません。Delayedの受付日時を変更するのも、この使い捨てDBだけです。画面から通常の完了APIを通すため、選択visitだけ未確定で止め、過去visitは確定済みにします。

1. 対象visitごとにコマンドを起動し、表示された1つのloopback URLをChromeで開き、ID `901`を入力・確認し、開始ボタンを押します。通常完了後は同じtabを再読み込みして保存済みsessionで再取得を確認します。完了済みvisitにIDだけで新規入場はしません。全回答をseed済みなので、刺激提示やマイク確認は繰り返しません。
2. 保存操作を追加せず`accentedness_p901_{pre|immediate|delayed}_{YYYYMMDD}.zip`のダウンロードが始まることを確認し、「ZIPをもう一度ダウンロード」でも再取得します。保存先はChromeの設定に従います。「ダウンロード前に各ファイルの保存場所を確認する」が有効ならブラウザの確認は残り、アプリから回避しません。このIDのファイルは合成検証用であり実データへ混ぜません。
3. 保存したファイルを展開検査し、全entryのCRC、Preは26回答・24 WAV／Immediateは累積231回答・78 WAV／Delayedは累積290回答・132 WAV、各録音と`responses.json`のSHA-256・byte数・sample rate・sample数・長さを照合します。同一完了画面の再取得リンクは同じBlobを使うのでZIP全体のbyte一致も確認します。再読み込み後にserverから再取得した場合だけ生成日時が変わり得るため、ZIP全体hashではなく回答・録音・完了時刻の一致を検査します。

これはZIP容量・受け渡し・通常完了画面の技術確認です。直接seedした回答や無音WAVを、実マイク・upload API・実時間5日経過・絶対RT・独立参加者のユーザビリティの証拠にしません。書き込み失敗や通信切断の自動testと、実Chromeで観測した結果も区別します。永続保存pilotの実データとG2 live未完了は維持します。

2026-09-05：最終の空root・dummy認証値だけの環境で、290回答／132 WAV、完了前ZIP拒否、実Chromeの通常ID入力→完了API→追加操作なしの自動ダウンロード、再読み込み後のserver再取得、手動再ダウンロードを確認しました。Chromeが既存の検証ファイルとの重複により付番した`accentedness_p901_20260905 (2).zip`／`(3).zip`／`(4).zip`は各127,049,425 Bで、全134 entryのCRC、290回答、132 WAVのSHA-256・形式・metadata照合がPASSしました。再読み込みでも回答と完了時刻は不変、同じBlobの手動再取得はbyte単位でも一致しました。完了済みvisitを監視しない修正により再読み込み後15秒経過でfatalにならず、900×600でも本文とリンクが重ならないことを実画面で確認しました。22 files・256 tests、4,320 design監査、backup self-check、型、両環境dry-runはPASS。これは合成無音データのlocal証拠で、remote G2完了とは数えません。実配備は行っていません。

### 既存pilotの通信・計測監査（2026-09-05）

永続保存pilotの保存済みcanonical 231回答をdevelopment D1からSELECTだけで集計しました。実施時versionはPre・Immediateとも`56e4c04a-131d-41bd-8e7c-081ff5e257e0`、監査時点の配備は`c791f746-dcc1-4f82-b8b4-0063ed087de9`です。今回runtime・test・設定・配備を変更せず、実課題・実マイクを再実施していません。R2のWAVも今回は再取得せず、D1の録音metadataとの照合です。

コードでは、`runner.js`の15秒ごとのheartbeat、提示直後のonset／lateness event、trial認可後に1秒遅延させる次刺激のfetch・decode、前trialの応答受理後に1秒遅延させるWAV uploadが、刺激提示・発話計測中に重なり得ます。現在trialの刺激読込と開始認可はonset前、応答の永続化・送信はそのtrialの計測後です。`audio-engine.js`は`startCapture()`後の`stopCaptureAt()`呼出時に停止予定frameをAudioWorkletへ送り、`pcm-recorder-worklet.js`がsample位置で停止します。これはmain threadの停止通知受信時刻とは別です。

本番trialの`onset_late_ms`の記述統計は次のとおりです。単位はms、中央値は偶数件の場合に中央2値の平均、P95は昇順`ceil(0.95 × n)`番目です。L2の30件には主要24語と未学習統制6語を含めています。これはNo/Highの主要解析ではありません。

| 保存済み本番区間 | n | 中央値 | P95 | 最大 |
|---|---:|---:|---:|---:|
| Pre Picture Naming | 24 | 3.85 | 7.90 | 9.20 |
| Immediate Learning | 144 | 1.50 | 4.60 | 85.80 |
| Immediate Picture Naming | 24 | 2.95 | 5.30 | 5.70 |
| Immediate L2-to-L1 | 30 | 2.50 | 5.40 | 5.60 |

85.8 msの外れ値はImmediateのvisit ordinal `17`（Learning、画面非表示flagなし）です。画面非表示flagがあるのは別のLearning ordinal `27`で、遅延は1.4 msでした。この2件を混同せず、削除・書換え・再提示はしていません。Learning画像消去の予定時刻超過は最大3.2 ms、Pre／Immediate Picture Namingでは最大17.3／15.1 msでした。これらも画像消去処理のbrowser timestampであって、実画面の光学測定ではありません。

発話85件の成功受理metadata（本番78＋練習7）では、`missing_input_frames`・`sample_count_difference`は全件0、`round(capture_stop_context_s × sample_rate_hz) - round(scheduled_stop_context_s × sample_rate_hz)`も全件0でした。本番78件のsample数・sample rateはD1 `recordings`と一致し、練習7件のWAVは保存されていません。clientは欠落を検出すると保存前に停止し、serverも非0を拒否するため、これは**成功受理に条件づけられた整合性確認であり、実施全体の無欠損率ではありません**。機器・OSの入力欠落が正常なsample列として渡された場合まで検出する保証もありません。

再集計する場合は、次の読取専用SQLでcanonicalだけを取り出し、`payload_json`をparseして上記fieldを集計します。`practice=0`を提示遅延表、非Learningを発話metadata確認の母集団とします。`performance.now()`をページ間で直接差し引かず、server epoch時刻やAudioContext時刻とも直接混ぜません。

```sql
SELECT v.visit_type, tm.ordinal, tm.segment, tm.practice, ta.payload_json,
       r.sample_count AS wav_sample_count, r.sample_rate_hz AS wav_sample_rate_hz
FROM trial_manifest tm
JOIN trial_attempts ta ON ta.attempt_uuid = tm.canonical_attempt_uuid
JOIN visits v ON v.visit_uuid = tm.visit_uuid
JOIN participants p ON p.participant_uuid = v.participant_uuid
LEFT JOIN recordings r ON r.attempt_uuid = ta.attempt_uuid
WHERE p.numeric_id = ?
ORDER BY v.visit_type, tm.ordinal;
```

既存eventはLearning onset 146、Picture Naming onset 53、L2 schedule 33、lateness 34、visibility change 5件でした。event件数はcanonical回答数とは同一ではありません。各通信のbrowser内開始・終了時刻とResource Timing／main-thread traceは保存されていないため、85.8 msの原因や、どの通信がどれだけ重なったかは遡及判定できません。sample整合性から、通信の無影響や絶対RT校正を結論しません。AudioWorkletとcontrol threadの分離は[Web Audio仕様](https://www.w3.org/TR/webaudio-1.0/)に基づきますが、実ヘッドホン出力・マイク入力・pixel onsetの外部校正を代替しません。[performance.timeOrigin](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin)もclient/serverの時計同期を保証しません。

独立レビューでは既存のsession安全策、曝露event、先読み、応答先行保存とWAV送信を維持する方針をPASSとしました。原因未確定のまま新scheduler・Queue・telemetryを追加せず、heartbeatだけの抑制や毎trialの全WAV送信待ちも行いません。追加のPerformance/Network traceは収集開始の必須条件にせず、提示遅延の再発や録音frame異常など、具体的な問題を切り分ける必要が生じた場合だけ実施する任意診断とします。その場合は隔離localの通常participant経路で合成刺激・合成音声を使い、通信・保存処理を省略するID `999`で代替しません。traceを省略することは通信の無影響を意味しません。実参加者の再実施やremote 永続保存pilotの変更は不要です。G3のRT方針・実施者導線確認、G2 liveは未完了であり、本収集NO-GOを維持します。

## 3. productionの初回セットアップ

production用Worker、D1、2つのR2 bucketは2026-08-30に作成済みです。再作成しません。2026-09-05のupload前read-only preflightでは、開発・production D1とも主要application table 6表が各0件、開発・productionの`STIMULI`／`RECORDINGS` 4 bucketが各0 object、両D1ともpending migrationが0件でした。同日16時台のrelease前再確認でも、productionの13 application tableは全0行、両R2 bucketは各0 object / 0 B、secret登録数とpending migrationは各0でした。公開healthはHTTP 200・`collection_ready=false`です。remoteで稼働中のproduction Workerは`main-v7-barcroft-learning-order-no-practice-speech-wav-placeholder`／`placeholder-v2`であり、未deployのローカル`main-v10-english-practice-placeholder`とは異なります。今回のrelease整理ではproductionへのupload・secret設定・deployは行いません。

既存production D1の`database_id`は`776dd207-5132-4021-a24d-a22793d1e840`で、`wrangler.jsonc`の`env.production`にある`DB` bindingへ明記済みです。環境別のD1、R2、vars、secretは継承されないため、default非本番と取り違えないことを別担当者が確認します。productionへ進む承認後、`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`を別値で設定し、migration、最後に対応Workerをdeployします。

```bash
npx wrangler secret put ADMIN_TOKEN --env production
npx wrangler secret put RANDOMIZATION_SECRET --env production
npx wrangler secret list --env production
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler deploy --env production --strict --no-x-provision
```

`secret put`は各回とも即時deployを伴います。2つは互いに異なる長い乱数値を使い、`RANDOMIZATION_SECRET`は同じassignment version中変更しません。新規Workerへはrepository外の`--secrets-file`で2 secretを最初のversionに同梱しても構いません。

`0005_remove_recording_exports.sql` が削除するのは、旧Queue方式で作った派生ZIPの状態表だけです。canonical応答・録音metadata・監査logは削除しません。旧版を一度でも配置した環境では、bindingを設定から消しても既存のQueue、DLQ、旧`EXPORTS` bucketは自動削除されません。未作成ならこの確認はN/Aです。存在する場合は、正本DB・`RECORDINGS`・`STIMULI`と取り違えていないこと、必要な派生ZIPがないことを二名で確認してから、Cloudflare側で旧資源だけを廃止します。旧5分cronは設定省略では残るため、`wrangler.jsonc` のroot・production双方で`"triggers": { "crons": [] }`を明示し、次回deploy後にDashboardで消滅を確認します。確認までは空配列を削除しません。

`0006_identity_and_participation_interruptions.sql`は、現在未使用のlegacy `participant_names` table、一時中断・参加終了の`participation_interruptions`、withdraw/abandon列、race防止index・triggerを追加済みです。適用済みmigrationは変更・削除せず、`participant_names`をruntimeから読み書きしないことで0行を維持します。既存のcanonical responseやR2 objectは削除しません。

## 4. ローカル開発

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` はcommit対象外です。通常の開発用プレースホルダーは収集停止状態の確認に残します。ID `999`の研究者用動作確認は、認証付きで`main-assets-v2`を使います。

`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`には互いに異なる24文字以上の開発用値を設定します。本番secretをローカル設定へ流用しません。

## 5. 本番前ゲート

実刺激をR2へ配置し、[STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md) のチェックを完了してから、`wrangler.jsonc` の `env.production.vars` だけを次のように変更します。

練習刺激も本番24語・統制6語の流用ではありません。LearningはID 906 `apple`（りんご／🍎）・907 `orange`（オレンジ／🍊）の2 WAV、Picture NamingはID 901 `dog`・902 `chair`の専用画像、L2-to-L1はID 903 `book`・904 `water`・905 `house`の3 WAVを使います。練習5語と統制6語はすべてAmerican Englishの固定TTS `tts_us_bella`（ElevenLabs Bella）で、PI聴取承認済みの11 WAVを`main-assets-v2`へ配置済みです。ID、word、image/audio keyが本番・統制と非重複で、practice/main間に同一SHA-256の画像・音声がなく、全練習trialが`practice=1`かつ`exclude_from_analysis=1`であることを本番相当pilotで確認します。開発用の共通fallbackは本番assetとして使いません。

```jsonc
"ENVIRONMENT": "production",
"ASSIGNMENT_VERSION": "main-v10-english-practice-real-assets",
"ASSET_VERSION": "main-assets-v2",
"ALLOW_PLACEHOLDER_ASSETS": "false",
"TEST_TOKEN_POLICY": "same_token"
```

version名は例です。実際の凍結版に合わせ、`SEED_ALGORITHM_VERSION` も収集開始前に固定します。`same_token` は現行manifestが実装済みの「同一話者・同一語・同一WAVを直後と遅延で再提示する」方針です。時点別の別takeを採用する場合、`timepoint_take` と書くだけでは動作せず、key規約・manifest・テストを先に変更する必要があります。プレースホルダーが残る、明示的に許可される、対応済み音声token方針が未指定、または`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`のいずれかが未設定・24文字未満・相互に同値なら、productionの新規参加者作成と新規trial開始はHTTP 503で遮断され、healthの`collection_ready`もfalseになります。すでに開始済みのtrialについては、データ喪失を避けるため応答と録音uploadを受け付けます。このゲートを緊急停止や参加終了の機能とはみなしません。参加者本人の一時中断・永続終了には第11節の明示的protocolを使います。

デプロイ前に実行します。

```bash
npm run types
npm run verify
npx wrangler deploy --env production --strict --no-x-provision
```

`GET /api/health` の `collection_ready` が `true` であることを確認します。非本番ではID `999`で6つのcanonical pageを個別に確認し、D1/R2が不変であることを確認します。これは画面・刺激・録音UIのQAであり、D1応答、R2録音、再開、Immediateから5日後の受付、結果ZIPの永続保存証拠にはなりません。通常IDを使う永続保存pilotは別途明示承認されるまで実施しません。

participant-facing UIを変更した後の開発QAは、正確なID `999`で6つのcanonical pageを個別に開きます。実効viewport 900×600以上・desktop Chrome・zoom 100%を最低基準として、練習注視点が`+`だけ、本番注視点が`+`と細いbarだけ、刺激onsetでbarが消えることを実画面で確認します。注視点・刺激・回答時間には課題名、`144`、`24`、`x/y`、完了数、保存状態、説明文、中断・終了buttonを出しません。Picture Naming画像onset後とL2音声buffer末尾後には、録音表示と10秒表示だけが必要どおり動くことを確認します。開始前・課題間案内・休憩では通常参加者の中断導線を利用でき、ID `999`では専用終了buttonがないことも確認します。ID `999`は完全非保存なので、部分保存と「全試行・録音の保存完了」の実挙動は確認済みと扱いません。900×600未満では開始前検査が停止し、ウィンドウ拡大またはzoom 100%を案内します。page scrollがなくても内容が欠けないことを実測し、対応外のviewportやzoomを黙って開始させません。L2 latency分析ではQA済み音響語末へ補正し、画面のcountdownは表示だけを担って録音停止・刺激順・manifest timingを変更しないことを自動testでも固定します。通常IDによる永続保存pilotは別途明示承認されるまで開始しません。

参加者向け結果ZIPは保存対象の本番132 WAVをR2からresponseへ直接streamします。通常の44.1 kHz mono PCMでは概算128 MiB前後、各録音の上限4 MiBを単純合計した保守的上限では約528 MiBになり得ます。12件の練習発話BlobはZIPに含めません。参加者browserでは自動downloadのため全量をBlobとして受信するので、constant-memory保存ではありません。約127 MBの合成ZIPは実Chromeで自動取得・再取得・展開照合済みですが、約528 MiBの上限容量は未実測です。メモリ制約が実測で問題になった場合に受け渡し方式を再検討します。response headerの受信開始は30秒でtimeoutし、受信したBlobのbyte数を`Content-Length`と照合します。ZIP失敗は完了済みvisitやD1/R2正本を取り消しません。

## 6. 全員共通URLの配布

通常運用では `https://EXPERIMENT.example/admin/` を開き、ADMIN_TOKENで接続します。上部表示が「本番環境・参加者への案内が可能」であることを確認してから案内します。環境未確認、development、または`collection_ready=false`では案内コピーが無効になります。参加者を管理画面で先に作成したり、参加者別URLを発行したりしません。ページと管理APIはCloudflare Accessで研究チームだけに制限してください。

新しい参加者には、発番台帳で未使用IDを確認し、「新しい参加者へ事前課題を案内」へIDを入力します。管理画面はID、Pre共通URL、短い開始・再開手順を1つの文面としてコピーしますが、この操作ではD1を変更しません。すでに開始済みのIDなら新規案内を作らず、該当する参加者行へ移動します。案内済みでもPreをまだ開始していないIDはserverに存在しないため、重複発番の防止には発番台帳を使います。

Pre開始後は「開始済み参加者」の1行に3 visitの状態、現在のsegment、回答・本番WAVの保存数、次にしてよい操作が表示されます。Pre完了後のimmediate案内と、受付可能になったdelayed案内は、該当行のボタンからID入り文面をコピーします。中断処理中、録音保存待ち、finalization待ち、5日未満、参加終了では案内ボタンを表示しません。常時監視は行わないため、案内直前に「手動更新」を押します。

| visit | 通常配布する入口 | 自動遷移する後続page |
|---|---|---|
| pre | `/pre-picture-naming/` | なし |
| immediate | `/main-experiment/` | `/immediate-picture-naming/` → `/immediate-l2-to-l1/` |
| delayed | `/delayed-picture-naming/` | `/delayed-l2-to-l1/` |

参加者IDは募集順に付与し、pre後の離脱、一時中断、永続的な参加終了があっても再利用しません。JavaScriptの安全整数範囲内にある正の10進整数だけを使い、先頭ゼロ、`P01`、`sub01`は使いません。正確な`999`は開発用testモードなので通常参加者へ割り当てません。IDの余りが学習時accentを決めるため、条件を見てIDを選ぶ、または恣意的な欠番を作る行為は割付バイアスになります。

初回Preでは、参加者がIDを1回入力し、確認画面に表示された同じIDを確認します。その確認後にだけ、serverが参加者、3 visit分の不変manifest、sessionを一括作成します。確認画面より前の離脱ではD1を変更しません。同じIDを再度開始しても保存済みmanifestを使い、再抽選しません。

Main ExperimentとDelayedでも、参加者は同じ共通入口でIDを入力し、確認画面に表示された同じIDを確認します。serverは保存済み位置からsessionを開始します。pre未完了ならimmediate、Immediate未完了または5日未満ならdelayedを拒否します。pre完了からimmediate開始までの上限・下限はなく、実際の間隔をD1へ保存します。

## 7. Delayedの案内

Immediate最終L2-to-L1回答をserverが受理すると、その時刻＋5日でdelayed visitが受付可能になります。開始にはImmediateの全応答・録音の保存確定も必要です。`/admin/`を手動更新し、「後日の課題を案内」filterに表示された参加者行から、IDと全員共通の`/delayed-picture-naming/`を含む案内文をコピーします。対象者ごとのURLやtokenは作りません。両条件を満たした後の上限期限はなく、遅れても受付可能です。

受付前に参加者が開いた場合は、serverの受付日時を日本時間で示す中立的な案内を表示します。参加者はページを閉じ、表示日時以降に同じリンク・同じIDで戻れます。「受付状況を確認する」は同じ入口の再読み込みであり、IDを再入力・確認した後にserverが改めて判定します。開いたままでも自動開始せず、常時通信や端末時計による受付判定は行いません。表示日時を過ぎても開始できない場合は、画面の内容を担当者へ知らせます。server日時の欠損・不正値や中断時の保存不確実性は、この案内へ置き換えず通常の障害表示を維持します。

## 8. sessionと再開

browser session tokenは既定12時間で失効します。これは参加期限ではありません。同じvisitの共通入口を開き直し、同じIDを入力・確認すると、新しいsessionが発行され、serverに保存済みのcanonical次位置から再開できます。trial内の提示時間・応答窓と通信timeoutも、inter-visitの受付期限とは別です。

共通URL自体は参加者固有の秘密情報ではなく、個別revoke・再発行の対象ではありません。研究用IDも本人認証要素ではありません。同じIDの複数tabを同時に使わず、中断・参加終了には第11節の参加者画面を使います。

## 9. 状態確認

日常運用では`/admin/`へ接続し、1つの参加者表でPre・Immediate・Delayed、保存数、最終アクセス、中断状態、serverが判定した次の対応を確認します。「対応必要」は中断処理または明確な保存・状態異常であり、単に実施中というだけでは含めません。個別のaccent・counterbalance cellはID選択バイアスを避けるため通常表へ出さず、accent×cellの集計と録音整合性だけを閉じた「研究点検用の全体集計」で確認します。管理tokenはbrowser storageへ保存されず、接続中のpage memoryだけに保持されます。

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- `participant_id_span.missing_ids_through_maximum` が発番台帳と一致し、ID 1から最大IDまでに説明のない欠番がない。
- `assignment_flow` のaccent×counterbalance cell別に、`assigned`、session開始、`first_trial`（started）、`behavioral_completed`、`finalized`を確認し、条件別離脱を隠さない。schema互換の`issued`・`redeemed`は共通入口が内部で作るsession bootstrap記録であり、担当者によるlink配布件数ではない。`redeemed`と`first_trial`も同一視しない。
- 同じ`assignment_flow`の`ever_paused_count`、`currently_paused_count`、`terminated_count`を、`assigned_count`や各visitのstarted/completed/finalized件数と別々に確認する。
- 各セルで `assigned_count >= *_issued_count >= *_redeemed_count >= *_first_trial_count >= *_behavioral_completed_count >= *_finalized_count` を満たすことを確認する。違反は参加者の除外理由ではなく、まず状態遷移またはデータ完全性の異常として調査する。
- `participation_interruptions`を`mode×state`で確認し、pauseの`requested`・`paused`・`resumed`とterminateの`requested`・`terminated`を、通常の行動完了・finalizationから分ける。永続終了は`participants.status=withdrawn`と未完了`visits.status=withdrawn`にも反映される。
- terminateが`requested`のまま残る場合は、参加者へ同じvisitの共通入口を再度開いて同じIDを入力・確認してもらう。新trialは開始されず、browser内の送信待ちを再送して同じrequestのfinalize画面へ戻る。明示操作なしのtab closeはinterruptionへ推測変換せず、未完了funnelとして扱う。
- behavioral completion済みだが録音未送信のvisitがない。
- R2録音件数がD1の`recordings.state=uploaded`と一致する。
- `recording_integrity.canonical_pending_uploads`が残る場合は完了扱いにせず、IndexedDBの元Blobを保持したまま担当者が原因を確認する。
- `recording_integrity.noncanonical_abandoned_slots`はpause後の再提示でsupersedeされたslot、`canonical_recordings_abandoned_after_termination`はcanonical response受理後に参加終了でupload不能となった録音として別々に確認する。どちらも通常のpendingやuploadedへ合算しない。
- 同じ参加者へ3つの共通入口をpre、immediate、delayedの順で案内し、後続segment用の別URLを手動送付していない。
- 遅延の実施日時と目標日時の差を記録した。

## 10. 録音ZIP

研究者はdesktop Chromeで `/admin/` の参加者行から詳細を開きます。未完了・参加終了では「現在保存済みの部分データZIPを保存」、3 visitの整合した完了後は「全時点完了データZIPを保存」という同じ1ボタンを使います。受信中は`Content-Length`に基づく進捗を表示します。File System Access APIが使えないbrowserでは全ZIPをmemoryへ保持するfallbackになるため、本番相当の大容量ZIP回収には使用しません。CLIでは次のようにオンデマンド取得できます。

```bash
curl -fL "https://EXPERIMENT.example/api/admin/participants/1/results.zip" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  --output accentedness_p1_results.zip
```

研究者APIはcanonical応答が0件でも割付、参加者×本番語24行の`item_assignments.csv`、全Learning計画を出力し、その時点で収集済みのcanonical応答とR2に存在するWAVだけを併記します。研究者版filenameには研究用participant IDを含め、台帳との取り違えを防ぎます。参加者版filenameは`accentedness_p{numeric_id}_{visit_type}_{YYYYMMDD}.zip`で、認証済みsessionの研究用数値ID・visit・ZIP生成日の日本時間日付を含めます。WAV entry名はvisit/segment/ordinalだけのopaque名ですが、研究者版`responses.json`には採点・照合に必要な刺激、条件、trial/attempt ID、再提示flag、R2 key、録音QC・latency基準との対応を含めます。研究者版だけに`design.json`、24語のList・No/High・No条件の固定学習話者・test accent・固定test話者を1行ずつ示す`item_assignments.csv`、全planned行・canonical runtime・attempt数を分けた`learning_trials.csv`を含めます。`item_assignments.csv`の固定学習話者はNo行だけに値があり、High行は空欄です。High語の実際の6話者と提示順は`learning_trials.csv`を参照します。参加者版にはこれらの研究用metadataを含めません。派生ZIPをCloudflareに保存するQueue・専用R2・export tableはありません。

研究者PCの自動バックアップは、新しいserver側資源を作らず、保存状態を30秒ごとに確認するlocal processで行います。`BACKUP_DIR`はDropboxとrepositoryの外にある専用directory `Accentedness_Backups`を必ず明示し、管理tokenは環境変数からだけ読みます。最新のvisit保存確定または参加終了を取得契機とし、既存の研究者ZIP APIから取得時点の累積データを1回だけ一時fileへstreamします。`Content-Length`とZIP magicを確認後に同一filesystem上でrenameし、directoryは`0700`、ZIPは`0600`にします。同じ取得契機のfilenameが存在すれば再取得しません。filenameのvisit名・時刻は取得契機であって厳密な収録範囲ではなく、後続visitの途中データも含み得ます。D1/R2が正本であり、local ZIPは二次backupです。

```bash
BACKUP_DIR=/Users/RESEARCHER/Accentedness_Backups npm run backup:watch -- "$PILOT_ID"
```

watcherは接続先healthがdevelopment、`main-assets-v2`、placeholder無効、通常participant許可、`collection_ready=true`の全条件を満たさなければ開始しません。`PILOT_ID`には非公開運用メモのIDを設定します。watcher停止中に複数visitが確定した場合は最新checkpointだけを取得し、取得し損ねた過去時点のsnapshotは復元しません。2026-09-05のPI承認により、参加者画面もPre・Immediate・Delayedそれぞれの保存確定後に累積ZIPを自動downloadします。未実施課題や研究者用情報は含めませんが、自分の録音を聞き返して復習する可能性は残ります。Pre・Immediateでは全課題終了まで開かず保管するよう案内し、これを技術的な防止策とはみなしません。永続保存pilotのPre・Immediate実施時には参加者向けZIPを配布していないため、その実測を新方式の配布確認へ流用しません。

参加者には各visitの保存確定後、そのvisitまでの全応答・録音が揃うことをserverが再検査した場合だけ、自動で累積ZIPのダウンロードを開始します。filenameは`accentedness_p{numeric_id}_{visit_type}_{YYYYMMDD}.zip`（日本時間の生成日）です。追加の保存先選択画面は出さず、保存先はChromeの設定に従います。完了画面はdownload開始と正本保存を区別し、Chromeのdownload一覧での確認、開始されない・失敗した場合の「ZIPをもう一度ダウンロード」リンク、数値IDと録音を含むファイルの共用PCでの移動・削除を案内します。リンクはページ内の受信済みBlobを再利用します。再読み込みでserverから再取得できるのは同じtabに保存した12時間有効のsessionがある場合だけで、完了済みvisitにIDだけで新規sessionを作りません。session失効・喪失後に新たな取得が必要なら研究担当者が管理APIから回収し、参加者に渡す際は研究者専用情報を含む版をそのまま配布しないでください。

以下は配備前のローカル検証記録です。現在の開発環境への配備と永続保存pilot前後比較は第2節を参照してください。

2026-09-05、各visit配布への変更後は22 files・261 tests、4,320 design監査、backup self-check、型、両環境dry-runを通過しました。各scopeの未完了拒否、完了後の26/24・231/78・290/132、後続visit完了後も以前のsessionの範囲が広がらないこと、queryでの範囲拡張拒否、録音欠損・確定時刻欠損時の拒否、JST日付境界を自動testで確認しました。

同日、隔離されたローカル合成ID 901でPre・Immediate・Delayedのシード済み応答を保存確定し、実Chromeの自動取得と同一tab再読み込み後の再取得を確認しました。Downloads内の`accentedness_p901_pre_20260905 (1).zip`／`(2)`／`(3)`は各23,068,267 B・26回答・24 WAV、`accentedness_p901_immediate_20260905.zip`／`(1)`は各75,148,769 B・231回答・78 WAV、`accentedness_p901_delayed_20260905.zip`／`(1)`は各127,049,511 B・290回答・132 WAVでした。括弧付き番号はChromeによる同名fileの重複回避です。7 ZIPすべてについてentry重複なし・CRC・全WAVのSHA-256／byte数／48 kHz／480,000 sample／10秒PCM16 mono無音をread-only照合し、研究者用file・条件field・内部UUIDの非混入、練習WAV非収録を確認しました。各scopeの再読み込み前後で回答・visit確定時刻・録音metadataと録音bytesは不変です。Preの手動リンク再取得（`(2)`）は最初の取得（`(1)`）とZIP全体のSHA-256も一致しました。900×600では3時点とも本文と再取得リンクの重なりがありません。この確認はZIP-onlyで、実験・マイクの再実施はしていません。公開サイト・remote 永続保存pilot・productionは未変更、実配備とG2 liveは未確認のままです。

## 11. 一時中断・参加終了・再開

開始前・課題間案内・休憩などの非計測画面にだけ表示する「中断・終了」から、`一時中断する`と`参加を終了する`を明示的に選びます。どちらも通常のvisit完了ではありません。注視点・刺激・回答時間にはbuttonを出さず、そこでtabを閉じた場合は未完了として残して共通入口から再開します。

### 一時中断

- 非計測画面で選択した時点で新規trialを開始せず、送信待ち録音をflushしてからinterruption requestを送信・finalizeします。
- requestとtrial startがraceした場合も、先に開始済みの現在trialだけは応答・録音をdrainできます。requestが先ならAPI検査とD1 triggerの両方が新規trial startを拒否します。
- finalize時にもserverがcanonical responseに対応する録音待ち0件を再検査します。1件でも残ればpauseは`requested`のままHTTP 409で拒否し、sessionを閉じません。成功後も参加者・visitはactive/startedのままで、completion timestampを設定しません。再開用の別URLは作りません。
- 再開時は同じvisitの共通入口を開き、同じIDを入力・確認します。新session epochが発行され、accepted canonical trialの直後から再開します。旧sessionはclosedです。
- request後・finalize前にtabを失った場合は、同じ共通入口で再認証してもpauseを自動resumeしません。新trialを禁止したまま送信待ちを再送し、pauseのfinalizeを先に終えます。`paused`確認後にもう一度同じ共通入口を開いた時点を`resumed`とします。
- 回答または録音を回復不能な理由で送れず安全な再開を保証できない場合、画面は「参加終了へ切り替える」と「切り替えず案内を見る」を分けます。前者は同じrequest UUIDの`pause/requested`を`terminate/requested`へ一方向に変更し、server受理済み範囲での終了を再確認します。後者はpauseを未確定のまま残すため、確認番号を記録します。
- 開始済みだが未受理だったtrialを再提示する場合、旧attemptとその録音slotは`superseded_on_resume`でabandoned・非canonicalになり、新attemptに`repeated_after_interruption=1`を付けます。学習trialなら`extra_exposure=1`も付きます。

### 永続的な参加終了

- request後の新規trialを止め、通常UIは送信待ちをflushしてからfinalizeします。すでにD1が受理したcanonical responseとR2へupload済みのWAVは削除・上書きしません。
- 未受理attemptとその録音slotは`participant_terminated`でabandoned・非canonicalにします。responseはcanonicalだがWAVが未uploadのslotもabandonedとして別集計し、完全録音とはみなしません。
- 完了済みvisitとそのcompletion timestampは保持します。未完了visitだけを`withdrawn`にし、`withdrawn_at_ms`を記録します。終了処理は`behavioral_completed_at_ms`、segment完了時刻、`finalized_at_ms`を新規設定してはいけません。
- participantを`withdrawn`にし、全active sessionと内部access recordを閉じます。終了後は共通入口から再開できず、IDも再利用しません。

### 共通の再送・race対策

- request UUIDとfinalizeは冪等です。open interruptionはD1一意indexで1件に制限し、trial start、通常の新session、別visit開始との競合をD1 triggerでも遮断します。open interruption中はvisit completionも拒否し、同じvisitの送信・finalize復旧と、確定済みpauseからの制御された再開だけを許可します。
- pauseからterminateへの切替も同じrequest UUIDで冪等です。別participant・別visit、terminateからpauseへの逆行、`paused`・`resumed`・`terminated`など確定後のmode変更は拒否します。
- 別タブで共通入口から開始すると新しいsession epochが発行され、古いタブはsupersededになります。同じIDを複数タブで開かないよう案内します。
- 試行onset後のreloadは再提示として記録され、`repeated_after_interruption`が立ちます。
- 応答PUTの一時失敗は同じ冪等keyで再送します。応答と録音はIndexedDB outboxに保持します。再訪時にoutboxの欠損・破損・読出不能または確定的4xxを検出した場合は次試行やpauseへ進めず、server受理済み範囲での参加終了か、終了せず担当者へ連絡するかを明示選択します。
- 明示的な中断requestを送る前にtab closeやerrorが起きた場合、fatal画面は通常完了・中断確定・server受理範囲をいずれも断定しません。参加者には同じvisitの共通入口を開き直して同じIDを入力・確認してから、新trialを始める前の案内画面で「中断・終了」を選ぶよう案内します。入口を開けない、または状態が不明なら、内部error codeや任意の実装文言ではなく、画面のopaqueなお問い合わせ番号と状況を担当者へ連絡してもらいます。
- IndexedDBはserver保存前のcrash recovery専用です。D1の応答受理とR2の録音受理を両方確認したrecordは、visitを問わず次回flushまでに削除し、参加者端末を第二の恒久保存先にしません。
- 中断・終了時に送れなかったWAVを自動削除する実装はありません。D1側のabandoned記録とbrowser内Blobを混同せず、回収・破棄方針に従います。

## 12. セキュリティとデータ保全

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- `/admin/*` と `/api/admin/*` をCloudflare Accessで研究チームだけに制限する。
- `ADMIN_TOKEN`と`RANDOMIZATION_SECRET`をログ、文書、チャットへ貼らず、相互流用しない。
- 氏名を一切収集・表示・保存しない。`participant_names`はlegacy schemaとして0行を維持し、氏名関連fieldを開始APIへ送るrequestはHTTP 422で拒否する。
- 研究用IDは本人認証要素ではない。IDと共通URLを公開場所へ掲載せず、D1・管理画面へのアクセスを研究チームへ限定する。
- raw録音は個人識別性のある研究データとして扱う。

Cloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。

収集時の正本はD1とprivate R2です。IndexedDBは未送信データの一時outbox、結果ZIPは正本から要求時に作る派生copyです。Workerから研究者PCへ同期二重書きはせず、上記local watcherは既存研究者ZIP APIを利用する二次backupに限定します。ただし、backupを未決定のまま本番収集は開始しません。所属機関の規程に沿うCloudflare標準機能または機関管理の保管先を確定し、隔離した検証先へのD1復元を1回、WAV 1件のR2復旧とD1記録の`byte_count`・SHA-256照合を1回行い、担当者・日時・結果を残します。保管期限後にD1、R2、参加者端末copyをどう削除するかも同じ手順書で固定します。共通入口の受付上限をなくすことは、raw音声の保管期限をなくすことを意味しません。
