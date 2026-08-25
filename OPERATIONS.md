# Cloudflare運用手順

## 1. 構成

- Worker: API、認証、manifest配信、現在試行と条件付き1試行先だけの刺激配信
- Static Assets: HTML、CSS、JavaScript、開発用プレースホルダー音声
- D1: 参加者、割当、visit、試行、応答、イベント、監査ログ
- R2 `STIMULI`: 非公開の本番画像・音声
- R2 `RECORDINGS`: 非公開の参加者録音
- Queue `main-experiment-recording-exports`: phase完了後のZIP生成
- R2 `EXPORTS`: 自動生成した非公開ZIP

管理APIはBearer tokenで保護されています。本番ではそれに加え、`/api/admin/*` をCloudflare Accessで研究チームだけに制限してください。参加者IDには学籍番号や氏名を使わず、研究用の連番だけを使います。

## 2. 初回セットアップ

```bash
npm install
npx wrangler login
npx wrangler d1 create main-experiment
npx wrangler r2 bucket create main-experiment-recordings
npx wrangler r2 bucket create main-experiment-stimuli
npx wrangler r2 bucket create main-experiment-exports
npx wrangler queues create main-experiment-recording-exports
npx wrangler queues create main-experiment-recording-exports-dlq
```

D1作成時に表示される`database_id`を `wrangler.jsonc` のD1設定へ追記します。秘密値は設定ファイルへ書かず、Secretsに登録します。

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put RANDOMIZATION_SECRET
```

両方とも独立した長い乱数値を使います。`RANDOMIZATION_SECRET` は収集中に変更しません。

本番D1へmigrationを適用します。

```bash
npx wrangler d1 migrations apply main-experiment --remote
```

## 3. ローカル開発

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` はcommit対象外です。開発環境のプレースホルダーは動作確認専用です。

## 4. 本番前ゲート

実刺激をR2へ配置し、[STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md) のチェックを完了してから、次を変更します。

```jsonc
"ENVIRONMENT": "production",
"ASSIGNMENT_VERSION": "main-v3-real-assets",
"ASSET_VERSION": "main-assets-v1",
"ALLOW_PLACEHOLDER_ASSETS": "false"
```

version名は例です。実際の凍結版に合わせ、`SEED_ALGORITHM_VERSION` も収集開始前に固定します。`ASSIGNMENT_VERSION` または `ASSET_VERSION` に `placeholder` が含まれる、あるいは `ALLOW_PLACEHOLDER_ASSETS=true` のまま本番にすると、参加者作成・招待発行はHTTP 503で遮断されます。

デプロイ前に実行します。

```bash
npm run types
npm run types:check
npm test
npm run deploy:check
npx wrangler deploy
```

`GET /api/health` の `collection_ready` が `true` であることを確認します。さらに、非本番IDで全導線を実施し、D1応答数、R2録音数、音声内容、直後完了から遅延目標時刻の算出を確認します。

録音ZIPは最大27本×4 MiBとなり得ます。実装は全体をmemoryへ載せずstreamingしますが、Queue consumerのCPU余裕を確保するため、本番はWorkers Paidを前提に容量試験を行ってください。Queueと`EXPORTS` bucketが存在しない状態では録音自体は保存できますが、ZIP自動生成は完了しません。

## 5. preリンクとMain Experimentリンクの手動発行

以下の例ではURLとtokenを実環境値に置き換えます。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/participants" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"participant_id": 1}'
```

返される最初の`invitation_url`は`/pre-picture-naming/`です。このURLだけを該当参加者へ手動で送ります。URL fragmentのraw tokenはD1やサーバーログへ保存されず、D1にはhashだけが保存されます。同じvisitに対して再発行すると古い招待はrevokeされます。

pre完了後、作成応答に含まれていた`immediate_visit_id`へMain Experiment招待を発行します。pre未完了ならAPIがHTTP 409で拒否します。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/visits/IMMEDIATE_VISIT_UUID/invitations" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}'
```

この招待は`/main-experiment/`を指します。学習後は同じsessionのまま`/immediate-picture-naming/`、`/immediate-l2-to-l1/`へ自動遷移します。各URL用に招待を再発行するとsession epochが変わるため、URL間遷移用の別tokenは発行しません。

## 6. 遅延リンクの手動発行

直後テスト完了後、遅延visitは「直後の行動完了＋7日」でscheduledになります。期限切れはありません。対象一覧を確認します。

```bash
curl -sS "https://EXPERIMENT.example/api/admin/delayed/due" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

各行の `immediate_missing_recordings` が0であることを確認します。0でない場合は、直後visitの録音outbox回収または研究チームの判断を先に行います。

対象visitへ遅延リンクを発行します。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/visits/VISIT_UUID/invitations" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}'
```

## 7. 招待のrevokeとsession

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/invitations/INVITE_UUID/revoke" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

この操作は招待リンクを無効化しますが、すでにredeem済みのactive sessionを強制終了しません。参加中のセッションも停止する必要がある場合は、現行APIの範囲外です。D1を直接変更せず、専用のsession停止APIを追加してテストしてから運用してください。

## 8. 状態確認

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- behavioral completion済みだが録音未送信のvisitがない。
- R2録音件数がD1の`recordings.state=uploaded`と一致する。
- `recordings.state=pending`が残る場合は完了扱いにせず、IndexedDBの元Blobを保持したまま担当者が原因を確認する。
- 同じ参加者へpre、immediate、delayedをこの順で送り、後続segment用に別tokenを送っていない。
- 遅延の実施日時と目標日時の差を記録した。

## 9. 録音ZIP

各phaseの最後のWAVがR2へ保存されると、QueueがZIPを自動生成します。状態を取得します。

```bash
curl -sS "https://EXPERIMENT.example/api/admin/exports?participant_id=1" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

`state=ready`になった行は、返された`download_path`または次の形式で取得できます。

```bash
curl -fL "https://EXPERIMENT.example/api/admin/visits/VISIT_UUID/recordings/picture_naming.zip" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  --output recordings.zip
```

ブラウザでは`/admin/exports`にADMIN_TOKENと参加者IDを入力すると、完成済みZIPを1クリックでdownloadできます。この静的ページは公開され得ますがAPIはtokenで保護されています。本番ではparticipant route全体ではなく、`/admin/*`と`/api/admin/*`だけをCloudflare Accessで研究チームに制限してください。`EXPORTS` bucketのpublic accessと`r2.dev`は無効のままにします。

ZIP生成はQueueのat-least-once deliveryを前提に冪等化され、5分ごとのscheduled reconcilerが未送信・stale jobを再投入します。D1のdownload記録はHTTP stream開始の監査であり、研究者端末への保存完了を意味しません。raw WAVとZIPは別の保管期間にし、ZIPには短いR2 lifecycleを設定してください。

## 10. 中断・再開

- 同じ招待リンクを同じブラウザで開くと、保存済み位置から再開します。
- 別タブで再redeemすると新しいsession epochが発行され、古いタブはsupersededになります。
- 試行onset後のreloadは再提示として記録され、`repeated_after_interruption` が立ちます。
- 応答と録音の送信はIndexedDB outboxに保持されます。未送信録音が残る場合、完了画面へ進みません。
- 共用PCではvisitごとにoutboxを分離していますが、参加後はブラウザデータを研究運用規程に従って扱います。

## 11. セキュリティとバックアップ

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- Access、rate limiting、アラートを本番ドメインに設定する。
- `ADMIN_TOKEN` と `RANDOMIZATION_SECRET` をログ、文書、チャットへ貼らない。
- D1 exportとR2 inventoryを定期取得し、保管期間と削除手順を倫理審査・同意文書に合わせる。
- raw録音は個人識別性のある研究データとして扱う。

rate limitingとCloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。
