# データ辞書

## 1. 保存先

- D1: 条件割当、manifest、試行応答、時刻、QC、監査ログ
- R2 `RECORDINGS`: 参加者のWAV録音
- R2 `STIMULI`: 非公開の本番刺激

上記remote storageを収集時の正本とします。参加者browserのIndexedDBは、D1応答とR2録音の受理確認までBlobを保持する一時outboxで、両方の確認後にrecordを削除します。Pre・Immediate・Delayed各visitの保存確定後に、D1/R2のcanonical dataから当該visitまでの累積参加者向けZIPを自動取得します。これは補助コピーであり、正本や研究者版backupの代替ではありません。

参加者の氏名は収集しません。参加者画面、管理画面、API、D1、R2、Worker log、browser storage、trial/event、session、監査detail、参加者版・研究者版ZIPのどこにも入力・表示・保存しません。参加者は研究用数値IDだけを入力し、画面に表示された同じIDを確認して開始します。

旧migrationで作成済みの`participant_names` tableはschema互換性のため削除しませんが、runtimeから参照・更新せず0行を維持します。開始APIに氏名関連fieldが届いた場合はHTTP 422で拒否します。研究用IDは低entropyであり本人認証要素ではありません。

通常参加者のクライアントへは全試行の骨格manifestだけを渡し、語、訳、条件、話者、R2 key、`exclude_from_analysis`は渡しません。刺激は現在の未回答試行を認可します。現在試行にserver-sideの開始記録ができた後だけ、通信待ちを試行間隔から分離するため同じsegment内の次の1試行も先読みできます。segment境界と2試行以上先は拒否します。開発限定のID `999`は別境界で、管理Bearer認証後だけ`main-assets-v2`の正規keyを含む同一origin test刺激endpointを受け取り、D1 manifestや回答・録音は作りません。

## 2. 主なD1 table

| table | 単位 | 主な用途 |
|---|---|---|
| `participants` | 参加者 | 数値ID、active/completed/withdrawn、学習accent、24-cell、versions、root seed、割当JSON |
| `participant_names` | legacy / 未使用 | 旧schema互換用。runtimeは参照・更新せず0行を維持 |
| `visits` | 参加者×visit | pre/immediate/delayed状態、目標時刻、各segment時刻、完了・withdraw時刻 |
| `item_assignments` | 参加者×本番語 | variability、test accent、No話者、本番test話者 |
| `segments` | visit×課題 | 課題順、開始・完了 |
| `trial_manifest` | 試行 | 不変順序、刺激key、条件、practice、canonical attempt |
| `invitations` | 内部session bootstrap世代 | 既存session schemaとの互換用token hash・開始状態。参加者へ配るURLではない |
| `sessions` | browser session | epoch、token hash、有効期限、supersede状態 |
| `trial_attempts` | 試行attempt | start/response key、応答JSON、再提示・追加曝露・abandoned状態 |
| `recordings` | attemptの録音slot | R2 key、SHA-256、CRC-32、bytes、WAV状態、abandoned状態、実測sample rate/count/duration、server算出QC |
| `events` | telemetry event | onset、visibility、audio、network等の時刻とpayload。allowlist外fieldは拒否 |
| `participation_interruptions` | 明示的中断request | pause/terminate、requested/paused/resumed/terminated、受理済み件数、canonical次ordinal |
| `audit_log` | 管理・participant・system操作 | design作成、session開始、中断、再開、参加終了、完了などの監査証跡 |
| `analysis_intervals` | 参加者（view） | 行動endpointに基づくpre→学習、課題間、保持、遅延目標偏差の各間隔 |

### `GET /api/admin/summary` の `assignment_flow`

accent×counterbalance cellごとに、`assigned_count`と各visit prefix（`pre`、`immediate`、`delayed`）の次の列を返します。countの単位は内部bootstrap世代数やtrial数ではなく参加者visit数です。既存列名の`issued`・`redeemed`は共通入口がsessionを作る内部段階であり、担当者によるURL発行・配布件数ではありません。

| suffix | 到達条件 |
|---|---|
| `*_issued_count` | そのvisitに内部session bootstrap recordが1世代以上作成された |
| `*_redeemed_count` | 共通入口からsessionが1回以上発行された |
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
| `numeric_id` | JavaScriptの安全整数範囲内にある先頭ゼロのない研究用正整数ID。`999`は開発用非保存testに予約し、通常収集では拒否 |
| `training_accent` | `english` / `chinese` / `japanese` |
| `counterbalance_cycle` | 24-cellを何巡したか |
| `counterbalance_cell` | アクセント内1–24のセル |
| `list_cell` | List 1/2のNo/High反転 |
| `order_cell` | Learning条件順。0はNo-first、1はHigh-first |
| `talker_cell` | No学習話者0–5。固定テスト話者の選択には使用しない |
| `assignment_version` | 設計・割当仕様の版 |
| `seed_algorithm_version` | seed/PRNG仕様の版 |
| `root_seed_hex` | 参加者固有256-bit seed。分析用に保護して扱う |
| `asset_version` | 刺激bundleの版 |

`test_talker_id`はaccentごとに1名へ固定され、参加者間・語間・時点間でrandomizeしません。このため、テストaccentと話者identityは完全に交絡します。この列を共変量としてモデルに足しても交絡は解消できず、推論対象は選定した3名の音声に限られます。

### ID入力と表示確認

以下はmigration `0006`のschema契約です。`0006`は2026-08-26に非本番D1へ適用済みで、現行の非本番deployにこのtableが存在します。

全員共通のPre入口では、参加者が研究用IDを1回入力し、次画面に表示された同じIDを確認します。`POST /api/participant-access/start`は`participant_id_confirmed=true`を必須とし、確認後にだけparticipant designとsessionを作成します。確認前離脱ではD1を変更しません。初回開始の競合やdesign保存後のsession失敗では既存designを正本として再利用し、条件を再抽選しません。

後続visitと再開も同じAPIを使い、数値ID、visit type、順序、5日gate、保存状態を検査します。`participant_name`、`participant_name_confirmed`、`name_action`は拒否します。学習時accentとseedは`numeric_id`だけから決まります。

### 練習trial

専用練習項目は、LearningのID 906 `apple`（りんご／🍎）、907 `orange`（オレンジ／🍊）、Picture NamingのID 901 `dog`、902 `chair`、L2-to-L1のID 903 `book`、904 `water`、905 `house`です。全練習trialは`practice=1`かつ`exclude_from_analysis=1`です。LearningとL2-to-L1の練習音声は、American Englishの`tts_us_bella`によるoffline生成済み固定WAVです。Learning練習は固定順で、planned manifestとruntime timingだけを残します。Picture Naming／L2-to-L1練習では本番と同じ発話収録をclient内で行い、timingとclient側QC metadataをtrial responseへ残しますが、Blobをoutboxへ入れず即時破棄します。したがって参加者の練習発話はIndexedDB、D1 `recordings`、R2、研究者ZIP、参加者ZIPのいずれにも存在せず、ZIP内の練習response行は`recording=null`です。これらのID・word、非nullの画像key・音声keyは、本番24語および他課題の練習poolと非重複です。

### L2-to-L1統制trial

ID 908–913の`strawberry`、`grape`、`pineapple`、`peach`、`kiwi`、`cherry`は、Learning phaseで学習しない簡単な統制項目です。ImmediateとDelayedに各1回入れ、`practice=0`、`exclude_from_analysis=1`、`expects_recording=1`、`list_id/list_rank/variability=NULL`、`trial_json.protocol.controlType="untrained_easy"`として保存します。No/Highの主要24語とは別に検索でき、各時点30問の行動応答と6 WAVを構成します。除外flagは参加者向けmanifestには出しません。

明示操作なしのtab・browser closeは`participation_interruptions`へ推測記録せず、visitも`completed`や`withdrawn`へ変更しません。最後にserverが受理したcanonical trialまでの未完了状態として、session・trial・visit funnelに残ります。terminateの`requested`状態で閉じた場合だけは、同じvisitの共通入口で再認証したsessionから同じrequestをfinalizeできます。`requested_session_uuid`は要求を最初に受理したsessionの監査情報であり、再認証sessionへ書き換えません。

## 4. 試行応答

全taskにserver開始・受信時刻、クライアントの`performance.now()`、`performance.timeOrigin`、AudioContext clockの対応を保存します。responseはtask別、eventはtype別のfield allowlistで厳密に検証し、未知field、必須field欠落、非finite値、短すぎるserver elapsedをHTTP 422で拒否します。したがって`participant_name`等を任意payloadへ追加してもD1・ZIPへ入りません。

### learning

- visual onset/deadline
- audio scheduled onset/end、実duration
- image、emoji、placeholderのどれか
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
- Web Audioの再生buffer末尾から10秒のresponse deadline（latency分析基準はQA済みの音響的語末）
- sample rate、sample count、analysis開始位置・sample数、QC

## 5. 録音

clientは本番録音について正規形44-byte headerのPCM mono 16-bit WAVを生成し、応答をcanonical化する前にRIFF長、sample rate、sample count、durationと応答metadataの一致を検査します。serverは最大4 MiB、正規形RIFF/WAVE chunk順、PCM、mono、16-bit、sample rate、data chunk、taskに応じたdurationを再検証します。さらにWAVから実測したsample rate/count/durationを受理済み応答と照合し、自己申告SHA-256と実bytesのSHA-256も照合します。RMS、peak、clipping ratioはPCM本体からserver側でも再計算し、client値との不一致を拒否します。`expects_recording=1`である本番canonical attemptの録音だけをR2へ条件付きPUTし、server実測値をD1とR2 metadataへ保存します。練習trialは`expects_recording=0`で、発話収録後のBlobをclient内で破棄します。分析では`recordings`のserver算出QCを正本とし、応答JSON内のclient算出QCは検証・監査用とします。

保存対象録音はsession全体の長尺ファイルではなく、Picture Naming／L2-to-L1の本番trialにつき1個のWAVです。ただし、回答語だけへspeech-trimした派生ファイルではありません。Picture Namingは画像直前から10秒窓の終端まで、L2-to-L1はcue開始150 ms前からbuffer末尾後10秒までを含めます。発話開始前の文脈とlatency anchorを失わないためraw trial WAVを切り詰めず、派生 onset annotationを別表に保存します。期待保存数はPre 24、Immediate 54、Delayed 54、参加者1名あたり全132 WAVです。各visitで2/5/5件、全12件の練習発話はこの数に含めません。統制12件は練習ではないため含めます。

R2 key:

```text
recordings/{participant_uuid}/{visit_type}/{segment}/{trial_uuid}/{attempt_uuid}.wav
```

raw録音は声紋・発話内容を含み得るため、匿名化済みの表データより厳しいアクセス制御と保管期間を適用します。

ZIPは保存済みのcanonical responseをD1から、対応するWAVをR2から読み、圧縮なしでresponseへ直接streamします。派生ZIPをR2やD1へ保存しません。entry名は `recordings/{visit_type}/{segment}/recording_NNN.wav` とし、刺激語、訳語、accent、話者、内部UUIDを含めません。参加者版`responses.json`にも内部UUIDや条件labelを含めず、研究用数値参加者ID、試行順、応答payload、WAVのSHA-256等を記録します。研究者版は採点・正本照合のため、同じopaque WAV entryへ刺激、条件、trial/attempt ID、再提示flag、R2 key、server算出QCを対応づけます。研究者版だけに、割付・version・visit別manifest hashをまとめた`design.json`、D1の保存済み`item_assignments`を参加者×本番語の24行で出す`item_assignments.csv`、保存済みmanifestの全Learning計画行を出す`learning_trials.csv`を含めます。前者のCSVはList、No/High、No条件の固定学習話者、test accent、固定test話者を1語1行で対応づけます。`no_training_talker_id`はNo行のみ値を持ち、High行は空欄です。High語の各6曝露の話者は後者の`planned_talker_id`を正本とします。後者はplanned列とcanonical runtime timing列を分け、未実施runtimeは空欄、開始・中断・再提示はtotal/noncanonical attempt countで監査できます。raw root seed、氏名、participant UUID、R2 keyは`item_assignments.csv`へ含めません。

研究者版`responses.json`の`research.recording_storage.latency_reference`は、Picture Namingでは`picture_onset`、L2-to-L1では`test_audio_buffer_end`を示し、WAV内の秒位置を明示します。後者には`acoustic_offset_correction_required=true`を付け、buffer末尾を未検査の音響語末と誤認しないようにします。

これらはbrowser/software clock上の基準であり、光学的pixel onset、実ヘッドホン出力、マイク入力の外部loopback校正値ではありません。QA台帳で補正できるのはL2刺激buffer末尾と音響語末の差です。機材latencyを校正しないremote実施では、算出RTをhardware補正済みの絶対latencyと表現しません。

どちらのZIPにも氏名を含めません。参加者版filenameは`accentedness_p{numeric_id}_{visit_type}_{YYYYMMDD}.zip`（生成時刻を日本時間に換算した日付）、研究者版は`accentedness_p{numeric_id}_results.zip`です。

参加者APIは認証済みsessionのvisit完了後に利用でき、収録範囲はsessionのvisitまでに固定します（Pre: pre、Immediate: pre＋immediate、Delayed: 全3 visit）。query parameterでIDや範囲を拡張できません。対象visitすべてのcompleted・finalizedとcanonical応答／録音完全性を再検査します。Preは26回答・24 WAV、Immediateは累積231回答・78 WAV、Delayedは累積290回答・132 WAVです。研究者API `GET /api/admin/participants/{numeric_id}/results.zip` はADMIN_TOKENを要求し、canonical応答が0件でも`design.json`、24行の`item_assignments.csv`、全Learning計画CSVを返し、その時点で存在するcanonical応答と利用可能なWAVだけを併記します。参加者側は全量Blobの`Content-Length`一致を確認後に自動downloadを要求し、disk保存完了とはみなしません。研究者側は対応Chromeで選択済みfileへ直接streamし、書込closeと`Content-Length`一致を成功条件にします。

## 6. 中断・参加終了データ

`participation_interruptions`はclient生成の`request_uuid`で冪等化し、`requested_session_uuid`、`mode`、`state`、request/finalize/resume時刻、request時点の`accepted_trial_count`と`next_ordinal`を保存します。`mode=pause`は同じvisitの共通入口からの再開を許しますが、新session開始時に`state=resumed`へ変えるのはfinalize済みの`paused`だけです。未確定の`requested`は次trialを禁止したまま送信・finalizeへ戻します。回復不能な未送信があれば、同じUUIDの行を`pause/requested`から`terminate/requested`へだけCAS更新できます。`mode=terminate`はfinalize後に`state=terminated`となり、再開を許しません。

中断request後は新規trial startを禁止しますが、raceで先に開始済みだった現在trialのresponseと録音uploadはfinalize前に受け付けられます。通常UIも現在trialを終えてからrequestし、request後にoutboxをflushします。D1 triggerはrequestとtrial start、新session開始の競合を最終的に遮断します。

pauseはvisitのstatusや完了時刻を変更せず、canonical responseに対応する未upload録音が0件であることをserverがfinalize時に再検査してからsessionだけをcloseします。未upload録音があればrequestを`requested`のまま残してHTTP 409を返します。再開時のcanonical次位置は`trial_manifest.canonical_attempt_uuid`から再計算します。未受理の旧attemptを再提示した場合は`abandoned_at_ms`と`abandon_reason=superseded_on_resume`を記録し、新attemptを別行にします。

terminateは受理済みcanonical response、upload済みWAV、完了済みvisitを保持します。未受理attemptは非canonicalのまま`participant_terminated`でabandonedにし、canonical responseに対応する未upload録音も同じ理由でabandonedにします。参加者と未完了visitを`withdrawn`にし、active sessionと内部access recordを閉じます。終了処理はsegment完了、`behavioral_completed_at_ms`、`finalized_at_ms`を設定しません。

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

6つの分析用間隔はD1 view `analysis_intervals`を正本とします。`visits.first_started_at_ms`は共通入口からvisit sessionを開始した時刻、`visits.finalized_at_ms`は全応答・録音が揃ってvisitを確定した時刻であり、行動endpoint間隔には使いません。時刻源を直接混ぜず、保存されたanchorから同一clock内の差または明示的な変換を使います。受付上限を設けないことと時間を無視することは同義ではなく、実間隔を全例保持して条件別報告と、PI・共同研究者がリポジトリ外で結果確認前に固定した感度分析に用います。`target_deviation_ms`は`retention_interval_ms − 5日`と定数差なので、同じmodelへ両方を説明変数として入れません。またdelayed時期はpost-treatmentになり得るため、自動的な共変量調整を欠測・脱落biasの解決策とみなしません。

`target_at_ms`は保持間隔の下限を示す行動時刻です。Delayedの共通入口から開始するには、これに加えてImmediate visitが全応答・録音の保存確認を終えた`completed`状態であることを要求します。保存確認が遅れてもtargetを後ろへ再計算せず、実際の保持間隔をそのまま記録します。

## 8. 分析対象と除外候補

No/High Variabilityの主要解析は`practice=0 AND exclude_from_analysis=0`を対象にします。`practice=1`は分析から除外します。`practice=0 AND exclude_from_analysis=1`の果物6語は未学習統制として別集計できますが、No/Highの効果推定には入れません。以下は一律削除ではなく、PI・共同研究者がリポジトリ外で結果確認前に固定した規則と感度分析に使います。

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

現行アプリは発話を収集しますが、browser内VADや自動採点は行いません。cue bleed、咳、前置き、低振幅語頭をリアルタイム閾値で誤判定しないため、生WAVを保持したオフライン工程で半自動onset候補と人手確認を行います。研究チームは別工程で次を定義します。

- Picture Namingの正答、許容語形、言い直し、無応答。
- L2-to-L1の正答、日本語同義語、部分正答、無応答。
- 複数評定者、盲検化、評定者間一致、disagreement解消。
- acoustic onsetのsample index、無応答、cue bleed、anticipatory response、onset不確実性の判定法。
- L2-to-L1刺激ごとのQA済み`acoustic_word_offset_ms`と、buffer末尾との差の補正。

採点表には最低限 `attempt_uuid`、`trial_uuid`、`rater_id`、`score`、`decision_code`、`speech_onset_sample`、`reference_sample`、`latency_ms`、`onset_method`、`onset_qc`、`scoring_version` を持たせ、raw D1/R2を上書きしません。Picture Namingは画像onset、L2-to-L1はQA済み音響語末を`reference_sample`とします。負のlatencyを0へ丸めず、anticipatory／cue bleed候補としてflagします。
