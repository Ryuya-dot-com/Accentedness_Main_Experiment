# Cloudflare運用手順

## 1. 構成

- Worker: API、認証、manifest配信、現在試行と条件付き1試行先だけの刺激配信
- Static Assets: HTML、CSS、JavaScript、開発用プレースホルダー音声
- D1: 参加者、割当、visit、試行、応答、イベント、監査ログ
- R2 `STIMULI`: 非公開の本番画像・音声
- R2 `RECORDINGS`: 非公開の参加者録音
- Queue `main-experiment-recording-exports-production`: phase完了後のZIP生成
- R2 `EXPORTS`: 自動生成した非公開ZIP

管理APIはBearer tokenで保護されています。本番ではそれに加え、`/api/admin/*` をCloudflare Accessで研究チームだけに制限してください。参加者IDには学籍番号や氏名を使わず、研究用の連番だけを使います。

## 2. 初回セットアップ

```bash
npm install
npx wrangler login
npx wrangler d1 create main-experiment-production
npx wrangler r2 bucket create main-experiment-recordings-production
npx wrangler r2 bucket create main-experiment-stimuli-production
npx wrangler r2 bucket create main-experiment-exports-production
npx wrangler queues create main-experiment-recording-exports-production
npx wrangler queues create main-experiment-recording-exports-production-dlq
```

D1作成時に表示される`database_id`を `wrangler.jsonc` のD1設定へ追記します。秘密値は設定ファイルへ書かず、Secretsに登録します。

```bash
npx wrangler secret put ADMIN_TOKEN --env production
npx wrangler secret put RANDOMIZATION_SECRET --env production
```

両方とも独立した長い乱数値を使います。`RANDOMIZATION_SECRET` は収集中に変更しません。

本番D1へmigrationを適用します。

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

環境別のD1、R2、Queue、varsは継承されないため、`wrangler.jsonc` の `env.production` にすべて明記します。production用resource IDを作成後に固定し、default開発環境と取り違えないことを別担当者が確認してください。

## 3. ローカル開発

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` はcommit対象外です。開発環境のプレースホルダーは動作確認専用です。

## 4. 本番前ゲート

実刺激をR2へ配置し、[STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md) のチェックを完了してから、`wrangler.jsonc` の `env.production.vars` だけを次のように変更します。

```jsonc
"ENVIRONMENT": "production",
"ASSIGNMENT_VERSION": "main-v3-real-assets",
"ASSET_VERSION": "main-assets-v1",
"ALLOW_PLACEHOLDER_ASSETS": "false",
"TEST_TOKEN_POLICY": "same_token"
```

version名は例です。実際の凍結版に合わせ、`SEED_ALGORITHM_VERSION` も収集開始前に固定します。`same_token` は現行manifestが実装済みの「同一話者・同一語・同一WAVを直後と遅延で再提示する」方針です。時点別の別takeを採用する場合、`timepoint_take` と書くだけでは動作せず、key規約・manifest・テストを先に変更する必要があります。プレースホルダーが残る、明示的に許可される、または対応済みtoken方針が未指定なら、productionの参加者作成・招待発行・招待redeem・新規trial開始はHTTP 503で遮断されます。すでに開始済みのtrialについては、データ喪失を避けるため応答と録音uploadを受け付けます。このゲートを緊急の全session停止機能とはみなさず、必要時は招待revokeも行ってください。

デプロイ前に実行します。

```bash
npm run types
npm run verify
npx wrangler deploy --env production
```

`GET /api/health` の `collection_ready` が `true` であることを確認します。さらに、非本番IDで全導線を実施し、D1応答数、R2録音数、音声内容、直後完了から遅延目標時刻の算出を確認します。

録音ZIPは最大27本×4 MiBとなり得ます。実装は全体をmemoryへ載せずstreamingしますが、Queue consumerのCPU余裕を確保するため、本番はWorkers Paidを前提に容量試験を行ってください。Queueと`EXPORTS` bucketが存在しない状態では録音自体は保存できますが、ZIP自動生成は完了しません。

## 5. preリンクとMain Experimentリンクの手動発行

通常運用では `https://EXPERIMENT.example/admin/` を開き、ADMIN_TOKENを入力して既存参加者の参照、各visitのリンク発行、遅延対象、全体状態を確認します。tokenはページ保存領域へ永続化しません。ページと管理APIの両方をCloudflare Accessで研究チームだけに制限してください。

参加者IDは募集順の連番で付与し、pre後に離脱しても再利用しません。IDの余りが学習時accentを決めるため、担当者が条件を見てIDを選ぶ、または恣意的な欠番を作る行為は割付バイアスになります。現行画面は欠番をsummaryで検出しますが、原子的な自動連番発番は未実装です。本番開始前に外部台帳を含む発番責任者・手順・監査証跡を確定するか、サーバー発番へ切り替えてください。

CLIで行う場合は、以下のURLとtokenを実環境値に置き換えます。

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

この操作は招待リンクを無効化し、その招待visitのactive sessionも同じD1 batchでsupersedeします。同じvisitのリンクを再発行した場合も旧リンクとactive sessionが無効になります。参加中の画面は次のheartbeatまたはAPI要求で停止するため、録音中の別タブを即時停止できるとはみなしません。

## 8. 状態確認

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- `participant_id_span.missing_ids_through_maximum` が発番台帳と一致し、ID 1から最大IDまでに説明のない欠番がない。
- `assignment_flow` のaccent×counterbalance cell別に、割付数、pre完了数、直後開始・完了数、遅延開始・完了数を確認し、条件別離脱を隠さない。
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

ブラウザでは`/admin/exports`にADMIN_TOKENと参加者IDを入力すると、完成済みZIPを1クリックでdownloadできます。この画面はZIP全体をbrowser Blobへ保持してから保存するため、大容量archiveは上記の `curl --output` を使ってください。この静的ページは公開され得ますがAPIはtokenで保護されています。本番ではparticipant route全体ではなく、`/admin/*`と`/api/admin/*`だけをCloudflare Accessで研究チームに制限してください。`EXPORTS` bucketのpublic accessと`r2.dev`は無効のままにします。

ZIP生成はQueueのat-least-once deliveryを前提に冪等化され、20分leaseと5回の試行上限を持ちます。5分ごとのscheduled reconcilerは欠落したexport row、未送信job、期限切れleaseを回復します。ZIP内WAV名は順番だけを示すopaque名で、語・accent・話者を含みません。download前にR2 objectのsize、ETag、export UUID、source snapshotをD1と照合します。

`attempt_count=5` の `state=failed` はterminalで、DLQを再送してもconsumerはskipします。現行APIにreset操作はありません。D1を手作業で変更せず、本番前に、元WAVとmember snapshotの診断、理由・担当者の監査記録、明示的な再試行を一体化した管理者用recovery手順を実装してください。それまではterminal failureをproduction運用で自動回復できるとみなしません。

D1の `expires_at_ms` は監査用の予定時刻であり、現行コードはその時刻に配信停止・削除をしません。raw WAVとZIPの保管期間を倫理審査・同意文書に合わせて別々に定め、production bucketへR2 lifecycleを設定し、backup/restoreを確認してから削除を有効化してください。D1のdownload記録はHTTP stream開始の監査であり、研究者端末への保存完了を意味しません。

## 10. 中断・再開

- 同じ招待リンクを同じブラウザで開くと、保存済み位置から再開します。
- 別タブで再redeemすると新しいsession epochが発行され、古いタブはsupersededになります。
- 旧タブは次の15秒heartbeatまで動作し得るため、本番pilotでは録音中の二重タブを明示的に試験します。BroadcastChannel/Web Locksによる即時単一タブ制御は未実装です。
- 試行onset後のreloadは再提示として記録され、`repeated_after_interruption` が立ちます。
- 応答PUTの一時失敗は同じ冪等keyで再送します。応答と録音の送信はIndexedDB outboxに保持されます。serverが録音待ちなのに対応するlocal Blobもない場合は、次試行へ進まず明示的に停止します。
- 共用PCではvisitごとにoutboxを分離していますが、参加後はブラウザデータを研究運用規程に従って扱います。
- 中断・放棄された未送信WAVを自動削除する実装はありません。誤削除を避ける回収・破棄方針と保存期間を倫理手順に定めます。

## 11. セキュリティとバックアップ

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- Access、rate limiting、アラートを本番ドメインに設定する。
- `ADMIN_TOKEN` と `RANDOMIZATION_SECRET` をログ、文書、チャットへ貼らない。
- D1 exportとR2 inventoryを定期取得し、保管期間と削除手順を倫理審査・同意文書に合わせる。
- raw録音は個人識別性のある研究データとして扱う。

rate limitingとCloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。
