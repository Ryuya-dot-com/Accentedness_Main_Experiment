# 実験設計とランダマイゼーション仕様

## 1. 研究デザイン

対象は日本語母語の英語学習者です。

| 要因 | 水準 | デザイン |
|---|---|---|
| 学習時アクセント | American English / Mandarin-accented English / Japanese-accented English | between-participant |
| 学習時話者変動性 | No Variability / High Variability | within-participant |
| Picture Naming時点 | pre / 直後 / 約7日後 | within-participant |
| L2-to-L1時点 | 直後 / 約7日後 | within-participant |
| L2-to-L1テスト音声アクセント | English / Chinese / Japanese | within-participant |

Picture Matching は行いません。preではPicture Namingだけを行い、L2-to-L1は行いません。直後・遅延のテスト順はPicture Naming、L2-to-L1で固定します。課題順を固定する理由は、L2-to-L1で正答語を聞くことがPicture Namingを促進するテスト効果を避けるためです。

## 2. 参加者IDによる学習時アクセント

正の10進整数だけを参加者IDとして受け付けます。先頭ゼロ、文字列ラベル、0、負数、小数、JavaScriptの安全整数範囲外は拒否します。

| `participant_id % 3` | 学習時アクセント | 内部値 |
|---:|---|---|
| 1 | American English | `english` |
| 2 | Mandarin-accented English | `chinese` |
| 0 | Japanese-accented English | `japanese` |

同じIDを再登録しても、新しい条件やmanifestは生成されません。既存の不変manifestを再利用します。

## 3. 語と変動性

24語を12語ずつのList 1 / List 2に分けます。各アクセント内で24セルの割当表を回し、どちらのリストがNo/Highになるかを反転します。

- No Variability: 12語。参加者内では1名の学習話者を固定し、各語6回。
- High Variability: 12語。6名の学習話者を各語に1回ずつ、計6回。
- 各学習cycleでは全24語を1回ずつ提示。
- High条件では各cycleに各話者が2語ずつ担当。
- High条件内および連結するHigh blockの境界で同一話者を連続させない。
- 各語6回の総学習試行数は144。

学習は各cycle内で12語の条件blockを2つ提示し、24試行ごとに参加者制御の休憩を入れます。block順をcycleごとに反転するため、ラベル列だけを連結すると同条件が最大24になりますが、その境界には必ず休憩があります。休憩をまたがない連続提示は最大12語です。この選択は、各条件をcycle内の前半・後半に同数配置するための意図的なトレードオフです。

## 4. 学習試行の時系列

1. 画像を表示する。
2. 画像onsetから750 ms後に学習音声を開始する。
3. 画像はonsetから5,000 msで消す。
4. 画像消失または応答窓終了から次onsetまで、650 msを最小目標間隔とする。

750 msと5秒は Barcroft and Sommers (2005) の手順を踏襲します。650 msは本実装で追加した値で、同論文からの引用値ではありません。絶対時計で次onsetの最早時刻を決め、応答確定後の録音uploadはバックグラウンドで行います。ただし、応答のserver受理や次刺激読込が650 msを超えた場合に試行順を破って開始はしません。実onsetの超過を`onset_late_ms`と`trial_onset_late`に記録します。画像は事前decodeし、実paintに最も近いanimation frame時刻を記録します。音声はWeb Audio clockで予約し、ネットワーク保存は5秒・10秒の提示deadlineを延長しません。

## 5. Picture Naming

pre・直後・遅延の各時点で練習2試行、本番24試行です。

- 音声captureは画像onset直前にarmし、冒頭欠落を防ぐ。採点・QCの分析窓は画像onsetから開始。
- 応答窓は10秒。
- No 12語、High 12語。
- 12組のNo/Highペアを作り、No-first 6組、High-first 6組。
- 条件連続は最大2。
- pre・直後・遅延では別domain seedを使い、3順序の完全同一をpairwiseに明示的に拒否。

preでは正答語、英語音声、綴り、正誤feedbackを提示しません。それでも、同じ24画像を見て英語語彙を検索・発話しようとする行為は画像馴化とpretesting/retrieval-attempt効果を導入します。このため、主要推論の対象は「pre Picture Namingを受けた学習者」に限られ、preなしの学習へ直接一般化できません。pre完了から学習開始までの間隔とpre後離脱を条件別に報告し、許容間隔を事前登録します。参加者IDはpre後の離脱があっても再利用しません。pre→学習間隔の正本は、pre Picture Naming最終試行の行動応答受理時刻からimmediate学習最初の試行開始時刻までとします。招待linkのredeem時刻や、録音upload完了後のvisit確定時刻はこの間隔に用いません。

## 6. L2-to-L1

各時点で練習3試行、本番24試行です。

- 録音は音声開始150 ms前から開始。
- 音声offset後に10秒の応答窓。
- English / Chinese / Japaneseを各8語。
- 各アクセント内でNo 4語、High 4語。
- 6 strata（2 variability×3 accents）を1つずつ含む6試行miniblockを4つ作る。
- variabilityとaccentの連続はいずれも、練習を含む実際の聴取系列全体で最大2。
- 直後と遅延では語→アクセント→話者の写像を固定し、提示順だけを独立化。

L2-to-L1音声は各アクセント1名の固定女性話者、計3名を練習・本番で使います。同じ語に対する話者は直後と遅延で変えません。現行R2 keyはtimepointを含まないため、同じ語には直後・遅延で同一WAV tokenを再提示します。同一話者の別takeを使う場合は、刺激確定前にtimepointをkeyとasset inventoryへ追加し、反復効果とtoken差のどちらを統制するか事前登録します。

この仕様では、テスト音声のアクセントと話者個人のidentityが完全に交絡します。したがって、L2-to-L1におけるアクセント差を話者母集団へ一般化できず、観測差はaccentではなく特定話者の声質・明瞭度・速度等で生じた可能性を分離できません。これはrandomizationや統計モデルでは解消できない識別上の制約です。確認的推論の範囲を「選定した3名の音声」に限定し、この制約と変更後の`ASSIGNMENT_VERSION`を事前登録に明記します。

## 7. Seedと再現性

root seedはサーバーだけが保持する秘密値をkeyとするHMAC-SHA-256で作ります。

```text
root_seed = HMAC-SHA-256(
  RANDOMIZATION_SECRET,
  SEED_ALGORITHM_VERSION ␟ ASSIGNMENT_VERSION ␟ participant_id
)
```

root seedから、`learning/...`、`picture_naming/pre/...`、`picture_naming/immediate/...`、`picture_naming/delayed/...`、`l2_to_l1/immediate/...`、`l2_to_l1/delayed/...` のような用途別domainを再度HMACし、xoshiro128**を初期化します。整数抽選はrejection samplingを用い、剰余バイアスを避けます。

重要な性質は次のとおりです。

- 同じsecret、version、IDなら同じ割当を再現できる。
- 学習、課題、時点の乱数消費が互いに影響しない。
- `SEED_ALGORITHM_VERSION` または `ASSIGNMENT_VERSION` を変えるとroot seedが変わる。
- 作成後のmanifest、hash、root seed、versionをD1に保存し、途中で再生成しない。
- secret自体はD1、クライアント、ログへ出さない。

生成後のmanifestは再利用可能なinvariant checkerで検査します。学習・各テストの試行数、録音数、High話者頻度、Picture NamingのNo/High pair orientation、L2 miniblockの6 strata、直後・遅延の語→accent→話者→WAV写像を契約として扱います。監査scriptはID 1–2160を独立した2つのrandomization secretで生成し、計4,320 designを検査します。同じserial positionの一致数は報告指標であり、恣意的に順序を再抽選する制約にはしません。

`RANDOMIZATION_SECRET` を変更しても既存参加者のmanifestは変わりません。ただし、同一assignment version中にsecretを変更すると、新規参加者だけ別の乱数系列になります。収集中は固定し、変更時はassignment versionを上げて運用記録に残します。

## 8. カウンターバランス周期

学習時アクセントの周期は3名です。各アクセント内では、リスト反転2×block開始順2×No話者6の24セルを回すため、全体72名で主要な周辺度数が一巡します。

ただし、固定語について `variability×No学習話者×test accent` の完全交差が一巡するのは全体216名です。

- N=72: アクセント、リスト、順序、No話者、テストアクセントの周辺度数は均衡。ただし固定語の一部の結合セルは空。
- N=144: 固定語の空セルは解消するが、結合セルは1:2で不均衡。
- N=216: 対象となる結合セルが完全均衡。

募集人数が72または144の場合、「完全カウンターバランス」と記述せず、周辺均衡であることを事前登録します。脱落がIDや条件に偏ると実現標本の均衡は崩れるため、割当数と完了数を別々に報告します。

## 9. pre・直後・遅延

pre visitは次の順です。

```text
PN練習2 → PN本番24
```

合計26試行、録音26件です。pre完了後に担当者がimmediate用の別招待を手動発行します。

直後visitは次の順です。

```text
学習144 → PN練習2 → PN本番24 → L2練習3 → L2本番24
```

合計197試行、録音53件です。

遅延visitは次の順です。

```text
PN練習2 → PN本番24 → L2練習3 → L2本番24
```

合計53試行、録音53件です。遅延目標は直後の行動課題完了時刻＋7日です。目標時刻以後は常に受付可能で、期限切れにしません。実際の保持間隔は、直後L2-to-L1最終試行の行動応答受理時刻から遅延Picture Naming最初の試行開始時刻までとします。目標偏差は、遅延Picture Naming最初の試行開始時刻から保存済み目標時刻を引きます。リンクredeem時刻、録音upload時刻、visit確定時刻、後から変更されたdelay設定値からの逆算は用いません。これらの正本値はD1 view `analysis_intervals`から取得します。

6つのparticipant URLを用意しますが、token/sessionの境界はpre、immediate、delayedの3 visitです。immediate内とdelayed内では同じsession epochを引き継ぎます。次segmentの開始前に、前segmentの録音がすべてR2へ保存済みであることをserverが検査します。

## 10. 分析前の重要フラグ

次の試行・参加者は自動削除せず、事前登録した規則に従って感度分析します。

- `repeated_after_interruption=1`: onset後のreload等で同じ試行を再提示。
- `extra_exposure=1`: 学習で追加曝露が生じた可能性。
- `missing_input_frames>0`: 録音workletで入力欠落。
- RMSが低い、clipping ratioが高い、録音が欠損。
- visibility change、audio timing deviation、ネットワーク再送。
- pre完了→学習開始、学習完了→直後PN開始、PN完了→L2開始の間隔。
- 遅延間隔の目標からの偏差。

効果の方向、除外閾値、主要モデル、欠測処理は結果を見ずに事前登録してください。
