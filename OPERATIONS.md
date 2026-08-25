# Cloudflare運用手順

本書のgateは本番環境でデータを回収できるかを判定するものであり、リポジトリのコード完成判定ではありません。研究ガバナンス上の判断は本書のscope外です。

## 1. 構成

- Worker: API、認証、manifest配信、現在試行と条件付き1試行先だけの刺激配信
- Static Assets: HTML、CSS、JavaScript、開発用プレースホルダー音声
- D1: 参加者、割当、visit、試行、応答、イベント、監査ログ
- R2 `STIMULI`: 非公開の本番画像・音声
- R2 `RECORDINGS`: 非公開の参加者録音

管理APIはBearer tokenで保護されています。本番ではそれに加え、`/api/admin/*` をCloudflare Accessで研究チームだけに制限してください。参加者IDには学籍番号や氏名を使わず、研究用の連番だけを使います。

## 2. 非本番placeholder pilotの初回セットアップ

24語slotはプレースホルダーのまま進めます。top-level設定を非本番pilotとして使い、新しい`env.pilot`は追加しません。`ENVIRONMENT=development`、`ALLOW_PLACEHOLDER_ASSETS=true`、`TEST_TOKEN_POLICY=undecided`の組合せは意図したpilot設定です。

現行実装は、参加者・3 visit・24 item割当・6 segment・276 trial・監査記録を311文のD1 batchで原子的に保存します。D1は1 Worker invocationあたりFree 50 queries、Paid 1000 queriesなので、placeholder pilotにもWorkers Paidが必要です。Free対応のためだけにSQLと原子性を再設計しません。Cloudflare公式の [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) と [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) は配備時にも確認します。

resourceを変更する前に、Wranglerの認証先、Workers Paid、主担当・代替担当を確認し、exact nameの衝突をread-onlyで再点検します。

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

D1作成時の`database_id`を`wrangler.jsonc`のtop-level `DB` bindingだけへ追記し、差分とresource名を照合します。migrationを適用してからWorkerをdeployします。

```bash
npx wrangler d1 migrations apply DB --remote --env="" --no-x-provision
npx wrangler deploy --env="" --strict --no-x-provision
```

Wranglerの自動resource provisioningは既定で有効です。明示作成後は`--no-x-provision`を付け、binding不足を黙って新規resource作成で補わせません。`--strict`はDashboard等の競合するremote変更がある場合にuploadを止めます。

初回deploy直後はsecret未設定のため管理操作がfail closedになります。その後、独立した長い乱数値を対話入力します。値をcommand引数、文書、chat、shell historyへ書きません。

```bash
npx wrangler secret put ADMIN_TOKEN --env=""
npx wrangler secret put RANDOMIZATION_SECRET --env=""
npx wrangler secret list --env=""
```

現在のWranglerでは`secret put`自体が新しいWorker versionを作り、直ちにdeployします。単なる設定保存とは扱いません。`ADMIN_TOKEN`は24文字以上かつ`[A-Za-z0-9._~-]+`だけで構成します。hexはこの条件を満たします。`RANDOMIZATION_SECRET`も24文字以上とし、同じassignment versionのpilot中に変更しません。

初回deployへsecretを同梱する場合は、Git・Dropbox外の権限`0600`一時fileを`--secrets-file`へ渡し、成功直後にそのfileを削除します。secret値をcommand引数、標準出力、shell historyへ出しません。今回の非本番bootstrapはこの方法を使いました。

2026-08-26以降、非本番`ADMIN_TOKEN`の暫定正本はrepository外の親directoryにある`.env`です。file modeは`0600`とし、この単一keyだけを標準入力経由でWranglerへ渡します。`.env`全体またはtoken値を表示・記録しません。rotation後に新tokenでHTTP 200、旧tokenでHTTP 403を確認し、bootstrap用の一時handoff directoryは削除済みです。この`.env`はDropbox同期対象なので、現時点の非本番運用にだけ用い、production secretの恒久正本とはみなしません。`RANDOMIZATION_SECRET`、production resource、production secretはこのrotationで変更していません。

非本番`GET /api/health`の期待値は、`environment=development`、`placeholder_assets=true`、`test_token_policy=undecided`、`test_token_policy_ready=false`、`collection_ready=false`です。これは正常なplaceholder pilot状態です。実際にplaceholder participantを1名作成し、311文batchの完全性とduration、D1/R2 binding、管理token拒否、R2非公開を別途確認します。現在の非本番URLは`https://accentedness-main-experiment.komuro-4121.workers.dev`です。

## 3. productionの初回セットアップ

非本番pilotを通過するまでproduction resourceは作成しません。productionへ進む場合もWorkers Paidを先に確認し、非本番と同じread-only衝突監査を繰り返します。

```bash
npx wrangler d1 create main-experiment-production
npx wrangler r2 bucket create main-experiment-recordings-production
npx wrangler r2 bucket create main-experiment-stimuli-production
```

D1作成時の`database_id`を`wrangler.jsonc`の`env.production`にある`DB` bindingだけへ追記します。環境別のD1、R2、varsは継承されないため、default非本番と取り違えないことを別担当者が確認します。本番D1へmigrationを適用し、placeholderのproduction gateが閉じた状態で初回deployします。

```bash
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler deploy --env production --strict --no-x-provision
npx wrangler secret put ADMIN_TOKEN --env production
npx wrangler secret put RANDOMIZATION_SECRET --env production
npx wrangler secret list --env production
```

`secret put`は各回とも即時deployを伴います。両方とも独立した長い乱数値を使い、`RANDOMIZATION_SECRET`は同じassignment versionの収集中に変更しません。

`0005_remove_recording_exports.sql` が削除するのは、旧Queue方式で作った派生ZIPの状態表だけです。canonical応答・録音metadata・監査logは削除しません。旧版を一度でも配置した環境では、bindingを設定から消しても既存のQueue、DLQ、旧`EXPORTS` bucketは自動削除されません。未作成ならこの確認はN/Aです。存在する場合は、正本DB・`RECORDINGS`・`STIMULI`と取り違えていないこと、必要な派生ZIPがないことを二名で確認してから、Cloudflare側で旧資源だけを廃止します。旧5分cronは設定省略では残るため、`wrangler.jsonc` のroot・production双方で`"triggers": { "crons": [] }`を明示し、次回deploy後にDashboardで消滅を確認します。確認までは空配列を削除しません。

## 4. ローカル開発

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` はcommit対象外です。開発環境のプレースホルダーは動作確認専用です。

## 5. 本番前ゲート

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
npx wrangler deploy --env production --strict --no-x-provision
```

`GET /api/health` の `collection_ready` が `true` であることを確認します。さらに、非本番IDで全導線を実施し、D1応答数、R2録音数、音声内容、Immediate最終L2-to-L1行動応答のserver受理時刻から遅延目標時刻までが正確に5日であることを確認します。

参加者向け結果ZIPは3 visit分のWAVをR2から直接streamします。通常の48 kHz mono PCMでは概算130 MiB前後、各録音の上限4 MiBを単純合計した保守的上限では約520 MiBになり得ます。対応するdesktop ChromeではFile System Access APIで選択済みfileへ直接書き、browser memoryへ全量保持しません。転送中に進捗しているZIPを固定15分で切る上限は設けず、response headerの受信開始だけを30秒でtimeoutします。未対応時だけBlob downloadへfallbackするため、本番相当データで直接保存が使われること、生成時間、memory、再試行をpilotしてください。ZIP失敗はすでに完了したvisitやD1/R2正本を取り消しません。

## 6. preリンクとMain Experimentリンクの手動発行

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

## 7. 遅延リンクの手動発行

Immediate最終L2-to-L1回答をserverが受理すると、その時刻＋5日で遅延visitがscheduledになります。Delayedリンクは、この5日下限とImmediateの全応答・録音の保存確定を両方満たした後に発行できます。以後の上限期限はなく、遅れても受付可能です。対象一覧を確認します。

```bash
curl -sS "https://EXPERIMENT.example/api/admin/delayed/due" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

対象visitへ遅延リンクを発行します。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/visits/VISIT_UUID/invitations" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}'
```

## 8. 招待のrevokeとsession

activeな招待linkには経過時間による自動失効がなく、visit完了、明示的revoke、または同じvisitへの再発行まで利用できます。未使用・離脱・同意撤回のlinkを無期限に放置すると、転送・漏えい時のrisk windowも長くなります。研究上の受付期限を設けない場合でも、離脱・撤回を確認したlinkは担当者が明示的にrevokeし、その判断を監査記録へ残してください。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/invitations/INVITE_UUID/revoke" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

この操作は招待リンクを無効化し、その招待visitのactive sessionも同じD1 batchでsupersedeします。同じvisitのリンクを再発行した場合も旧リンクとactive sessionが無効になります。参加中の画面は次のheartbeatまたはAPI要求で停止するため、録音中の別タブを即時停止できるとはみなしません。現行管理画面はactive sessionを検知して再確認しないため、参加者と連絡が取れ、実施中でないことを確認するまでは再発行しません。

browser session tokenは既定12時間で失効します。これはbearer tokenを無期限化しないための認証TTLで、参加期限ではありません。同じactiveな招待linkを開き直すと新しいsession epochが発行され、serverに保存済みの未完了位置から再開できます。trial内の提示時間・応答窓と通信timeoutも、inter-visitの受付期限とは別です。

## 9. 状態確認

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- `participant_id_span.missing_ids_through_maximum` が発番台帳と一致し、ID 1から最大IDまでに説明のない欠番がない。
- `assignment_flow` のaccent×counterbalance cell別に、各visitの `issued` → `redeemed` → `first_trial` → `behavioral_completed` → `finalized` を確認し、条件別離脱を隠さない。`redeemed`はlinkを受け付けてsessionを発行した段階、`first_trial`は最初のtrialをserverへ開始記録した段階であり、同一視しない。
- 各セルで `assigned_count >= *_issued_count >= *_redeemed_count >= *_first_trial_count >= *_behavioral_completed_count >= *_finalized_count` を満たすことを確認する。違反は参加者の除外理由ではなく、まず状態遷移またはデータ完全性の異常として調査する。
- behavioral completion済みだが録音未送信のvisitがない。
- R2録音件数がD1の`recordings.state=uploaded`と一致する。
- `recordings.state=pending`が残る場合は完了扱いにせず、IndexedDBの元Blobを保持したまま担当者が原因を確認する。
- 同じ参加者へpre、immediate、delayedをこの順で送り、後続segment用に別tokenを送っていない。
- 遅延の実施日時と目標日時の差を記録した。

## 10. 録音ZIP

研究者は `/admin/` で参加者IDを参照し、「収集済み結果ZIPを保存」を押します。CLIでは次のようにオンデマンド取得できます。

```bash
curl -fL "https://EXPERIMENT.example/api/admin/participants/1/results.zip" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  --output accentedness_p1_results.zip
```

研究者APIは収集済みcanonical応答と、その時点でR2に存在するWAVを返します。研究者版filenameには研究用participant IDを含め、台帳との取り違えを防ぎます。参加者版filenameはIDを含まない固定名です。WAV entry名はvisit/segment/ordinalだけのopaque名ですが、研究者版`responses.json`には採点・照合に必要な刺激、条件、trial/attempt ID、再提示flag、R2 key、録音QCとの対応を含めます。参加者版にはこれらの研究用metadataを含めません。派生ZIPをCloudflareに保存するQueue・専用R2・export tableはありません。

参加者にはPre・直後でZIPを提示しません。Delayed visitを先に完了確定し、3 visitの全応答・録音が揃うことをserverが再検査した場合だけ、完了画面で保存操作を提示します。対応Chromeでは本人が保存先を選んだ後にfileへ直接streamし、全bytesの書込と`Content-Length`一致を確認してから完了表示にします。12時間のsession有効中なら完了画面の「もう一度保存」から再取得できます。未対応browserのBlob fallbackではdownload開始後にChromeのdownload一覧を本人に確認してもらいます。session失効後に再取得が必要なら研究担当者が管理APIから渡します。共用PCに音声を残すprivacy riskを同意・削除手順へ明記してください。

## 11. 中断・再開

- 同じ招待リンクを同じブラウザで開くと、保存済み位置から再開します。
- 別タブで再redeemすると新しいsession epochが発行され、古いタブはsupersededになります。
- 同じリンクを複数タブで開かないよう案内します。再度開いた場合は最新sessionだけが有効になり、旧タブは次のheartbeatまたはAPI要求で停止します。
- 試行onset後のreloadは再提示として記録され、`repeated_after_interruption` が立ちます。
- 応答PUTの一時失敗は同じ冪等keyで再送します。応答と録音の送信はIndexedDB outboxに保持されます。serverが録音待ちなのに対応するlocal Blobもない場合は、次試行へ進まず明示的に停止します。
- IndexedDBはserver保存前のcrash recovery専用です。D1の応答受理とR2の録音受理を両方確認したrecordは、visitを問わず次回flushまでに削除し、参加者端末を第二の恒久保存先にしません。
- 共用PCではvisitごとにoutboxを分離していますが、参加後はブラウザデータを研究運用規程に従って扱います。
- 中断・放棄された未送信WAVを自動削除する実装はありません。誤削除を避ける回収・破棄方針と保存期間を研究チームのデータ取扱手順に定めます。

## 12. セキュリティとデータ保全

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- `/admin/*` と `/api/admin/*` をCloudflare Accessで研究チームだけに制限する。
- `ADMIN_TOKEN` と `RANDOMIZATION_SECRET` をログ、文書、チャットへ貼らない。
- raw録音は個人識別性のある研究データとして扱う。

Cloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。

収集時の正本はD1とprivate R2です。IndexedDBは未送信データの一時outbox、結果ZIPは正本から要求時に作る派生copyです。Workerから研究者PCへ同期二重書きする機構や、本repo固有のbackup CLIは持ちません。ただし、backupを未決定のまま本番収集は開始しません。所属機関の規程に沿うCloudflare標準機能または機関管理の保管先を確定し、隔離した検証先へのD1復元を1回、WAV 1件のR2復旧とD1記録の`byte_count`・SHA-256照合を1回行い、担当者・日時・結果を残します。保管期限後にD1、R2、参加者端末copyをどう削除するかも同じ手順書で固定します。参加linkの受付上限をなくすことは、raw音声の保管期限をなくすことを意味しません。
