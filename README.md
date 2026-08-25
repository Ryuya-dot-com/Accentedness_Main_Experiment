# Main Experiment

Barcroft and Sommers (2005) の Experiment 2 を基礎に、学習時アクセントを参加者間、話者変動性を参加者内で操作する語彙学習実験です。Cloudflare Workers、D1、R2、Queues、Static Assetsを使い、学習用と2種類のテスト用プログラムを実装しています。

## 現在の状態

コードとプレースホルダー刺激による検証は可能です。ただし、実刺激・話者・画像が未確定のため、現時点では本番データを収集できません。production環境では、プレースホルダーが残っている場合、または直後・遅延で同一WAV tokenを使うかが明示されていない場合、参加者作成・招待発行・招待redeem・新規trial開始をサーバーが拒否します。

本番開始前の必須条件は次のとおりです。

- 24語、画像、学習音声、本番テスト音声、練習音声を確定する。
- 学習用は各アクセント6話者、テスト用は各アクセント1名の女性話者（計3名）を用意する。
- 音声の切り出し、音量、無音区間、形式、明瞭度を検査する。
- `ASSIGNMENT_VERSION`、`SEED_ALGORITHM_VERSION`、`ASSET_VERSION` を確定し、プレースホルダーを無効化する。
- 現行実装どおり直後・遅延で同一WAVを使うなら `TEST_TOKEN_POLICY=same_token` を明示する。別takeを採用する場合は、先にkey規約とmanifest生成を実装する。
- 予定サンプルサイズに対応する均衡水準と統計解析計画を事前登録する。

## 参加者用URL

| visit | 課題 | canonical path |
|---|---|---|
| pre | Picture Naming | `/pre-picture-naming/` |
| immediate | 学習 | `/main-experiment/` |
| immediate | Picture Naming | `/immediate-picture-naming/` |
| immediate | L2-to-L1 | `/immediate-l2-to-l1/` |
| delayed | Picture Naming | `/delayed-picture-naming/` |
| delayed | L2-to-L1 | `/delayed-l2-to-l1/` |

招待tokenはURLごとではなくvisitごとの3本です。pre、immediate、delayedのリンクを担当者が順に手動配布し、同一visit内の課題間では同じsessionを引き継ぎます。pre完了からimmediate開始までに上限・下限は設けず、実際の間隔を保存します。delayedだけは直後テスト完了から7日後を開始可能時刻とし、それ以後は期限切れにしません。招待リンク自体にも年齢による自動失効はなく、visit完了、担当者によるrevoke、または再発行まで有効です。サーバーが未完了trialのordinalと未送信録音を検査するため、後続URLを直接開いても課題を飛ばせません。preにはL2-to-L1を含めません。

Picture Matching は実施しません。行動データ・時刻・QCはD1、発話WAVは非公開R2を一次保存先とします。各phaseの全録音が揃うとQueueがZIPを自動生成して別の非公開R2へ保存し、`/admin/exports`から管理者だけがダウンロードできます。参加者browserのIndexedDBは通信障害からの再送に必要な一時outboxであり、server保存確認後に削除します。raw音声を参加者端末へ恒久保存しません。研究者管理端末への独立コピーは、収集中のWorkerから同期的に二重書きせず、D1/R2の検証可能な定期backupとして取得します。手動リンク発行・遅延対象確認・割付状況確認は内部ページ `/admin/` から行えます。

## 設計の要点

- 学習時アクセント: 参加者IDを3で割った余りにより固定
  - 余り1: American English
  - 余り2: Mandarin-accented English
  - 余り0: Japanese-accented English
- 変動性: No Variability 12語とHigh Variability 12語
- No Variability: 各語を同一話者で6回
- High Variability: 各語を異なる6話者で1回ずつ
- L2-to-L1: 各時点24語、3アクセント×8語、各アクセント内No/High各4語
- L2音声: 各アクセント1名の固定女性話者を練習・本番で使用する。この決定により、テストアクセントと話者個人は完全に交絡する
- pre: Picture Naming練習2＋本番24のみ。正答語、音声、綴り、feedbackは提示しない
- pre→learning: 順序だけを強制し、実施間隔の上限・下限による受付拒否や自動除外をしない
- 遅延: 直後テストの行動完了時刻＋7日を目標時刻とし、それ以降は期限切れなし
- 再現性: HMAC-SHA-256で参加者固有root seedを作り、用途別domain seedから順序を生成

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

ブラウザで `http://localhost:8787` を開きます。参加者リンクは管理APIから発行します。詳細は [OPERATIONS.md](./OPERATIONS.md) にあります。

## 検証コマンド

```bash
npm run types
npm run types:check
npm test
npm run audit:randomization
npm run verify
```

`npm test` は、参加者ID割当、216名周期の均衡、学習144試行、pre・直後・遅延順序の独立化、アクセント連続制約、6 URL、再開・再送、segment越境刺激の遮断、WAV/PCM品質検証、ZIPの回復性・認可・整合性などを検査します。`npm run audit:randomization` はID 1–2160を独立した2つのsecretで生成し、計4,320 designの不変条件を監査します。push時にも同じ `npm run verify` をGitHub Actionsで実行します。

## 文書

- [DESIGN.md](./DESIGN.md): 実験設計・カウンターバランス・seed仕様
- [OPERATIONS.md](./OPERATIONS.md): Cloudflare構築・手動配布・障害対応
- [STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md): 本番刺激への置換と音響QA
- [DATA_DICTIONARY.md](./DATA_DICTIONARY.md): D1/R2のデータ定義と分析用フラグ
- [ROADMAP.html](./ROADMAP.html): version管理する内部向けチェックリスト（Word/PDF版は作成しない）

研究者管理端末へD1/R2の検証可能なlocal backupを作るCLIも含まれます。これは参加者browserへの保存や収集要求内の同期二重書きではありません。D1 full exportにはquiet windowが必要なため、認証・暗号化保存先・実行・restoreの手順は [OPERATIONS.md](./OPERATIONS.md#11-セキュリティとバックアップ) に従ってください。

## 出典

Barcroft, J., & Sommers, M. S. (2005). Effects of acoustic variability on second language vocabulary learning. *Studies in Second Language Acquisition, 27*(3), 387–414. https://doi.org/10.1017/S0272263105050175
