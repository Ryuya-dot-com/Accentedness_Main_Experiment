# Main Experiment

Barcroft and Sommers (2005) の Experiment 2 を基礎に、学習時アクセントを参加者間、話者変動性を参加者内で操作する語彙学習実験です。Cloudflare Workers、D1、R2、Static Assetsを使い、学習用と2種類のテスト用プログラムを実装しています。

## 現在の状態

Learning練習・Space限定UX・latency metadata・研究者用設計logを含む実装は非本番へ配備済みです。2026-08-26に非本番D1 `main-experiment` の既存実験データだけをresetし、13 application tableが0件、`d1_migrations`が6件、外部キー違反が0件であることを確認しました。reset前のID 1–4と招待は現在存在しません。RECORDINGS R2の旧4 objectは削除対象外として残しています。現行buildを実Chrome・実microphoneで操作したcanonical D1 responseとR2 WAVの照合は未実施なので、G2はまだ完了していません。さらに収集用の画像・学習音声・本番テスト音声・話者と音響的語末offsetも未確定で、latencyを校正済み絶対RTとするかbrowser基準の近似値とするかも未決定のため、現時点では本番データを収集できません。production環境では、プレースホルダーが残る、直後・遅延のtoken方針が未確定、または`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`のいずれかが未設定・短すぎる・相互流用されている場合、参加者作成・招待発行・招待redeem・新規trial開始をサーバーが拒否します。

本番収集前の技術的な配備条件は次のとおりです。これらはリポジトリのコード完成判定とは分けて扱います。

- 24語、画像、学習音声、本番テスト音声、専用練習刺激を確定する。固定Learning練習（ID 906–907）、Picture Naming練習（ID 901–902）、L2-to-L1練習（ID 903–905）は、本番24語の語・画像・音声と完全に分離する。
- 学習用は各アクセント6話者、テスト用は各アクセント1名の女性話者（計3名）を用意する。
- 音声の切り出し、音量、無音区間、形式、明瞭度と、L2 latency用の音響的語末offsetを検査する。
- `ASSIGNMENT_VERSION`、`SEED_ALGORITHM_VERSION`、`ASSET_VERSION` を確定し、プレースホルダーを無効化する。
- 現行実装どおり直後・遅延で同一WAVを使うなら `TEST_TOKEN_POLICY=same_token` を明示する。別takeを採用する場合は、先にkey規約とmanifest生成を実装する。
- 参加者作成はIDと割当を原子的に保存する313文のD1 batchである。2026-08-26時点のWorkers上限ではD1など内部serviceへのsubrequestはFreeで1 invocationあたり1,000、Paidの既定値は10,000であり、313文だけを理由にPaidを必須としない。planは本番相当pilotのCPU時間、traffic、support要件を含めて確定する。
- 本番D1・R2・secrets・Accessを設定し、実Chrome・実マイクで全導線と全量ZIPを確認する。

事前登録、倫理審査、同意、標本数、解析計画などの研究ガバナンスはPI・共同研究者がリポジトリ外で管理し、コード完成の判定には含めません。

## 参加者用URL

| visit | 課題 | canonical path |
|---|---|---|
| pre | Picture Naming | `/pre-picture-naming/` |
| immediate | 学習 | `/main-experiment/` |
| immediate | Picture Naming | `/immediate-picture-naming/` |
| immediate | L2-to-L1 | `/immediate-l2-to-l1/` |
| delayed | Picture Naming | `/delayed-picture-naming/` |
| delayed | L2-to-L1 | `/delayed-l2-to-l1/` |

招待tokenはURLごとではなくvisitごとの3本です。pre、immediate、delayedのリンクを担当者が順に手動配布し、同一visit内の課題間では同じsessionを引き継ぎます。pre完了からimmediate開始までに上限・下限は設けず、実際の間隔を保存します。delayedはImmediate最終L2-to-L1回答のserver受理時刻から5日以上が経過し、Immediateの全応答・録音の保存が確定すると開始できます。それ以後は期限切れにしません。招待リンク自体にも年齢による自動失効はなく、visit完了、担当者によるrevoke、または再発行まで有効です。サーバーが未完了trialのordinalと未送信録音を検査するため、後続URLを直接開いても課題を飛ばせません。preにはL2-to-L1を含めません。

研究者が各画面を動作確認するときは、`ENVIRONMENT=development`の非本番だけで、上表のcanonical URLを招待tokenなし・保存済みsessionのない隔離Chrome profileから開き、既存の参加者ID欄へ半角小文字で`test`と入力します。氏名画面は表示せず、そのpage用にfreshな条件と順序を抽選し、静的プレースホルダーで練習・本番の提示と録音UIを実行します。このモードは回答・録音をD1、R2、IndexedDBへ保存・送信せず、画面にも常時「保存・送信なし」と表示します。productionでは入口を表示せず、test bootstrapも404で拒否します。既存の通常参加者sessionがあるprofileでは安全な再開を優先するため、test用にsessionを自動削除しません。pageごとに独立した動作確認であり、通常参加者の招待、氏名、継続session、D1/R2保存、再開、5日gate、ZIPを検証した証拠にはなりません。

管理者が入力するのは数値参加者IDだけです。参加者は有効なPreリンクでIDを入力し、氏名を入力した後、保存前の確認画面に表示された文字列を自分で確認します。確認済みの氏名は表示用に正規化した平文として、アプリケーションschemaではD1の`participant_names`だけへ保存します。以後の新しい招待linkではID入力後、serverが保存済み氏名を確認用API応答だけに返し、参加者は氏名を再入力せず表示内容を確認します。氏名はWorker log、audit detail、R2、browser storage、trial/event、参加者版・研究者版ZIP、管理API応答には出しません。初回アクセス資格を担うのは手動配布されたraw招待tokenと一致する参加者IDであり、氏名表示は本人認証ではありません。初回氏名保存、session、visit、redeem回数、auditは同じD1 batchで確定し、競合や途中失敗では全変更をrollbackします。trial responseとtelemetry eventもtask/type別field allowlistをserverで強制します。割付は数値IDだけで決まり、氏名は条件やseedに影響しません。IDは離脱・参加終了後も再利用しません。

この平文方式は参加者が保存値を読んで確認できる一方、D1への権限侵害やCloudflare側のbackup・Time Travel等の管理コピーから氏名が露出し得るtradeoffを持ちます。「`participant_names`だけ」はアプリケーション論理層の制限であり、それらの管理コピーから平文が消えるという意味ではありません。また、`Cache-Control: no-store`はcache残存を抑える指示であって、氏名の暗号化・匿名化や本人認証ではありません。ID単独では氏名を返しませんが、研究用連番IDは低entropyで第二認証要素ではなく、現行APIはrate limitや本人認証を実装していません。したがって、漏れたraw招待tokenがIDの総当たり耐性で守られるとはみなさず、raw tokenと一致するIDを得た第三者は氏名を表示して確認操作まで進めるものと扱います。linkの秘匿を保ち、誤配布・漏えい時は利用前でも招待をrevokeして再発行します。D1権限・保存期間・削除範囲には管理コピーを含めます。これは読み取り可能な自己確認を選ぶ意図的なtradeoffであり、`IDENTITY_SECRET`は不要です。

開始前と課題画面の「中断・終了」から選ぶ「一時中断」と「参加を終了する」は、visitの通常完了や管理者による招待revokeとは別の明示的状態遷移です。一時中断は現在試行と送信待ちを安全に確定し、serverもcanonical録音待ち0件を再検査してから、同じactive招待からcanonicalな次位置へ戻せます。再開可能な状態を保証できない送信エラーではpauseを偽って確定せず、未確定のまま連絡するか、同じrequestを参加終了へ一方向に切り替えます。再訪時にローカルoutboxの欠損・破損や確定的な送信拒否が判明した場合も、通常再開やpauseへ進めず、server受理済み範囲での参加終了か担当者連絡だけを提示します。参加終了は受理済みD1/R2を保持したまま未完了visitを`withdrawn`にし、未完了データを完了扱いにしません。request後にtabを閉じても、同じlinkでIDを入力して保存済み氏名を確認すれば、新しい試行を開始せず確定処理だけを再開できます。明示操作のないtab閉鎖は完了・中断・終了へ自動変換せず、未完了として残します。

Picture Matching は実施しません。行動データ・時刻・QCはD1、発話WAVは非公開R2を一次保存先とします。録音課題は各trialを個別WAVにし、session長尺録音や回答語だけへの自動trimは行いません。参加者browserのIndexedDBは通信障害からの再送に必要な一時outboxであり、D1・R2双方の受理確認後に削除します。Pre・直後では復習による保持成績の汚染を避けるためローカルZIPを渡しません。Delayed visitを先に完了確定した後だけ、3 visitすべてのcanonical回答とWAVを単一ZIPとして参加者が明示ボタンで保存できます。対応Chromeでは保存先を先に選び、ZIPをbrowser memoryへ全量保持せず直接fileへstreamします。ZIPはserver保存の代替ではありません。研究者は内部ページ `/admin/` で参加者IDを参照し、採点・照合用の刺激・条件・QC対応表に加え、割付・version・manifest hashの`design.json`と`learning_trials.csv`をオンデマンド取得できます。後者は保存済みmanifestの全Learning計画行を常に出力し、canonical実測がない行はruntime欄を空にして、全attempt数とnoncanonical attempt数を別列で示します。

## 設計の要点

- 学習時アクセント: 参加者IDを3で割った余りにより固定
  - 余り1: American English
  - 余り2: Mandarin-accented English
  - 余り0: Japanese-accented English
- 変動性: No Variability 12語とHigh Variability 12語
- No Variability: 各語を同一話者で6回
- High Variability: 各語を異なる6話者で1回ずつ
- 学習練習: 本番前に `apple`／🍎 と `orange`／🍊を2回。固定順・割当学習accentと同じ専用練習話者・本分析除外
- L2-to-L1: 各時点24語、3アクセント×8語、各アクセント内No/High各4語
- L2音声: 各アクセント1名の固定女性話者を練習・本番で使用する。この決定により、テストアクセントと話者個人は完全に交絡する
- 練習刺激: Learningは `apple` / `orange`、Picture Namingは `dog` / `chair`、L2-to-L1は `book` / `water` / `car` をID 901–907へ固定し、本番24語および他練習poolと重複させず、本分析から除外する
- pre: 専用Picture Naming練習2＋本番24のみ。正答語、音声、綴り、feedbackは提示しない
- pre→learning: 順序だけを強制し、実施間隔の上限・下限による受付拒否や自動除外をしない
- 遅延: Immediate最終L2-to-L1行動応答のserver受理時刻＋5日を目標とし、Immediate保存確定後は期限切れなし
- 再現性: HMAC-SHA-256で参加者固有root seedを作り、用途別domain seedからplanned manifestを生成する。実onset等のruntime logはseedではなく実施時に観測して別保存する

英語Learning練習は`main-v5-english-learning-practice-placeholder`で新規作成した参加者にだけ適用されます。Pre時点で3 visit分のmanifestを固定するため、v3（練習なし）・v4（日本語練習）でPreを開始済みのIDをv5へ途中変換しません。修正後のpilotと本収集は、v5で未使用IDをPreから新規作成します。

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

`.dev.vars` の`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`には、互いに異なる24文字以上の開発用値を設定します。実値はcommitしません。

ブラウザで `http://localhost:8787` を開きます。参加者リンクは管理APIから発行します。詳細は [OPERATIONS.md](./OPERATIONS.md) にあります。

## 検証コマンド

```bash
npm run types
npm run types:check
npm test
npm run audit:randomization
npm run verify
```

`npm test` は、参加者ID割当、216名周期の均衡、学習144試行、専用練習刺激と本番刺激の完全分離、pre・直後・遅延順序の独立化、アクセント連続制約、6 URL、Preでの平文氏名登録・後続リンクでの表示確認・限定的な出力範囲・失敗時無変更、一時中断・参加終了・再開、再送、segment越境刺激の遮断、WAV/PCM品質検証、オンデマンドZIPの認可・完全性・匿名entry名などを検査します。`npm run audit:randomization` はID 1–2160を独立した2つのsecretで生成し、計4,320 designの不変条件を監査します。push時にも同じ `npm run verify` をGitHub Actionsで実行します。

## 文書

- [DESIGN.md](./DESIGN.md): 実験設計・カウンターバランス・seed仕様
- [OPERATIONS.md](./OPERATIONS.md): Cloudflare構築・手動配布・障害対応
- [STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md): 本番刺激への置換と音響QA
- [DATA_DICTIONARY.md](./DATA_DICTIONARY.md): D1/R2のデータ定義と分析用フラグ
- [ROADMAP.html](./ROADMAP.html): version管理する内部向けチェックリスト（Word/PDF版は作成しない）

## 出典

Barcroft, J., & Sommers, M. S. (2005). Effects of acoustic variability on second language vocabulary learning. *Studies in Second Language Acquisition, 27*(3), 387–414. https://doi.org/10.1017/S0272263105050175
