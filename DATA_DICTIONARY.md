# データ辞書

## 1. 保存先

- D1: 条件割当、manifest、試行応答、時刻、QC、監査ログ
- R2 `RECORDINGS`: 参加者のWAV録音
- R2 `STIMULI`: 非公開の本番刺激
- R2 `EXPORTS`: phase単位で自動生成した非公開ZIP。D1へBLOBは保存しない

クライアントへは全試行の骨格manifestだけを渡し、語、訳、条件、話者、R2 keyは渡しません。刺激は現在の未回答試行を認可します。現在試行にserver-sideの開始記録ができた後だけ、通信待ちを試行間隔から分離するため同じsegment内の次の1試行も先読みできます。segment境界と2試行以上先は拒否します。

## 2. 主なD1 table

| table | 単位 | 主な用途 |
|---|---|---|
| `participants` | 参加者 | 数値ID、学習accent、24-cell、versions、root seed、割当JSON |
| `visits` | 参加者×visit | pre/immediate/delayed状態、目標時刻、各segment時刻、完了時刻 |
| `item_assignments` | 参加者×本番語 | variability、test accent、No話者、本番test話者 |
| `segments` | visit×課題 | 課題順、開始・完了 |
| `trial_manifest` | 試行 | 不変順序、刺激key、条件、practice、canonical attempt |
| `invitations` | 招待世代 | token hash、発行・redeem・revoke状態 |
| `sessions` | browser session | epoch、token hash、有効期限、supersede状態 |
| `trial_attempts` | 試行attempt | start/response key、応答JSON、再提示フラグ |
| `recordings` | canonical attempt | R2 key、SHA-256、CRC-32、bytes、WAV状態、実測sample rate/count/duration、server算出QC |
| `recording_exports` | visit×録音segment | source snapshot hash、Queue/lease状態、非公開ZIP key、bytes、download回数 |
| `recording_export_members` | ZIP×WAV | 固定されたattempt/trial、archive名、元R2 key、hash、bytes、practice |
| `recording_export_downloads` | 管理者download request | method、range、応答status、request時刻。ローカル保存成功とはみなさない |
| `events` | telemetry event | onset、visibility、audio、network等の時刻とpayload |
| `audit_log` | 管理・system操作 | 招待・完了などの監査証跡 |

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

## 4. 試行応答

全taskにserver開始・受信時刻、クライアントの`performance.now()`、`performance.timeOrigin`、AudioContext clockの対応を保存します。task別payloadは厳密に検証し、未知の必須欠落、非finite値、短すぎるserver elapsedを拒否します。

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

各phase（pre PN、immediate PN、immediate L2、delayed PN、delayed L2）の全WAVが揃うと、Queue consumerがWAVを1本ずつ読み、圧縮なしZIPを`EXPORTS`へstreaming PUTします。ZIPには`manifest.json`と練習を含む全WAVを入れます。manifestはattempt/trial ID、practice、archive名、SHA-256、bytes、upload時刻を含みます。元WAVとZIP全体をWorker memoryへ展開しません。ZIP生成はat-least-once delivery、lease、immutable R2 key、source snapshot hashにより冪等化します。

ZIP downloadは管理者APIだけが許可され、Range/conditional requestをprivate R2へ渡します。参加者端末へはdownloadしません。download auditは「応答streamを開始した」記録であり、研究者端末への保存完了を保証しません。

## 6. 時刻の定義

| 時刻 | 基準 |
|---|---|
| `server_*_at_ms` | WorkerのUnix epoch ms |
| `client_*_perf_ms` | そのpage lifecycle内のmonotonic clock |
| `performance_time_origin_ms` | performance clockとepochの対応 |
| `*_context_s` | AudioContext clock |
| `target_at_ms` | immediate behavioral completion＋7日 |
| delayed実施開始 | delayedの最初のPicture Naming trialのserver開始 |
| pre→学習間隔 | immediate `first_started_at_ms` − pre `finalized_at_ms` |

時刻源を直接混ぜず、保存されたanchorから同一clock内の差または明示的な変換を使います。

## 7. 分析対象と除外候補

`practice=1` または `exclude_from_analysis=1` は本分析から除外します。以下は一律削除ではなく、事前登録した規則と感度分析に使います。

- `repeated_after_interruption`
- `extra_exposure`
- `missing_input_frames`
- low RMS / high clipping ratio
- missing or invalid recording
- visibility中断
- timing deviation
- delayed targetからの偏差
- asset/assignment version差

canonical responseとcanonical recordingを結合し、orphan attemptや非canonical uploadを分析表へ混ぜません。
構造不良、metadata不一致、ローカル欠損でupload不能な録音は自動で欠測完了にしません。元Blobと`recordings.state=pending`を保持して課題を停止し、担当者が原因を確認します。ネットワーク由来の一時エラーだけを再送します。

## 8. 採点データ

現行アプリは発話を収集しますが、自動採点は行いません。研究チームは別工程で次を定義します。

- Picture Namingの正答、許容語形、言い直し、無応答。
- L2-to-L1の正答、日本語同義語、部分正答、無応答。
- 複数評定者、盲検化、評定者間一致、disagreement解消。
- latencyを分析する場合のacoustic onset測定法。

採点表には最低限 `attempt_uuid`、`trial_uuid`、`rater_id`、`score`、`decision_code`、`scoring_version` を持たせ、raw D1/R2を上書きしません。
