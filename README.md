# Main Experiment

Barcroft and Sommers (2005) の Experiment 2 を基礎に、学習時アクセントを参加者間、話者変動性を参加者内で操作する語彙学習実験です。Cloudflare Workers、D1、R2、Queues、Static Assetsを使い、学習用と2種類のテスト用プログラムを実装しています。

## 現在の状態

コードとプレースホルダー刺激による検証は可能です。ただし、実刺激・話者・画像が未確定のため、現時点では本番データを収集できません。`ENVIRONMENT=production` でプレースホルダー設定が残っている場合、参加者作成と招待発行をサーバーが拒否します。

本番開始前の必須条件は次のとおりです。

- 24語、画像、学習音声、本番テスト音声、練習音声を確定する。
- 学習用は各アクセント6話者、テスト用は各アクセント1名の女性話者（計3名）を用意する。
- 音声の切り出し、音量、無音区間、形式、明瞭度を検査する。
- `ASSIGNMENT_VERSION`、`SEED_ALGORITHM_VERSION`、`ASSET_VERSION` を確定し、プレースホルダーを無効化する。
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

招待tokenはURLごとではなくvisitごとの3本です。pre、immediate、delayedのリンクを担当者が順に手動配布し、同一visit内の課題間では同じsessionを引き継ぎます。サーバーが未完了trialのordinalと未送信録音を検査するため、後続URLを直接開いても課題を飛ばせません。preにはL2-to-L1を含めません。

Picture Matching は実施しません。テストでは発話をWAVとして非公開R2へ保存します。各phaseの全録音が揃うとQueueがZIPを自動生成して別の非公開R2へ保存し、`/admin/exports`から管理者だけがダウンロードできます。参加者端末への自動保存は行いません。

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
npm run deploy:check
```

`npm test` は、参加者ID割当、216名周期の均衡、学習144試行、pre・直後・遅延順序の独立化、アクセント連続制約、6 URL、冪等な保存、segment越境刺激の遮断、WAV/PCM品質検証、ZIPのbyte一致・認可・監査などを検査します。

## 文書

- [DESIGN.md](./DESIGN.md): 実験設計・カウンターバランス・seed仕様
- [OPERATIONS.md](./OPERATIONS.md): Cloudflare構築・手動配布・障害対応
- [STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md): 本番刺激への置換と音響QA
- [DATA_DICTIONARY.md](./DATA_DICTIONARY.md): D1/R2のデータ定義と分析用フラグ
- [ROADMAP.html](./ROADMAP.html): version管理する内部向けチェックリスト（Word/PDF版は作成しない）

## 出典

Barcroft, J., & Sommers, M. S. (2005). Effects of acoustic variability on second language vocabulary learning. *Studies in Second Language Acquisition, 27*(3), 387–414. https://doi.org/10.1017/S0272263105050175
