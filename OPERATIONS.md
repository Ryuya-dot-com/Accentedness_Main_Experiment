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

pre完了からこの発行・参加開始までに上限・下限はありません。古いpre完了時刻や招待発行時刻だけを理由に拒否しません。これは順序制約を外すという意味ではなく、Main Experimentリンクはpre完了後にだけ発行します。実際のpre→learning間隔はD1へ保存し、間隔だけを理由に自動除外しません。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/visits/IMMEDIATE_VISIT_UUID/invitations" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}'
```

この招待は`/main-experiment/`を指します。学習後は同じsessionのまま`/immediate-picture-naming/`、`/immediate-l2-to-l1/`へ自動遷移します。各URL用に招待を再発行するとsession epochが変わるため、URL間遷移用の別tokenは発行しません。

## 6. 遅延リンクの手動発行

直後テスト完了後、遅延visitは「直後の行動完了＋7日」でscheduledになります。7日はdelayed操作を守る開始下限です。以後の上限期限はなく、遅れても受付可能です。対象一覧を確認します。

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

activeな招待linkには経過時間による自動失効がなく、visit完了、明示的revoke、または同じvisitへの再発行まで利用できます。未使用・離脱・同意撤回のlinkを無期限に放置すると、転送・漏えい時のrisk windowも長くなります。研究上の受付期限を設けない場合でも、離脱・撤回を確認したlinkは担当者が明示的にrevokeし、その判断を監査記録へ残してください。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/invitations/INVITE_UUID/revoke" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

この操作は招待リンクを無効化し、その招待visitのactive sessionも同じD1 batchでsupersedeします。同じvisitのリンクを再発行した場合も旧リンクとactive sessionが無効になります。参加中の画面は次のheartbeatまたはAPI要求で停止するため、録音中の別タブを即時停止できるとはみなしません。現行管理画面はactive sessionを検知して再確認しないため、参加者と連絡が取れ、実施中でないことを確認するまでは再発行しません。

browser session tokenは既定12時間で失効します。これはbearer tokenを無期限化しないための認証TTLで、参加期限ではありません。同じactiveな招待linkを開き直すと新しいsession epochが発行され、serverに保存済みの未完了位置から再開できます。trial内の提示時間・応答窓と通信timeoutも、inter-visitの受付期限とは別です。

## 8. 状態確認

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- `participant_id_span.missing_ids_through_maximum` が発番台帳と一致し、ID 1から最大IDまでに説明のない欠番がない。
- `assignment_flow` のaccent×counterbalance cell別に、各visitの `issued` → `redeemed` → `first_trial` → `behavioral_completed` → `finalized` を確認し、条件別離脱を隠さない。`redeemed`はlinkを受け付けてsessionを発行した段階、`first_trial`は最初のtrialをserverへ開始記録した段階であり、同一視しない。
- 各セルで `assigned_count >= *_issued_count >= *_redeemed_count >= *_first_trial_count >= *_behavioral_completed_count >= *_finalized_count` を満たすことを確認する。違反は参加者の除外理由ではなく、まず状態遷移またはデータ完全性の異常として調査する。
- 後方互換の `pre_completed_count`、`immediate_started_count`、`immediate_completed_count`、`delayed_started_count`、`delayed_completed_count` は残るが、新しい監視・分析には使わない。特に旧 `*_started_count` はtrial開始ではなくlink redeem時刻に基づく。
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
- IndexedDBはserver保存前のcrash recovery専用です。D1の応答受理とR2の録音受理を両方確認したrecordは、visitを問わず次回flushまでに削除し、参加者端末を第二の恒久保存先にしません。
- 共用PCではvisitごとにoutboxを分離していますが、参加後はブラウザデータを研究運用規程に従って扱います。
- 中断・放棄された未送信WAVを自動削除する実装はありません。誤削除を避ける回収・破棄方針と保存期間を倫理手順に定めます。

## 11. セキュリティとバックアップ

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- Access、rate limiting、アラートを本番ドメインに設定する。
- `ADMIN_TOKEN` と `RANDOMIZATION_SECRET` をログ、文書、チャットへ貼らない。
- raw録音は個人識別性のある研究データとして扱う。

rate limitingとCloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。

### 保存層の役割

収集時の正本はD1とprivate R2です。参加者browserのIndexedDBは未送信データの一時outboxであり、研究者local backupではありません。R2内の自動ZIPも同じCloudflare障害領域にある派生物なので、独立backupとは数えません。

研究者管理端末への保存は、Workerから参加者ごとに同期的に二重書きしません。研究者端末の電源・network・空き容量で参加を失敗させないためです。代わりに、専用端末がD1と3つのR2 bucketをpullし、SHA-256 manifestを持つcomplete snapshotを作ります。raw音声をこのrepositoryや通常のDropbox同期領域へ置かず、倫理審査で承認された暗号化volumeを使ってください。

### backup CLIの準備

本repoのWranglerを使い、keyring保存を明示的に有効化してからnamed auth profileを作成します。WranglerのOAuth scopeにはD1 read-onlyがないため、exportに必要な範囲として `account:read`、`user:read`、`d1:write` の3つだけを指定します。`d1:write`は名称どおり更新権限も含むので、このprofileをbackup以外へ流用しません。

```bash
npx wrangler auth keyring enable
npx wrangler auth create research-production \
  --scopes account:read \
  --scopes user:read \
  --scopes d1:write
```

別途rclone 1.75.0以降のstable版を導入し、Cloudflare R2のS3-compatible endpointへ、対象3 bucketだけを読めるObject Read tokenでremoteを作成します。1.75.0はlocal path containment修正版であり、CLIはversionを強制します。`rclone config redacted` でproviderとendpointを照合するため、remote sectionへ `global.*` または `override.*` を追加しません（filterやlocal encodingを全commandへ注入できるため、CLIも拒否します）。`rclone config`へ秘密値を対話入力し、config fileをrepo外、mode `0600`で保管します。秘密値をbackup command、shell history、`.env`、repoへ渡しません。`env_auth`は有効にしません。bucket-level tokenでbucket確認が拒否される場合は、Cloudflareの案内どおりrclone configへ `no_check_bucket = true` を設定します。

最初に、空の専用backup rootを初期化します。rootは絶対pathで指定し、repositoryの内側・外側の親directory・home directoryそのもの・既知のDropbox/iCloud等の同期領域は拒否されます。flagは暗号化済み保存先を担当者が確認したというattestationであり、暗号化を技術的に検出するものではありません。

```bash
npm run backup:init -- \
  --destination /ABSOLUTE/ENCRYPTED/accentedness-backup \
  --confirm-encrypted-storage
```

### complete snapshotの取得

D1のfull export中は他のdatabase requestが遮断されます。参加者が実施していないことを運用上確認し、短いquiet windowを確保した場合だけ次を実行します。`--confirm-d1-quiet-window`は安全確認を代替せず、担当者が確認したことを明示するflagです。リンクに参加期限を設けない運用と無人の頻回D1 exportは両立しないため、現段階ではこのfull backupを盲目的なcronへ登録しません。

```bash
npm run backup:production -- \
  --destination /ABSOLUTE/ENCRYPTED/accentedness-backup \
  --wrangler-profile research-production \
  --rclone-remote accentedness-r2 \
  --expected-cloudflare-account-id 0123456789abcdef0123456789abcdef \
  --expected-d1-database-id 11111111-2222-3333-4444-555555555555 \
  --confirm-d1-quiet-window \
  --confirm-encrypted-storage
```

上の2つのIDは例ではなく、本番Dashboardで確認したaccount IDとD1 UUIDへ置換します。CLIはCloudflare認証を指定accountへ固定し、明示的な空の `--env-file` でrepo内の `.env.production` 自動読込を遮断し、解決後のD1 UUIDとrclone endpointを照合してmanifestへ記録します。`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、すべての`RCLONE_*`等がshell環境に残っている場合は、named profileやremoteのsilent overrideを避けるためfail-stopします。値はerrorへ出しません。

CLIは次を行います。

1. production D1を`.partial` SQLへexportし、非空・SHA-256を検査してrenameする。
2. `RECORDINGS`、`EXPORTS`、`STIMULI`を共有local mirrorへ`rclone copy --immutable`で追加copyする。`sync`やdeleteは使わない。
3. `rclone check --one-way --download`で、現在remoteにある全objectを実際に読み、local内容と一致することを確認する。remote hashを比較できないobjectでもsize-onlyへ暗黙に弱めない。localに保持した過去objectは許容する。
4. その時点のremote membershipを別に取得し、その一覧に属するobjectだけのbyte数とlocal SHA-256をmanifestへ記録する。各current objectと親directoryを `fsync` してからpublishし、mirrorに残った過去objectを当該snapshotの復元対象へ混ぜない。
5. 全工程成功後だけstaging directoryを`snapshots/<id>`へrenameし、`LATEST`をatomicに更新する。途中失敗はcomplete snapshotとして公開しない。

D1 export後にR2をcopyするため、両storeを単一transactionの同一点に固定するものではありません。quiet windowでwriteを止め、manifestの開始・完了時刻とsource一覧を残します。次回以降はimmutable object mirrorを再利用し、現在remoteに属する全fileを再hashするため、容量に応じた所要時間をpilotしてください。remoteで期限削除されたobjectは共有mirrorに残り得るので、manifestのcurrent membershipだけをrestore対象にし、local mirror自体にも別途retention・削除台帳・crypto-erasureを適用します。

backup jobの成功だけでは復旧可能性を証明しません。別の非本番D1/R2へrestoreし、D1のuploaded recording rowとlocal WAV、ready export rowとZIP、件数、byte数、hashを照合するrehearsalを定期実施してください。失敗通知、backup保管期間、鍵管理、二名以上のaccess承認、期限後削除を倫理審査・同意文書と一致させます。参加linkの受付上限をなくすことは、raw音声の保管期限をなくすことを意味しません。
