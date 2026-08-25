# データ辞書

## 1. 保存先

- D1: 条件割当、manifest、試行応答、時刻、QC、監査ログ
- R2 `RECORDINGS`: 参加者のWAV録音
- R2 `STIMULI`: 非公開の本番刺激

上記remote storageを収集時の正本とします。参加者browserのIndexedDBは、D1応答とR2録音の受理確認までBlobを保持する一時outboxで、両方の確認後にrecordを削除します。最終Delayed完了後の明示操作でだけ、D1/R2のcanonical dataから3 visit分の参加者向けZIPをオンデマンド生成します。このZIPは正本でもbackupでもありません。

管理者は氏名を実験システムへ入力しません。参加者が招待redeem時に入力した平文氏名は、D1、R2、API応答、Worker log、browser storage、参加者版・研究者版ZIPへ保存・出力しません。browserは送信直後に氏名inputを消去し、serverは正規化済み氏名から専用`IDENTITY_SECRET`によるHMAC verifierだけを生成します。募集上必要な氏名を保持する場合、その正本はリポジトリ外の募集台帳だけです。

クライアントへは全試行の骨格manifestだけを渡し、語、訳、条件、話者、R2 keyは渡しません。刺激は現在の未回答試行を認可します。現在試行にserver-sideの開始記録ができた後だけ、通信待ちを試行間隔から分離するため同じsegment内の次の1試行も先読みできます。segment境界と2試行以上先は拒否します。

## 2. 主なD1 table

| table | 単位 | 主な用途 |
|---|---|---|
| `participants` | 参加者 | 数値ID、active/completed/withdrawn、学習accent、24-cell、versions、root seed、割当JSON |
| `participant_identity_bindings` | 参加者 | 氏名平文ではなく、version付きHMAC verifier、作成・最終確認時刻、確認回数 |
| `visits` | 参加者×visit | pre/immediate/delayed状態、目標時刻、各segment時刻、完了・withdraw時刻 |
| `item_assignments` | 参加者×本番語 | variability、test accent、No話者、本番test話者 |
| `segments` | visit×課題 | 課題順、開始・完了 |
| `trial_manifest` | 試行 | 不変順序、刺激key、条件、practice、canonical attempt |
| `invitations` | 招待世代 | token hash、発行・redeem・revoke状態 |
| `sessions` | browser session | epoch、token hash、有効期限、supersede状態 |
| `trial_attempts` | 試行attempt | start/response key、応答JSON、再提示・追加曝露・abandoned状態 |
| `recordings` | attemptの録音slot | R2 key、SHA-256、CRC-32、bytes、WAV状態、abandoned状態、実測sample rate/count/duration、server算出QC |
| `events` | telemetry event | onset、visibility、audio、network等の時刻とpayload。氏名は含めない |
| `participation_interruptions` | 明示的中断request | pause/terminate、requested/paused/resumed/terminated、受理済み件数、canonical次ordinal |
| `audit_log` | 管理・participant・system操作 | 招待、氏名継続照合binding、中断、再開、参加終了、完了などの監査証跡。氏名は含めない |
| `analysis_intervals` | 参加者（view） | 行動endpointに基づくpre→学習、課題間、保持、遅延目標偏差の各間隔 |

### `GET /api/admin/summary` の `assignment_flow`

accent×counterbalance cellごとに、`assigned_count`と各visit prefix（`pre`、`immediate`、`delayed`）の次の列を返します。countの単位は招待世代数やtrial数ではなく参加者visit数です。

| suffix | 到達条件 |
|---|---|
| `*_issued_count` | そのvisitに招待が1世代以上発行された |
| `*_redeemed_count` | いずれかの招待が1回以上redeemされ、sessionが発行された |
| `*_first_trial_count` | そのvisitの `trial_attempts` が1件以上serverへ記録された。実質的なstarted段階 |
| `*_behavioral_completed_count` | 最終trialのcanonical responseが受理され、`behavioral_completed_at_ms` が記録された |
| `*_finalized_count` | 必要な応答・録音が揃い、`finalized_at_ms` が記録された |
| `ever_paused_count` | pause requestが1回以上ある参加者 |
| `currently_paused_count` | 現在`state=paused`の参加者 |
| `terminated_count` | `mode=terminate`かつ`state=terminated`の参加者 |

`assigned`、`issued`、`redeemed`、`first_trial`（started）、`ever_paused` / `currently_paused`、`terminated`、`behavioral_completed`、`finalized`は同一視しません。さらに`participation_interruptions`は`mode×state`別の件数を返し、`pause/requested`、`pause/paused`、`pause/resumed`、`terminate/requested`、`terminate/terminated`を通常完了と別に確認できます。永続終了した参加者は`participants.status=withdrawn`、未完了visitは`visits.status=withdrawn`にも現れます。

`recording_integrity`は次を別々に返します。

| key | 意味 |
|---|---|
| `canonical_pending_uploads` | canonical responseに対応し、まだupload待ちで、abandonedではない録音 |
| `noncanonical_abandoned_slots` | 再開時にsupersedeされ、canonical attemptではなくなったabandoned録音slot |
| `canonical_recordings_abandoned_after_termination` | responseはcanonicalだが、参加終了時に未uploadだったためabandonedとなった録音 |

したがって管理funnelでは、割当、redeem、開始、一時中断、永続終了、行動完了、録音を含むfinalizationを別々に報告でき、通常のupload待ちと終了・再開由来のabandonedを混同しません。

## 3. 主要な割当列

| 列 | 意味 |
|---|---|
| `numeric_id` | 研究用の正整数ID |
| `training_accent` | `english` / `chinese` / `japanese` |
| `counterbalance_cycle` | 24-cellを何巡したか |
| `counterbalance_cell` | アクセント内1–24のセル |
| `list_cell` | List 1/2のNo/High反転 |
| `order_cell` | 最初の学習block順 |
| `talker_cell` | No学習話者0–5。固定テスト話者の選択には使用しない |
| `assignment_version` | 設計・割当仕様の版 |
| `seed_algorithm_version` | seed/PRNG仕様の版 |
| `root_seed_hex` | 参加者固有256-bit seed。分析用に保護して扱う |
| `asset_version` | 刺激bundleの版 |

`test_talker_id`はaccentごとに1名へ固定され、参加者間・語間・時点間でrandomizeしません。このため、テストaccentと話者identityは完全に交絡します。この列を共変量としてモデルに足しても交絡は解消できず、推論対象は選定した3名の音声に限られます。

### 氏名入力の継続照合binding

`participant_identity_bindings`は管理者によるparticipant作成時には存在せず、参加者が有効な招待をID・氏名で最初に正常redeemした同じD1 batch内で作成します。`verifier_hex`は、NFKC・空白collapse・trim・Roman小文字化後の氏名を、participant UUIDと`numeric_id`へdomain-separated HMAC-SHA-256で結合した64桁hexです。`normalization_version`と`verifier_version`を必ず併記します。`IDENTITY_SECRET`自体も正規化済み氏名も保存しません。初回成功時は`confirmation_count=1`とし、以後の招待redeem成功時だけ増やします。不足・ID不一致・binding後の氏名不一致・競合時は変化しません。

同じ数値IDと正規化同値の氏名は同じbindingとして扱い、異なる氏名で既存verifierを上書きしません。初回アクセス資格は招待tokenと一致する数値IDであり、氏名は時点間の入力一貫性を確認する情報です。氏名は割当表、manifest、trial/event payload、session、R2 metadata、ZIP manifestのどれにも加えません。学習時accentとseedは`numeric_id`だけから決まります。

### 練習trial

専用練習項目は、Picture NamingのID 901 `abacus`、902 `binoculars`と、L2-to-L1のID 903 `thermometer`、904 `xylophone`、905 `detergent`です。全練習trialは`practice=1`かつ`exclude_from_analysis=1`です。これらのID・word、Picture Naming画像key、L2-to-L1の`practice` category音声keyは、本番24語のID・word・画像・音声keyと非重複です。Picture Naming練習とL2-to-L1練習も互いに別語です。

明示操作なしのtab・browser closeは`participation_interruptions`へ推測記録せず、visitも`completed`や`withdrawn`へ変更しません。最後にserverが受理したcanonical trialまでの未完了状態として、invitationのredeem・trial・visit funnelに残ります。terminateの`requested`状態で閉じた場合だけは、同じ招待linkで再認証したsessionから同じrequestをfinalizeできます。`requested_session_uuid`は要求を最初に受理したsessionの監査情報であり、再認証sessionへ書き換えません。

## 4. 試行応答

全taskにserver開始・受信時刻、クライアントの`performance.now()`、`performance.timeOrigin`、AudioContext clockの対応を保存します。responseはtask別、eventはtype別のfield allowlistで厳密に検証し、未知field、必須field欠落、非finite値、短すぎるserver elapsedをHTTP 422で拒否します。したがって`participant_name`等を任意payloadへ追加してもD1・ZIPへ入りません。

### learning

- visual onset/deadline
- audio scheduled onset/end、実duration
- imageかplaceholderか
- trial end

### picture_naming

- visual onset
- 10秒response deadline
- capture start/stop、sample rate、sample count
- analysis開始位置・sample数、RMS、peak、clipping ratio
- missing input frames

### l2_to_l1

- capture start
- audio scheduled/actual end
- audio offsetから10秒のresponse deadline
- sample rate、sample count、analysis開始位置・sample数、QC

## 5. 録音

clientは正規形44-byte headerのPCM mono 16-bit WAVを生成し、応答をcanonical化する前にRIFF長、sample rate、sample count、durationと応答metadataの一致を検査します。serverは最大4 MiB、正規形RIFF/WAVE chunk順、PCM、mono、16-bit、sample rate、data chunk、taskに応じたdurationを再検証します。さらにWAVから実測したsample rate/count/durationを受理済み応答と照合し、自己申告SHA-256と実bytesのSHA-256も照合します。RMS、peak、clipping ratioはPCM本体からserver側でも再計算し、client値との不一致を拒否します。canonical attemptの録音だけをR2へ条件付きPUTし、server実測値をD1とR2 metadataへ保存します。分析では`recordings`のserver算出QCを正本とし、応答JSON内のclient算出QCは検証・監査用とします。

R2 key:

```text
recordings/{participant_uuid}/{visit_type}/{segment}/{trial_uuid}/{attempt_uuid}.wav
```

raw録音は声紋・発話内容を含み得るため、匿名化済みの表データより厳しいアクセス制御と保管期間を適用します。

ZIPは保存済みのcanonical responseをD1から、対応するWAVをR2から読み、圧縮なしでresponseへ直接streamします。派生ZIPをR2やD1へ保存しません。entry名は `recordings/{visit_type}/{segment}/recording_NNN.wav` とし、刺激語、訳語、accent、話者、内部UUIDを含めません。参加者版`responses.json`にも内部UUIDや条件labelを含めず、試行順、応答payload、WAVのSHA-256等だけを記録します。研究者版は採点・正本照合のため、同じopaque WAV entryへ刺激、条件、trial/attempt ID、再提示flag、R2 key、server算出QCを対応づけます。

どちらのZIPにも氏名または氏名継続照合verifierを含めません。研究者版filenameに入るのは研究用数値IDだけです。

参加者APIはDelayed visitの完了後だけ利用でき、pre・immediate・delayedの3 visitがすべてcompletedで、全canonical応答と録音が揃うことを再検査します。研究者API `GET /api/admin/participants/{numeric_id}/results.zip` はADMIN_TOKENを要求し、その時点の収集済みcanonical応答と利用可能なWAVを返します。対応Chromeでは選択済みfileへresponse bodyを直接streamし、書込closeと`Content-Length`一致を成功条件にします。未対応browserのBlob fallbackでは検知できるのはZIP受信とdownload開始までで、disk保存完了とはみなしません。

## 6. 中断・参加終了データ

`participation_interruptions`はclient生成の`request_uuid`で冪等化し、`requested_session_uuid`、`mode`、`state`、request/finalize/resume時刻、request時点の`accepted_trial_count`と`next_ordinal`を保存します。`mode=pause`は同じactive invitationからの再開を許しますが、redeem時に`state=resumed`へ変えるのはfinalize済みの`paused`だけです。未確定の`requested`は次trialを禁止したまま送信・finalizeへ戻します。回復不能な未送信があれば、同じUUIDの行を`pause/requested`から`terminate/requested`へだけCAS更新できます。`mode=terminate`はfinalize後に`state=terminated`となり、再開を許しません。

中断request後は新規trial startを禁止しますが、raceで先に開始済みだった現在trialのresponseと録音uploadはfinalize前に受け付けられます。通常UIも現在trialを終えてからrequestし、request後にoutboxをflushします。D1 triggerはrequestとtrial start、招待発行、管理者revokeの競合を最終的に遮断します。

pauseはvisitのstatusや完了時刻を変更せず、canonical responseに対応する未upload録音が0件であることをserverがfinalize時に再検査してからsessionだけをcloseします。未upload録音があればrequestを`requested`のまま残してHTTP 409を返します。再開時のcanonical次位置は`trial_manifest.canonical_attempt_uuid`から再計算します。未受理の旧attemptを再提示した場合は`abandoned_at_ms`と`abandon_reason=superseded_on_resume`を記録し、新attemptを別行にします。

terminateは受理済みcanonical response、upload済みWAV、完了済みvisitを保持します。未受理attemptは非canonicalのまま`participant_terminated`でabandonedにし、canonical responseに対応する未upload録音も同じ理由でabandonedにします。参加者と未完了visitを`withdrawn`にし、active session・招待を閉じます。終了処理はsegment完了、`behavioral_completed_at_ms`、`finalized_at_ms`を設定しません。

## 7. 時刻の定義

| 時刻 | 基準 |
|---|---|
| `server_*_at_ms` | WorkerのUnix epoch ms |
| `client_*_perf_ms` | そのpage lifecycle内のmonotonic clock |
| `performance_time_origin_ms` | performance clockとepochの対応 |
| `*_context_s` | AudioContext clock |
| `target_at_ms` | Immediate最終L2-to-L1行動応答のserver受理時刻＋5日 |
| delayed実施開始 | delayedの最初のPicture Naming trialのserver開始 |
| pre→学習間隔 | immediateのlearning `segments.started_at_ms` − pre `behavioral_completed_at_ms` |
| learning→直後PN間隔 | immediate PN `segments.started_at_ms` − immediate learning `segments.completed_at_ms` |
| 直後PN→L2間隔 | immediate L2 `segments.started_at_ms` − immediate PN `segments.completed_at_ms` |
| 保持間隔 | delayedのPicture Naming `segments.started_at_ms` − immediate `behavioral_completed_at_ms` |
| 遅延目標偏差 | delayedのPicture Naming `segments.started_at_ms` − delayed `target_at_ms` |
| 遅延PN→L2間隔 | delayed L2 `segments.started_at_ms` − delayed PN `segments.completed_at_ms` |

6つの分析用間隔はD1 view `analysis_intervals`を正本とします。`visits.first_started_at_ms`は招待linkをredeemしてvisit sessionを開始した時刻、`visits.finalized_at_ms`は全応答・録音が揃ってvisitを確定した時刻であり、行動endpoint間隔には使いません。時刻源を直接混ぜず、保存されたanchorから同一clock内の差または明示的な変換を使います。受付上限を設けないことと時間を無視することは同義ではなく、実間隔を全例保持して条件別報告と、PI・共同研究者がリポジトリ外で結果確認前に固定した感度分析に用います。`target_deviation_ms`は`retention_interval_ms − 5日`と定数差なので、同じmodelへ両方を説明変数として入れません。またdelayed時期はpost-treatmentになり得るため、自動的な共変量調整を欠測・脱落biasの解決策とみなしません。

`target_at_ms`は保持間隔の下限を示す行動時刻です。Delayed招待の発行には、これに加えてImmediate visitが全応答・録音の保存確認を終えた`completed`状態であることを要求します。保存確認が遅れてもtargetを後ろへ再計算せず、実際の保持間隔をそのまま記録します。

## 8. 分析対象と除外候補

`practice=1` または `exclude_from_analysis=1` は本分析から除外します。以下は一律削除ではなく、PI・共同研究者がリポジトリ外で結果確認前に固定した規則と感度分析に使います。

- `repeated_after_interruption`
- `extra_exposure`
- `abandoned_at_ms` / `abandon_reason`
- `missing_input_frames`
- low RMS / high clipping ratio
- missing or invalid recording
- visibility中断
- timing deviation
- delayed targetからの偏差
- asset/assignment version差

canonical responseとcanonical recordingを結合し、orphan attempt、abandonedな非canonical slot、参加終了後にupload不能となったcanonical pending recordingを完全データへ混ぜません。
構造不良、metadata不一致、ローカル欠損で送信不能な回答・録音は自動で欠測完了にしません。元Blobと`recordings.state=pending`を削除せず課題を停止し、担当者が原因を確認します。ネットワーク由来の一時エラーだけを自動再送します。参加者が永久終了を明示した場合に限り、未送信を明記してserver受理済み範囲で終了できます。この場合も通常完了にはせず、該当slotをabandonedとして残します。

## 9. 採点データ

現行アプリは発話を収集しますが、自動採点は行いません。研究チームは別工程で次を定義します。

- Picture Namingの正答、許容語形、言い直し、無応答。
- L2-to-L1の正答、日本語同義語、部分正答、無応答。
- 複数評定者、盲検化、評定者間一致、disagreement解消。
- latencyを分析する場合のacoustic onset測定法。

採点表には最低限 `attempt_uuid`、`trial_uuid`、`rater_id`、`score`、`decision_code`、`scoring_version` を持たせ、raw D1/R2を上書きしません。
