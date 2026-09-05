# Main Experiment

Barcroft and Sommers (2005) の Experiment 2 を基礎に、学習時アクセントを参加者間、話者変動性を参加者内で操作する語彙学習実験です。Cloudflare Workers、D1、R2、Static Assetsを使い、学習用と2種類のテスト用プログラムを実装しています。

## 現在の状態

2026-09-05、PI／ユーザーがDelayedと参加者端末ZIPのlive確認未完了を認識したうえで、この状態でのGO、commit・push、本番の実施可能化を明示承認しました。本番は`main-v10-english-practice-real-assets`／`main-assets-v2`／`same_token`で受付を有効化済みです。配備後の[本番health](https://accentedness-main-experiment-production.komuro-4121.workers.dev/api/health)で`collection_ready=true`を確認しました。開始承認はG2–G4の実測完了を意味せず、未確認項目は[ROADMAP.html](./ROADMAP.html)に残します。

通常参加者への入口は[事前課題](https://accentedness-main-experiment-production.komuro-4121.workers.dev/pre-picture-naming/)です。担当者は[本番管理画面](https://accentedness-main-experiment-production.komuro-4121.workers.dev/admin/)からIDと共通URLを案内します。氏名や事前の参加者作成は不要です。ID `999`は本番では使いません。

### 開始承認前の検証履歴

以下のNO-GO・production未変更は各作業時点の記録です。現在の開始判断は上記承認に従います。

developmentの通常ID受付は既定で停止し、公開push前に停止設定を配備して確認します。継続中pilotの実ID・受付日時はGit対象外の運用メモへ分離し、監督下の実施時だけ一時開放します。管理token付きのID `999`による非保存確認は継続できます。

Learning練習・Space限定UX・latency metadata・研究者用設計log・非保存の研究者testモードを含む実装は非本番へ配備済みです。全員共通URLから始める永続保存pilotのPre・Immediateは、実Chrome・実microphone・D1・R2を通して永続保存・再開・研究者ZIPを技術確認済みです。Delayedのlive pilotは未完了で、本収集はNO-GOです。操作補助を伴う技術pilotのため、独立参加者のユーザビリティや絶対RT妥当性の証拠には流用しません。本番24語とPicture Naming練習2語のopaque画像、学習・テスト・統制・静的TTS練習の計515 WAVを揃えた`main-assets-v2` stagingは完成しました（44.1 kHz / PCM16 / mono、画像は原則400×400、`nostril`のみ400×399）。テスト72・統制6・L2練習3の音響的語末offsetは、hashとWAV形式を検証した`waveform_endpoint_v1`で81件すべて自動承認済みです。PIはElevenLabs BellaによるAmerican English練習・統制11語を聴取して承認済みです。主刺激の画像命名確認と学習音声明瞭度確認は実施済みとして使用承認されていますが、結果ファイルは本リポジトリにないため、証拠付きvalidation完了ではなく`waived_by_pi_without_repository_result`として記録します。2026-09-05のPI／ユーザー了承により、RTは機器遅延未補正のbrowser基準の近似値として扱い、L2音響語末への補正は維持します。校正済み絶対RTや機器間の精密比較は主張しません。RT方針の決定だけで本収集GOとはせず、Delayed・実施者導線・本番配備の確認を継続します。production環境では、プレースホルダーが残る、直後・遅延の音声token方針が未確定、または`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`のいずれかが未設定・短すぎる・相互流用されている場合、新規参加者の作成と新規trial開始をサーバーが拒否します。

2026-09-05に`main-assets-v2`の26画像＋515 WAVを非本番`STIMULI`へ配置し、全541件を再取得してstagingとbyte単位で一致することを確認しました。ID `999`は既存の管理トークンでbootstrapと刺激取得を認証し、非本番R2の実画像・実音声を使う完全非保存モードです。PI／ユーザー報告によりG0は完了し、永続保存pilotのPreで26回答・24 WAV・再開・研究者ZIPを確認してG1も完了しました。続くImmediateも205回答・54 WAV・送信待ち0件で完了し、累積231回答・78 WAVの研究者ZIPを自動回収・照合しました。G2は明示承認済みですが、受付前のDelayed拒否までの確認であり未完了です。2026-09-05のPI承認により、Pre・Immediate・Delayedの各完了時に累積ZIPを自動配布し、ID・visit・日本時間日付入りの命名へ変更しました。全261 testsを通過し、隔離したローカル合成ID 901の各scopeで実Chromeの自動取得・同一tab再読み込み後の取得、Preの手動リンク再取得を確認しました（例：`npm run preview:participant-copy -- pre`。末尾は`pre`・`immediate`・`delayed`から1値を選択）。7 ZIPすべてのCRCと全録音のSHA-256・metadataを照合済みです。

同日、ZIP変更をdevelopment version `58b00d67-d065-4bee-baa4-2707cff1db38`へ配備しました。配信JS/CSSのローカル一致、未認証ZIPの401拒否、Chromeの3共通入口表示、永続保存pilotの割付・全manifest・231回答・78 WAV・受付日時の配備前後不変を確認しました。実課題・実マイクの再実施とproduction配備はしていません。永続保存pilotのPre・Immediateは旧version `56e4c04a-131d-41bd-8e7c-081ff5e257e0`での実測として保持し、Delayedは非公開運用メモの受付日時以降、新version・同一manifestから継続します。同一buildで全visitを完遂した証拠とはせず、参加者ZIPの実環境での完了時ダウンロードとG2 liveは未確認です。Pre・Immediateは再実施せず、remote時刻の手動書換え・データ削除・割付再生成はしません。詳細は[OPERATIONS.md](./OPERATIONS.md)を参照してください。

続いて、Delayed受付前の表示を中立的な開始日時・再確認手順の案内へ変更し、development version `c791f746-dcc1-4f82-b8b4-0063ed087de9`へ配備しました。全264 tests・配備前検査・独立レビューを通過し、local Chromeの900×600表示と、開発サイトの永続保存pilotで日時表示・再確認ボタンを確認しました。表示は日本時間の秒単位で切り上げるだけで、正確な5日gate、割付、manifest、231回答・78録音のD1記録は確認前後で不変です。Delayed sessionは0件のままで、課題・マイク確認の再実施や自動開始は行っていません。G2 live未完了・本収集NO-GO・production未変更を維持します。

本番収集前の技術的な配備条件は次のとおりです。これらはリポジトリのコード完成判定とは分けて扱います。

- 確定済み24語・指定話者rosterに対応する画像、専用練習刺激、全音声を最終確定する。固定Learning練習（ID 906–907）、Picture Naming練習（ID 901–902）、L2-to-L1練習（ID 903–905）は、本番24語と統制6語から分離する。
- 学習は各アクセントで指定済み6話者、テストは指定済み固定1話者を使用する。旧来の男女同数・女性テスト話者という要件は用いない。
- PIは学習音声のblind intelligibility確認を実施済みとして使用を承認した。結果ファイルは本リポジトリにないためPI判断による免除として扱う。元音声は変更せず保管し、最終bundleの44.1 kHz / PCM16 / mono、音量、無音区間、hashとL2 latency用の音響的語末offsetは機械検査する。
- `ASSIGNMENT_VERSION`、`SEED_ALGORITHM_VERSION`、`ASSET_VERSION` を確定し、プレースホルダーを無効化する。
- 現行実装どおり直後・遅延で同一WAVを使うなら `TEST_TOKEN_POLICY=same_token` を明示する。別takeを採用する場合は、先にkey規約とmanifest生成を実装する。
- 本番D1・R2・secrets・Accessを設定し、実Chrome・実マイクで全導線と全量ZIPを確認する。

## 参加者用URL

| visit | 課題 | canonical path |
|---|---|---|
| pre | Picture Naming | `/pre-picture-naming/` |
| immediate | 学習 | `/main-experiment/` |
| immediate | Picture Naming | `/immediate-picture-naming/` |
| immediate | L2-to-L1 | `/immediate-l2-to-l1/` |
| delayed | Picture Naming | `/delayed-picture-naming/` |
| delayed | L2-to-L1 | `/delayed-l2-to-l1/` |

課題ページは6つですが、通常配布する入口は全員共通の3つです。担当者はpreに`/pre-picture-naming/`、immediateに`/main-experiment/`、delayedに`/delayed-picture-naming/`を順に案内します。immediateとdelayedの後続課題へは同じsessionのまま自動遷移するため、参加者別URLや課題ごとのtokenは作りません。pre完了からimmediate開始までに上限・下限は設けず、実際の間隔を保存します。delayedはImmediate最終L2-to-L1回答のserver受理時刻から5日以上が経過し、Immediateの全応答・録音の保存が確定すると開始できます。それ以後は期限切れにしません。サーバーが保存済み位置と未送信録音を検査するため、後続ページを直接開いても課題を飛ばせません。preにはL2-to-L1を含めません。

研究者が各画面を動作確認するときは、`ENVIRONMENT=development`の非本番だけで、上表のcanonical URLを保存済みsessionのない隔離Chrome profileから開き、参加者ID欄へ正確に`999`、続けて管理画面と同じ管理トークンを入力します。トークンはJavaScript memoryだけに保持し、入力欄は直ちに空にし、URL、browser storage、実験データへ保存しません。起動ごとにそのpage用の条件と順序を新しく抽選し、`RESEARCHER_TEST_ASSET_VERSION=main-assets-v2`の実画像・実音声をprivate R2から読みます。回答・録音はD1、`RECORDINGS`、IndexedDBへ保存・送信しません。「保存・送信なし」は開始前と完了後だけに表示し、計測中の画面には出しません。productionでは`999`とtest APIを拒否します。pageごとに独立した動作確認であり、通常参加者のID確認、継続session、D1/R2保存、再開、5日gate、ZIPを検証した証拠にはなりません。

試行中に別タブや別アプリへ移動すると、刺激提示前を含め、その回は測定上使用できないため画面を停止します。ID `999`では「動作確認を最初からやり直す」から同じページを再読み込みし、`999`と管理トークンを再入力します。通常参加者には現在の試行が保存済みとは断定せず、「同じ課題を開き直す」から同じIDを再入力して確認し、サーバーが確認できた位置から再開するよう案内します。

通常参加者IDはJavaScriptの安全整数範囲内にある、先頭ゼロのない正の10進整数です。`01`、`P01`、`sub01`、0、負数、小数は拒否し、文字列中の数字だけを抜き出しません。`999`は開発用testモードに予約し、通常参加者には割り当てません。

Preの初回アクセスでは、参加者が共通URLでIDを入力し、表示された同じIDを確認してから、サーバーが参加者、3 visit分の不変manifest、sessionを一括作成します。確認前の離脱ではD1を変更しません。再試行や再訪では同じIDを再入力して確認し、保存済みmanifestと位置を再利用します。氏名は収集・表示・保存しません。旧migration由来の`participant_names` tableは互換性のため残しますが、runtimeは読み書きせず常に空とします。割付は数値IDだけで決まり、IDは離脱・参加終了後も再利用しません。

開始前・課題間の案内・休憩など、反応を測っていない安全な画面から選べる「一時中断」と「参加を終了する」は、visitの通常完了とは別の明示的状態遷移です。注視点・刺激・回答時間には中断buttonを出しません。一時中断は送信待ちを安全に確定し、serverもcanonical録音待ち0件を再検査してから、同じ共通入口URLでcanonicalな次位置へ戻せます。再訪時にローカルoutboxの欠損・破損や確定的な送信拒否が判明した場合は、新しい試行を始めず、server受理済み範囲での参加終了か担当者連絡だけを提示します。参加終了は受理済みD1/R2を保持したまま未完了visitを`withdrawn`にし、未完了データを完了扱いにしません。明示操作のないtab閉鎖は完了・中断・終了へ自動変換せず、未完了として残します。

Picture Matching は実施しません。行動データ・時刻・QCはD1、本番発話WAVは非公開R2を一次保存先とします。録音課題は本番trialだけを各trial別WAVにし、session長尺録音や回答語だけへの自動trimは行いません。Picture Naming／L2-to-L1の練習でも本番と同じ発話手順を体験しますが、練習Blobは保存キューへ入れず破棄します。練習trialの実施・timing・QC metadataは`practice=1`かつ`exclude_from_analysis=1`としてD1へ残ります。L2-to-L1の統制6語は`practice=0`、`exclude_from_analysis=1`、`expects_recording=1`として両時点に記録します。保存対象はPre 24本、Immediate 54本、Delayed 54本、全体132本です。参加者browserのIndexedDBは通信障害からの再送に必要な一時outboxであり、D1・R2双方の受理確認後に削除します。Pre・Immediate・Delayedそれぞれの保存確定後に、その時点までのcanonical回答とWAVを単一ZIPとして自動ダウンロードします。収録範囲はPreのみ（26回答・24 WAV）、Pre＋Immediate（231回答・78 WAV）、全3 visit（290回答・132 WAV）です。filenameは`accentedness_p{参加者ID}_{pre|immediate|delayed}_{YYYYMMDD}.zip`（ZIP生成時の日本時間の日付）です。未実施visit、刺激、正答、条件、研究者用CSVは含めません。Pre・Immediateでは全課題終了まで開かず聞き返さず保管するよう案内しますが、復習を技術的に防止するものではありません。この残余リスクをPIが2026-09-05に明示承認しました。受信した全量Blobのbyte数を確認してからChromeへdownloadを要求し、完了画面に再ダウンロード用リンクを残します。disk保存完了はブラウザから断定せず、Chromeのダウンロード一覧で確認するよう案内します。ZIPはserver保存の代替ではありません。研究者は内部ページ `/admin/` で参加者IDを参照し、割付・version・manifest hashの`design.json`、参加者×本番語24行の学習条件・test accent対応を示す`item_assignments.csv`、全Learning計画・実測を分けた`learning_trials.csv`をオンデマンド取得できます。`item_assignments.csv`の`no_training_talker_id`はNo Variability語だけに値を持ち、High Variability語は空欄です。High語の6話者と提示順は`learning_trials.csv`を正本とします。`learning_trials.csv`はcanonical実測がない行のruntime欄を空にし、全attempt数とnoncanonical attempt数を別列で示します。これらの研究用metadataは参加者版ZIPへ含めません。

## 設計の要点

- 学習時アクセント: 参加者IDを3で割った余りにより固定
  - 余り1: American English
  - 余り2: Mandarin-accented English
  - 余り0: Japanese-accented English
- 変動性: No Variability 12語とHigh Variability 12語
- No Variability: 各語を同一話者で6回
- High Variability: 各語を異なる6話者で1回ずつ
- Learning順序: No-first / High-firstを参加者間で均衡させ、6回の各24語反復で同じ条件順を使う。各条件の12語は一度だけseed付きでシャッフルし、その順序を6回とも固定する
- High話者順序: 各語について6話者をseed付きで無作為・非復元抽出し、6回の曝露へ1名ずつ割り当てる
- 学習練習: 本番前に `apple`／🍎 と `orange`／🍊を2回。固定順・American EnglishのBella固定TTS・本分析除外
- L2-to-L1: 各時点は主要24語＋未学習の果物統制6語＝30問。主要24語は3アクセント×8語、各アクセント内No/High各4語
- L2音声: 主要24語はEnglish=`E6_Audio`、Japanese=`J5_Natural`、Chinese=`C11_Natural`の固定話者を使う。この決定により、テストアクセントと話者個人は完全に交絡する
- L2統制: `strawberry` / `grape` / `pineapple` / `peach` / `kiwi` / `cherry`をAmerican EnglishのBella固定TTSで両時点に提示し、No/Highの主要解析から除外する
- 練習刺激: Learningは `apple` / `orange`、Picture Namingは `dog` / `chair`、L2-to-L1は `book` / `water` / `house` をID 901–907へ固定する。音声はAmerican EnglishのBellaによるoffline固定WAVを使い、本番24語および他練習poolと重複させず、本分析から除外する
- pre: 専用Picture Naming練習2＋本番24のみ。正答語、音声、綴り、feedbackは提示しない
- pre→learning: 順序だけを強制し、実施間隔の上限・下限による受付拒否や自動除外をしない
- 遅延: Immediate最終L2-to-L1行動応答のserver受理時刻＋5日を目標とし、Immediate保存確定後は期限切れなし
- 再現性: HMAC-SHA-256で参加者固有root seedを作り、用途別domain seedからplanned manifestを生成する。実onset等のruntime logはseedではなく実施時に観測して別保存する

本番24語・指定話者roster・新しいL2統制6語・Bella固定練習TTSを含む実刺激契約は`main-v10-english-practice-real-assets`／`main-assets-v2`です。v9以前の保存済みmanifestとassetを途中変換せず、練習発話WAV非保存契約も維持します。assignment versionがroot seed入力に含まれるため、新規v10参加者のmain順序がv9以前と同じとは仮定しません。画面QAは正確なID `999`、永続保存G1 pilotは本番参加者へ再利用しない永続保存pilotを使います。永続保存pilotのpilot途中にデータを削除・再作成して再抽選してはいけません。本収集を承認した後の新規参加者はv10のPreから作成します。

完全な仕様は [DESIGN.md](./DESIGN.md)、運用手順は [OPERATIONS.md](./OPERATIONS.md)、刺激差し替えは [STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md) を参照してください。

## ローカル検証

Node.js と npm が必要です。

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run dev
```

`.dev.vars` の`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`には、互いに異なる24文字以上の開発用値を設定します。実値はcommitしません。通常IDによる承認済みpilotを行う場合だけ、対象の非本番環境で`ALLOW_DEVELOPMENT_PARTICIPANTS=true`を明示します。

ブラウザで `http://localhost:8787/admin/` を開き、管理tokenで接続します。本番準備状態、新規Pre案内、開始済み参加者の3 visit進捗、現在のsegment、保存数、安全な次操作、Delayed受付、個人ZIPを1つの表で確認できます。新規Pre案内のコピーではD1を変更せず、参加者別URLやtokenも発行しません。developmentでは一般参加者向け案内を無効にし、ID `999`用の6ページだけを表示します。詳細は [OPERATIONS.md](./OPERATIONS.md) にあります。

## 検証コマンド

```bash
npm run types
npm run types:check
npm test
npm run audit:randomization
npm run verify
```

`npm test` は、ID入力・同一ID確認・氏名field拒否・同時初回開始の一意性、参加者ID割当、216名周期の均衡、学習144試行、参加者内で固定・参加者間で無作為化する学習語順、専用練習刺激・主要24語・統制6語の分離、各時点30問、pre・直後・遅延順序の独立化、アクセント連続制約、6 URL、一時中断・参加終了・再開、再送、segment越境刺激の遮断、WAV/PCM品質検証、オンデマンドZIPの認可・完全性・匿名entry名などを検査します。`npm run audit:randomization` はID 1–2160を独立した2つのsecretで生成し、計4,320 designの不変条件を監査します。push時にも同じ `npm run verify` をGitHub Actionsで実行します。

## 文書

- [DESIGN.md](./DESIGN.md): 実験設計・カウンターバランス・seed仕様
- [OPERATIONS.md](./OPERATIONS.md): Cloudflare構築・手動配布・障害対応
- [STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md): 本番刺激への置換と音響QA
- [DATA_DICTIONARY.md](./DATA_DICTIONARY.md): D1/R2のデータ定義と分析用フラグ
- [ROADMAP.html](./ROADMAP.html): version管理する内部向けチェックリスト（Word/PDF版は作成しない）

## 出典

Barcroft, J., & Sommers, M. S. (2005). Effects of acoustic variability on second language vocabulary learning. *Studies in Second Language Acquisition, 27*(3), 387–414. https://doi.org/10.1017/S0272263105050175
