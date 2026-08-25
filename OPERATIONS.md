# Cloudflare運用手順

本書のgateは本番環境でデータを回収できるかを判定するものであり、リポジトリのコード完成判定ではありません。研究ガバナンス上の判断は本書のscope外です。

## 1. 構成

- Worker: API、認証、manifest配信、現在試行と条件付き1試行先だけの刺激配信
- Static Assets: HTML、CSS、JavaScript、開発用プレースホルダー音声
- D1: 参加者、割当、visit、試行、応答、イベント、監査ログ
- R2 `STIMULI`: 非公開の本番画像・音声
- R2 `RECORDINGS`: 非公開の参加者録音

管理APIはBearer tokenで保護されています。本番ではそれに加え、`/api/admin/*` をCloudflare Accessで研究チームだけに制限してください。参加者IDには学籍番号や氏名を使わず、研究用の連番だけを使います。氏名はリポジトリ外の募集台帳だけに記録し、D1/R2や運用メモへ転記しません。

## 2. 非本番placeholder pilotのセットアップと`0006` rollout

24語slotはプレースホルダーのまま進めます。top-level設定を非本番pilotとして使い、新しい`env.pilot`は追加しません。`ENVIRONMENT=development`、`ALLOW_PLACEHOLDER_ASSETS=true`、`TEST_TOKEN_POLICY=undecided`の組合せは意図したpilot設定です。

現行実装は、参加者ID・3 visit・24 item割当・6 segment・276 trial・監査記録を311文のD1 batchで原子的に保存します。氏名HMACは参加者の最初の正常な招待redeem時に、visit・session・redeem回数・auditと同じ別batchで保存します。2026-08-26時点のWorkers上限では、D1など内部serviceへのsubrequestはFreeで1 Worker invocationあたり1,000、Paidの既定値は10,000であり、311文だけを理由にPaidを必須としません。planは本番相当pilotのCPU時間、traffic、support要件を含めて決めます。Cloudflare公式の [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) と [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) は配備直前にも確認します。

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

既存の非本番へ`0006_identity_and_participation_interruptions.sql`をrolloutするときは、順序を変えません。

1. 独立した安定`IDENTITY_SECRET`を先にWorker secretへ設定し、存在だけを確認する。
2. `0006` migrationをD1へ適用する。
3. `0006`を前提にするWorkerをdeployする。

新コードを先にdeployするとidentity table不在で失敗します。migrationを先に適用しても、`IDENTITY_SECRET`不在なら参加者のredeemはfail closedになり、productionではcollection safety gateによりparticipant作成・招待発行も拒否されます。developmentではID-only participant作成自体は可能ですが、redeemできないため収集開始状態ではありません。旧コードは`IDENTITY_SECRET`を参照しないため、secretを先に設定する順序が最小riskです。値は出力せず、`secret list`ではkey名だけを確認します。

```bash
npx wrangler secret put IDENTITY_SECRET --env=""
npx wrangler secret list --env=""
npx wrangler d1 migrations apply DB --remote --env="" --no-x-provision
npx wrangler deploy --env="" --strict --no-x-provision
```

Wranglerの自動resource provisioningは既定で有効です。明示作成後は`--no-x-provision`を付け、binding不足を黙って新規resource作成で補わせません。`--strict`はDashboard等の競合するremote変更がある場合にuploadを止めます。

`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`がまだない新規環境では、`0006` rolloutより前に、`IDENTITY_SECRET`を含む3つの独立した長い乱数値を設定します。値をcommand引数、文書、chat、shell historyへ書きません。

```bash
npx wrangler secret put ADMIN_TOKEN --env=""
npx wrangler secret put RANDOMIZATION_SECRET --env=""
npx wrangler secret put IDENTITY_SECRET --env=""
npx wrangler secret list --env=""
```

現在のWranglerでは`secret put`自体が新しいWorker versionを作り、直ちにdeployします。単なる設定保存とは扱いません。`ADMIN_TOKEN`は24文字以上かつ`[A-Za-z0-9._~-]+`だけで構成します。hexはこの条件を満たします。`RANDOMIZATION_SECRET`と`IDENTITY_SECRET`も24文字以上とし、互いにも`ADMIN_TOKEN`とも別値にします。`RANDOMIZATION_SECRET`は同じassignment version中、`IDENTITY_SECRET`は既存bindingを使う全期間で固定します。後者を無計画にrotateすると既存参加者を照合できなくなるため、紛失・漏えい時は別migrationと全bindingの再登録を伴う事故対応として扱います。

初回deployへsecretを同梱する場合は、Git・Dropbox外の権限`0600`一時fileを`--secrets-file`へ渡し、成功直後にそのfileを削除します。3 secretを同梱し、`IDENTITY_SECRET`なしで`0006`対応codeを起動しません。secret値をcommand引数、標準出力、shell historyへ出しません。2026-08-26の旧非本番bootstrapも`--secrets-file`方式でしたが、`IDENTITY_SECRET`は`0006` rolloutの先行手順として別途設定します。

2026-08-26以降、非本番`ADMIN_TOKEN`の暫定正本はrepository外の親directoryにある`.env`です。file modeは`0600`とし、この単一keyだけを標準入力経由でWranglerへ渡します。`.env`全体またはtoken値を表示・記録しません。rotation後に新tokenでHTTP 200、旧tokenでHTTP 403を確認し、bootstrap用の一時handoff directoryは削除済みです。この`.env`はDropbox同期対象なので、現時点の非本番運用にだけ用い、production secretの恒久正本とはみなしません。`RANDOMIZATION_SECRET`、production resource、production secretはこのrotationで変更していません。

`0006`適用後の非本番`GET /api/health`の期待値は、`environment=development`、`placeholder_assets=true`、`test_token_policy=undecided`、`test_token_policy_ready=false`、`admin_authentication_ready=true`、`randomization_ready=true`、`identity_verification_ready=true`、`secrets_independent=true`、`collection_ready=false`です。これは3 secretを分離して氏名HMAC照合を有効にした正常なplaceholder pilot状態です。未使用IDでparticipantを1名作成し、311文batch、作成直後のidentity binding 0件、Pre初回redeem後のbinding 1件、氏名不一致時無変更、D1/R2 binding、管理token拒否、R2非公開を確認します。2026-08-26に旧実装で確認した311文batchは旧契約の履歴証拠であり、現行ID-only作成batchの証拠には流用しません。現在の非本番URLは`https://accentedness-main-experiment.komuro-4121.workers.dev`です。

## 3. productionの初回セットアップ

非本番pilotを通過するまでproduction resourceは作成しません。productionへ進む場合は採用planを確定し、非本番と同じread-only衝突監査を繰り返します。

`0006`の今回のrolloutではproduction resource、D1、R2、secret、Workerを変更していません。以下はproduction移行を別途承認した後にだけ実行する将来手順です。

```bash
npx wrangler d1 create main-experiment-production
npx wrangler r2 bucket create main-experiment-recordings-production
npx wrangler r2 bucket create main-experiment-stimuli-production
```

D1作成時の`database_id`を`wrangler.jsonc`の`env.production`にある`DB` bindingだけへ追記します。環境別のD1、R2、vars、secretは継承されないため、default非本番と取り違えないことを別担当者が確認します。productionでも安定`IDENTITY_SECRET`を先に設定し、次に`0006`を含むmigration、最後に対応Workerをdeployします。

```bash
npx wrangler secret put ADMIN_TOKEN --env production
npx wrangler secret put RANDOMIZATION_SECRET --env production
npx wrangler secret put IDENTITY_SECRET --env production
npx wrangler secret list --env production
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler deploy --env production --strict --no-x-provision
```

`secret put`は各回とも即時deployを伴います。3つとも独立した長い乱数値を使い、`RANDOMIZATION_SECRET`は同じassignment version中、`IDENTITY_SECRET`は既存bindingを使う全期間で変更しません。新規Workerへはrepository外の`--secrets-file`で3 secretを最初のversionに同梱しても構いませんが、`0006`対応codeをsecretなしでdeployしてはいけません。

`0005_remove_recording_exports.sql` が削除するのは、旧Queue方式で作った派生ZIPの状態表だけです。canonical応答・録音metadata・監査logは削除しません。旧版を一度でも配置した環境では、bindingを設定から消しても既存のQueue、DLQ、旧`EXPORTS` bucketは自動削除されません。未作成ならこの確認はN/Aです。存在する場合は、正本DB・`RECORDINGS`・`STIMULI`と取り違えていないこと、必要な派生ZIPがないことを二名で確認してから、Cloudflare側で旧資源だけを廃止します。旧5分cronは設定省略では残るため、`wrangler.jsonc` のroot・production双方で`"triggers": { "crons": [] }`を明示し、次回deploy後にDashboardで消滅を確認します。確認までは空配列を削除しません。

`0006_identity_and_participation_interruptions.sql`は、平文氏名を持たない`participant_identity_bindings`、一時中断・参加終了の`participation_interruptions`、withdraw/abandon列、race防止index・triggerを追加します。既存のcanonical responseやR2 objectは削除しません。bindingのない既存参加者にも招待を発行でき、参加者が次に有効なlinkを正常redeemした時点で氏名HMACを初回登録します。

## 4. ローカル開発

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`.dev.vars` はcommit対象外です。開発環境のプレースホルダーは動作確認専用です。

`ADMIN_TOKEN`、`RANDOMIZATION_SECRET`、`IDENTITY_SECRET`には独立した24文字以上の開発用値を設定します。氏名や本番secretをローカル設定へ流用しません。

## 5. 本番前ゲート

実刺激をR2へ配置し、[STIMULUS_REPLACEMENT.md](./STIMULUS_REPLACEMENT.md) のチェックを完了してから、`wrangler.jsonc` の `env.production.vars` だけを次のように変更します。

練習刺激も本番24語の流用ではありません。Picture NamingはID 901 `abacus`・902 `binoculars`の専用画像、L2-to-L1はID 903 `thermometer`・904 `xylophone`・905 `detergent`について3 accents分、計9個の`practice`専用WAVを配置します。ID、word、image/audio keyが本番刺激と非重複で、practice/main間に同一SHA-256の画像・音声がなく、全練習trialが`practice=1`かつ`exclude_from_analysis=1`であることを本番相当pilotで確認します。

```jsonc
"ENVIRONMENT": "production",
"ASSIGNMENT_VERSION": "main-v3-real-assets",
"ASSET_VERSION": "main-assets-v1",
"ALLOW_PLACEHOLDER_ASSETS": "false",
"TEST_TOKEN_POLICY": "same_token"
```

version名は例です。実際の凍結版に合わせ、`SEED_ALGORITHM_VERSION` も収集開始前に固定します。`same_token` は現行manifestが実装済みの「同一話者・同一語・同一WAVを直後と遅延で再提示する」方針です。時点別の別takeを採用する場合、`timepoint_take` と書くだけでは動作せず、key規約・manifest・テストを先に変更する必要があります。プレースホルダーが残る、明示的に許可される、対応済みtoken方針が未指定、または3 secretのいずれかが未設定・24文字未満・相互に同値なら、productionの参加者作成・招待発行・招待redeem・新規trial開始はHTTP 503で遮断され、healthの`collection_ready`もfalseになります。すでに開始済みのtrialについては、データ喪失を避けるため応答と録音uploadを受け付けます。このゲートを緊急停止や参加終了の機能とはみなしません。参加者本人の一時中断・永続終了には第11節の明示的protocolを使い、管理者revokeで代用しません。

デプロイ前に実行します。

```bash
npm run types
npm run verify
npx wrangler deploy --env production --strict --no-x-provision
```

`GET /api/health` の `collection_ready` が `true` であることを確認します。さらに、非本番IDで全導線を実施し、D1応答数、R2録音数、音声内容、Immediate最終L2-to-L1行動応答のserver受理時刻から遅延目標時刻までが正確に5日であることを確認します。

participant-facing UIを変更した後は、変更前のvisitを同じclean-path証拠へ混ぜません。新しい未使用IDを使い、desktop Chrome 1366×768・zoom 100%を最低基準として、各試行前の注視点、練習から本番へのprogress reset、現在試行と完了数、Picture Naming画像onset後の10秒表示、L2音声終了後の10秒表示、部分保存と「全試行・録音の保存完了」の区別を実画面で確認します。countdownは表示だけを担い、録音停止・刺激順・manifest timingを変更しないことを自動testでも固定します。

参加者向け結果ZIPは3 visit分のWAVをR2から直接streamします。通常の48 kHz mono PCMでは概算130 MiB前後、各録音の上限4 MiBを単純合計した保守的上限では約520 MiBになり得ます。対応するdesktop ChromeではFile System Access APIで選択済みfileへ直接書き、browser memoryへ全量保持しません。転送中に進捗しているZIPを固定15分で切る上限は設けず、response headerの受信開始だけを30秒でtimeoutします。未対応時だけBlob downloadへfallbackするため、本番相当データで直接保存が使われること、生成時間、memory、再試行をpilotしてください。ZIP失敗はすでに完了したvisitやD1/R2正本を取り消しません。

## 6. preリンクとMain Experimentリンクの手動発行

通常運用では `https://EXPERIMENT.example/admin/` を開き、ADMIN_TOKENと募集台帳の数値参加者IDだけを入力して参加者を登録または参照し、各visitのリンク発行、遅延対象、全体状態を確認します。管理画面へ氏名を入力しません。ページと管理APIの両方をCloudflare Accessで研究チームだけに制限してください。

参加者IDは募集順の連番で付与し、pre後の離脱、一時中断、永続的な参加終了があっても再利用しません。IDの余りが学習時accentを決めるため、担当者が条件を見てIDを選ぶ、または恣意的な欠番を作る行為は割付バイアスになります。現行画面は欠番をsummaryで検出しますが、原子的な自動連番発番は未実装です。本番開始前に外部台帳を含む発番責任者・手順・監査証跡を確定するか、サーバー発番へ切り替えてください。氏名はこの募集台帳以外の作業表、ticket、chat、D1 memoへ記録しません。

CLIで行う場合は、以下のURLとtokenを実環境値に置き換えます。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/participants" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"participant_id": 1}'
```

管理APIは`participant_name`を受け付けません。管理者はIDだけを登録・参照し、氏名を募集台帳から管理画面へ転記しません。割付も数値IDだけで行います。

同じIDを管理画面で再入力すると、氏名入力なしで既存の不変manifestを参照します。参加者が初回redeem済みかは`identity_registered`で確認できますが、管理者が氏名を閲覧・修正する機能はありません。IDを新規参加者へ付け直して解決してはいけません。

返される最初の`invitation_url`は`/pre-picture-naming/`です。このURLだけを該当参加者へ手動で送ります。参加者は新しい招待linkを開いたとき、案内されたIDと自身の氏名を入力します。Pre初回は招待token＋一致するIDをアクセス資格として氏名HMACを登録し、以後のlinkでは同じ正規化済み氏名かを照合します。ID不足・不一致、氏名不足、binding後の氏名不一致なら汎用HTTP 409となり、binding、visit、session、招待redeem回数、確認回数、audit logは変わりません。URL fragmentのraw tokenはD1やサーバーログへ保存されず、D1にはhashだけが保存されます。同じvisitに対して再発行すると古い招待はrevokeされます。

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

## 8. 招待revoke、明示的中断、session

activeな招待linkには経過時間による自動失効がなく、visit完了、明示的revoke、同じvisitへの再発行、または永続的な参加終了まで利用できます。管理者revokeは、未使用linkの取消、誤配布、漏えい、再発行のための招待管理です。課題中の参加者が「一時中断」または「参加を終了する」を選ぶ処理には使いません。

```bash
curl -sS -X POST "https://EXPERIMENT.example/api/admin/invitations/INVITE_UUID/revoke" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

この操作は招待リンクを無効化し、その招待visitのactive sessionも同じD1 batchでsupersedeします。同じvisitのリンクを再発行した場合も旧リンクとactive sessionが無効になります。参加中の画面は次のheartbeatまたはAPI要求で停止するため、録音中の別タブを即時停止できるとはみなしません。現行管理画面はactive sessionを検知して再確認しないため、参加者と連絡が取れ、実施中でないことを確認するまでは再発行しません。`requested`または`paused`のinterruptionがopenな間は、APIとD1 triggerが招待発行・管理者revokeを拒否します。

browser session tokenは既定12時間で失効します。これはbearer tokenを無期限化しないための認証TTLで、参加期限ではありません。同じactiveな招待linkを開き直し、IDと氏名を再確認すると新しいsession epochが発行され、serverに保存済みのcanonical次位置から再開できます。trial内の提示時間・応答窓と通信timeoutも、inter-visitの受付期限とは別です。

## 9. 状態確認

```bash
curl -sS "https://EXPERIMENT.example/api/admin/summary" \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

次を毎回確認します。

- visit状態と参加者台帳が一致する。
- `participant_id_span.missing_ids_through_maximum` が発番台帳と一致し、ID 1から最大IDまでに説明のない欠番がない。
- `assignment_flow` のaccent×counterbalance cell別に、`assigned`と各visitの `issued` → `redeemed` → `first_trial`（started）→ `behavioral_completed` → `finalized` を確認し、条件別離脱を隠さない。`redeemed`はlinkを受け付けてsessionを発行した段階、`first_trial`は最初のtrialをserverへ開始記録した段階であり、同一視しない。
- 同じ`assignment_flow`の`ever_paused_count`、`currently_paused_count`、`terminated_count`を、`assigned_count`や各visitのstarted/completed/finalized件数と別々に確認する。
- 各セルで `assigned_count >= *_issued_count >= *_redeemed_count >= *_first_trial_count >= *_behavioral_completed_count >= *_finalized_count` を満たすことを確認する。違反は参加者の除外理由ではなく、まず状態遷移またはデータ完全性の異常として調査する。
- `participation_interruptions`を`mode×state`で確認し、pauseの`requested`・`paused`・`resumed`とterminateの`requested`・`terminated`を、通常の行動完了・finalizationから分ける。永続終了は`participants.status=withdrawn`と未完了`visits.status=withdrawn`にも反映される。
- terminateが`requested`のまま残る場合は、参加者へ元のactive招待linkを再度開いてID・氏名を入力してもらう。新trialは開始されず、browser内の送信待ちを再送して同じrequestのfinalize画面へ戻る。明示操作なしのtab closeはinterruptionへ推測変換せず、未完了funnelとして扱う。
- behavioral completion済みだが録音未送信のvisitがない。
- R2録音件数がD1の`recordings.state=uploaded`と一致する。
- `recording_integrity.canonical_pending_uploads`が残る場合は完了扱いにせず、IndexedDBの元Blobを保持したまま担当者が原因を確認する。
- `recording_integrity.noncanonical_abandoned_slots`はpause後の再提示でsupersedeされたslot、`canonical_recordings_abandoned_after_termination`はcanonical response受理後に参加終了でupload不能となった録音として別々に確認する。どちらも通常のpendingやuploadedへ合算しない。
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

参加者にはPre・直後でZIPを提示しません。Delayed visitを先に完了確定し、3 visitの全応答・録音が揃うことをserverが再検査した場合だけ、完了画面で保存操作を提示します。対応Chromeでは本人が保存先を選んだ後にfileへ直接streamし、全bytesの書込と`Content-Length`一致を確認してから完了表示にします。12時間のsession有効中なら完了画面の「もう一度保存」から再取得できます。未対応browserのBlob fallbackではdownload開始後にChromeのdownload一覧を本人に確認してもらいます。session失効後に再取得が必要なら研究担当者が管理APIから渡します。共用PCに音声を残すriskと削除方法は、PIが管理するリポジトリ外の参加者向け手順に記載します。これはコード完成の技術ゲートではありません。

## 11. 一時中断・参加終了・再開

参加者画面の「中断・終了」から、`一時中断する`と`参加を終了する`を明示的に選びます。どちらも通常のvisit完了ではなく、管理者revokeでもありません。

### 一時中断

- 試行中に押した場合、画面は「この試行後に確認」と表示し、その1試行の応答をserverへ受理させてからinterruption requestを送ります。request後は新規trialを開始せず、送信待ち録音をflushしてfinalizeします。
- requestとtrial startがraceした場合も、先に開始済みの現在trialだけは応答・録音をdrainできます。requestが先ならAPI検査とD1 triggerの両方が新規trial startを拒否します。
- finalize時にもserverがcanonical responseに対応する録音待ち0件を再検査します。1件でも残ればpauseは`requested`のままHTTP 409で拒否し、sessionを閉じません。成功後も参加者・visitはactive/startedのままで、completion timestampを設定せず、同じ招待をactiveに保ちます。再開用の別linkを発行しません。
- 再開時は同じ元の招待linkを開き、IDと氏名を再入力します。新session epochが発行され、accepted canonical trialの直後から再開します。旧sessionはclosedです。
- request後・finalize前にtabを失った場合は、同じlinkで再認証してもpauseを自動resumeしません。新trialを禁止したまま送信待ちを再送し、pauseのfinalizeを先に終えます。`paused`確認後にもう一度同じlinkを開いた時点を`resumed`とします。
- 回答または録音を回復不能な理由で送れず安全な再開を保証できない場合、画面は「参加終了へ切り替える」と「切り替えず案内を見る」を分けます。前者は同じrequest UUIDの`pause/requested`を`terminate/requested`へ一方向に変更し、server受理済み範囲での終了を再確認します。後者はpauseを未確定のまま残すため、確認コードを記録します。
- 開始済みだが未受理だったtrialを再提示する場合、旧attemptとその録音slotは`superseded_on_resume`でabandoned・非canonicalになり、新attemptに`repeated_after_interruption=1`を付けます。学習trialなら`extra_exposure=1`も付きます。

### 永続的な参加終了

- request後の新規trialを止め、通常UIは送信待ちをflushしてからfinalizeします。すでにD1が受理したcanonical responseとR2へupload済みのWAVは削除・上書きしません。
- 未受理attemptとその録音slotは`participant_terminated`でabandoned・非canonicalにします。responseはcanonicalだがWAVが未uploadのslotもabandonedとして別集計し、完全録音とはみなしません。
- 完了済みvisitとそのcompletion timestampは保持します。未完了visitだけを`withdrawn`にし、`withdrawn_at_ms`を記録します。終了処理は`behavioral_completed_at_ms`、segment完了時刻、`finalized_at_ms`を新規設定してはいけません。
- participantを`withdrawn`にし、全active sessionと招待を閉じます。終了後は同じlinkから再開できず、IDも再利用しません。

### 共通の再送・race対策

- request UUIDとfinalizeは冪等です。open interruptionはD1一意indexで1件に制限し、trial start、招待発行、管理者revokeとの競合をD1 triggerでも遮断します。open interruption中はvisit completionも拒否します。
- pauseからterminateへの切替も同じrequest UUIDで冪等です。別participant・別visit、terminateからpauseへの逆行、`paused`・`resumed`・`terminated`など確定後のmode変更は拒否します。
- 別タブで通常redeemすると新しいsession epochが発行され、古いタブはsupersededになります。同じlinkを複数タブで開かないよう案内します。
- 試行onset後のreloadは再提示として記録され、`repeated_after_interruption`が立ちます。
- 応答PUTの一時失敗は同じ冪等keyで再送します。応答と録音はIndexedDB outboxに保持します。再訪時にoutboxの欠損・破損・読出不能または確定的4xxを検出した場合は次試行やpauseへ進めず、server受理済み範囲での参加終了か、終了せず担当者へ連絡するかを明示選択します。
- 試行中に「中断・終了」を押した後、その試行自体のerrorで中断requestまで進めなかった場合、fatal画面は通常完了・中断確定・server受理範囲をいずれも断定しません。参加者には同じactive招待linkを開き直してID・氏名を再入力し、新trialを始める前に「中断・終了」を選ぶよう案内します。linkを開けない、または状態が不明ならerror codeとともに担当者へ連絡してもらいます。
- IndexedDBはserver保存前のcrash recovery専用です。D1の応答受理とR2の録音受理を両方確認したrecordは、visitを問わず次回flushまでに削除し、参加者端末を第二の恒久保存先にしません。
- 中断・終了時に送れなかったWAVを自動削除する実装はありません。D1側のabandoned記録とbrowser内Blobを混同せず、回収・破棄方針に従います。

## 12. セキュリティとデータ保全

- R2 bucketを公開しない。
- D1/R2/Workerへの権限を最小限にする。
- `/admin/*` と `/api/admin/*` をCloudflare Accessで研究チームだけに制限する。
- `ADMIN_TOKEN`、`RANDOMIZATION_SECRET`、`IDENTITY_SECRET`をログ、文書、チャットへ貼らない。3つを相互流用しない。
- 氏名は募集台帳から管理画面へ転記しない。participant画面の一時input以外に、D1、R2、API応答、Worker log、browser storage、ZIPへ平文氏名がないことをpilotで確認する。trial/event payloadへ氏名canaryを混ぜたrequestがHTTP 422で拒否され、D1・ZIPへ0件である自動testも維持する。
- raw録音は個人識別性のある研究データとして扱う。

Cloudflare Accessはリポジトリ外のアカウント設定です。コードが存在するだけでは有効にならないため、本番チェックリストで別項目として確認します。

収集時の正本はD1とprivate R2です。IndexedDBは未送信データの一時outbox、結果ZIPは正本から要求時に作る派生copyです。Workerから研究者PCへ同期二重書きする機構や、本repo固有のbackup CLIは持ちません。ただし、backupを未決定のまま本番収集は開始しません。所属機関の規程に沿うCloudflare標準機能または機関管理の保管先を確定し、隔離した検証先へのD1復元を1回、WAV 1件のR2復旧とD1記録の`byte_count`・SHA-256照合を1回行い、担当者・日時・結果を残します。保管期限後にD1、R2、参加者端末copyをどう削除するかも同じ手順書で固定します。参加linkの受付上限をなくすことは、raw音声の保管期限をなくすことを意味しません。
