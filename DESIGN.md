# 実験設計とランダマイゼーション仕様

## 1. 研究デザイン

対象は日本語母語の英語学習者です。

| 要因 | 水準 | デザイン |
|---|---|---|
| 学習時アクセント | American English / Mandarin-accented English / Japanese-accented English | between-participant |
| 学習時話者変動性 | No Variability / High Variability | within-participant |
| Picture Naming時点 | pre / 学習直後（実間隔を記録） / Immediate最終行動応答＋5日を目標（以後も受付） | within-participant |
| L2-to-L1時点 | 学習直後（実間隔を記録） / Immediate最終行動応答＋5日を目標（以後も受付） | within-participant |
| L2-to-L1テスト音声アクセント | English / Chinese / Japanese | within-participant |

Picture Matching は行いません。preではPicture Namingだけを行い、L2-to-L1は行いません。直後・遅延のテスト順はPicture Naming、L2-to-L1で固定します。課題順を固定する理由は、L2-to-L1で正答語を聞くことがPicture Namingを促進するテスト効果を避けるためです。

## 2. 参加者ID、氏名入力の継続照合、学習時アクセント

正の10進整数だけを参加者IDとして受け付けます。先頭ゼロ、文字列ラベル、0、負数、小数、JavaScriptの安全整数範囲外は拒否します。

| `participant_id % 3` | 学習時アクセント | 内部値 |
|---:|---|---|
| 1 | American English | `english` |
| 2 | Mandarin-accented English | `chinese` |
| 0 | Japanese-accented English | `japanese` |

同じIDを再登録しても、新しい条件やmanifestは生成されません。既存の不変manifestを再利用します。

管理者は数値IDだけを入力して参加者を作成・参照し、氏名を転記しません。参加者はPre招待の初回redeem時にIDと氏名を入力します。serverは氏名をNFKC正規化し、Unicode空白を1個へ畳んで前後を除き、Roman textを小文字化します。制御文字・改行・bidi制御文字、80 Unicode code point超、256 UTF-8 byte超は拒否します。

正規化済み氏名は、専用の`IDENTITY_SECRET`をkeyとして、participant UUID、数値ID、正規化版、verifier版を含むdomain-separated HMAC-SHA-256へ変換します。初回binding、visit開始、session作成、招待redeem、auditは同じD1 batchで原子的に確定します。D1に保存するのはHMACとversion、確認回数・時刻だけで、平文氏名はD1、R2、API応答、log、browser storage、ZIPへ残しません。trial responseとtelemetry eventはtask/type別のfield allowlist以外をserverで拒否します。後続redeemで正規化後に同じ氏名なら確認回数を増やし、別氏名ならHTTP 409として既存HMACを上書きしません。

初回アクセスの認可は、手動配布されたraw招待tokenと招待に一致する数値IDが担います。初回氏名は募集台帳との照合済み本人情報ではなく、その後のImmediate・Delayedで同じ入力を要求する継続確認情報です。ID不一致・氏名欠落・競合は汎用エラーとなり、binding、visit、session、招待redeem回数、確認回数、監査logを一切変更しません。binding後の氏名不一致も同じく無変更です。redeem後の同じsession内では平文氏名を保持せず、session tokenだけを使います。bindingのない既存参加者も、次の有効な招待を最初に正常redeemした時点でbindingします。参加終了・離脱後もIDは再利用しません。

学習時アクセント、24-cell、manifest seedは引き続き数値IDだけから決まり、氏名やHMACは割付へ影響しません。`IDENTITY_SECRET`は`RANDOMIZATION_SECRET`や`ADMIN_TOKEN`と分離し、既存bindingを照合する全期間で固定します。

## 3. 語、専用練習刺激、変動性

24語を12語ずつのList 1 / List 2に分けます。各アクセント内で24セルの割当表を回し、どちらのリストがNo/Highになるかを反転します。

- No Variability: 12語。参加者内では1名の学習話者を固定し、各語6回。
- High Variability: 12語。6名の学習話者を各語に1回ずつ、計6回。
- 各学習cycleでは全24語を1回ずつ提示。
- High条件では各cycleに各話者が2語ずつ担当。
- High条件内および連結するHigh blockの境界で同一話者を連続させない。
- 各語6回の総学習試行数は144。

練習では本番24語を一切使いません。固定する練習項目は次の5語です。

| task | ID | word | gloss | asset |
|---|---:|---|---|---|
| Picture Naming | 901 | abacus | そろばん | 専用画像、音声なし |
| Picture Naming | 902 | binoculars | 双眼鏡 | 専用画像、音声なし |
| L2-to-L1 | 903 | thermometer | 温度計 | 専用練習音声、画像なし |
| L2-to-L1 | 904 | xylophone | 木琴 | 専用練習音声、画像なし |
| L2-to-L1 | 905 | detergent | 洗剤 | 専用練習音声、画像なし |

ID、word、非nullのimage key・audio keyはいずれも本番項目と非重複にし、Picture Naming練習とL2-to-L1練習の語も互いに重複させません。L2-to-L1練習音声は`practice`専用keyを使います。全練習trialは`practice=1`かつ`exclude_from_analysis=1`で、本分析に含めません。この分離はmanifest生成後のinvariant checkerでも検査します。

学習は各cycle内で12語の条件blockを2つ提示し、24試行ごとに参加者制御の休憩を入れます。block順をcycleごとに反転するため、ラベル列だけを連結すると同条件が最大24になりますが、その境界には必ず休憩があります。休憩をまたがない連続提示は最大12語です。この選択は、各条件をcycle内の前半・後半に同数配置するための意図的なトレードオフです。

## 4. 学習試行の時系列

1. 画像を表示する。
2. 画像onsetから750 ms後に学習音声を開始する。
3. 画像はonsetから5,000 msで消す。
4. 画像消失または応答窓終了から次onsetまで、650 msを最小目標間隔とする。

750 msと5秒は Barcroft and Sommers (2005) の手順を踏襲します。650 msは本実装で追加した値で、同論文からの引用値ではありません。絶対時計で次onsetの最早時刻を決め、応答確定後の録音uploadはバックグラウンドで行います。ただし、応答のserver受理や次刺激読込が650 msを超えた場合に試行順を破って開始はしません。実onsetの超過を`onset_late_ms`と`trial_onset_late`に記録します。画像は事前decodeし、実paintに最も近いanimation frame時刻を記録します。音声はWeb Audio clockで予約し、ネットワーク保存は5秒・10秒の提示deadlineを延長しません。

## 5. Picture Naming

pre・直後・遅延の各時点で練習2試行、本番24試行です。

練習2試行はID 901（abacus）と902（binoculars）の専用画像です。3時点とも同じ2項目を使いますが、本番24語のword・imageとは重複しません。

- 音声captureは画像onset直前にarmし、冒頭欠落を防ぐ。採点・QCの分析窓は画像onsetから開始。
- 応答窓は10秒。
- No 12語、High 12語。
- 12組のNo/Highペアを作り、No-first 6組、High-first 6組。
- 条件連続は最大2。
- pre・直後・遅延では別domain seedを使い、3順序の完全同一をpairwiseに明示的に拒否。

preでは正答語、英語音声、綴り、正誤feedbackを提示しません。それでも、同じ24画像を見て英語語彙を検索・発話しようとする行為は画像馴化とpretesting/retrieval-attempt効果を導入します。このため、主要推論の対象は「pre Picture Namingを受けた学習者」に限られ、preなしの学習へ直接一般化できません。pre完了から学習開始までの実施上の上限・下限は設けず、間隔だけを理由に受付拒否や自動除外をしません。実間隔の分布とpre後離脱は条件別に報告し、主要解析での扱いと感度分析はPI・共同研究者がリポジトリ外の解析計画で結果確認前に固定します。参加者IDはpre後の離脱があっても再利用しません。pre→学習間隔の正本は、pre Picture Naming最終試行の行動応答受理時刻からimmediate学習最初の試行開始時刻までとします。招待linkのredeem時刻や、録音upload完了後のvisit確定時刻はこの間隔に用いません。

## 6. L2-to-L1

各時点で練習3試行、本番24試行です。

練習3試行はID 903（thermometer）、904（xylophone）、905（detergent）の専用音声です。English / Chinese / Japaneseを1試行ずつ含み、本番24語のword・audioとは重複しません。語とaccentの対応はparticipant seedで変わるため、asset inventoryには3語×3 accentsの9 WAVを用意します。

- 録音は音声開始150 ms前から開始。
- 音声offset後に10秒の応答窓。
- English / Chinese / Japaneseを各8語。
- 各アクセント内でNo 4語、High 4語。
- 6 strata（2 variability×3 accents）を1つずつ含む6試行miniblockを4つ作る。
- variabilityとaccentの連続はいずれも、練習を含む実際の聴取系列全体で最大2。
- 直後と遅延では語→アクセント→話者の写像を固定し、提示順だけを独立化。

L2-to-L1音声は各アクセント1名の固定女性話者、計3名を練習・本番で使います。同じ語に対する話者は直後と遅延で変えません。現行R2 keyはtimepointを含まないため、同じ語には直後・遅延で同一WAV tokenを再提示します。同一話者の別takeを使う場合は、刺激確定前にtimepointをkeyとasset inventoryへ追加し、反復効果とtoken差のどちらを統制するかをPI・共同研究者がリポジトリ外の解析計画で決定します。

この仕様では、テスト音声のアクセントと話者個人のidentityが完全に交絡します。したがって、L2-to-L1におけるアクセント差を話者母集団へ一般化できず、観測差はaccentではなく特定話者の声質・明瞭度・速度等で生じた可能性を分離できません。これはrandomizationや統計モデルでは解消できない識別上の制約です。確認的推論の範囲を「選定した3名の音声」に限定し、この制約と変更後の`ASSIGNMENT_VERSION`を研究報告で明記します。

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

募集人数が72または144の場合、「完全カウンターバランス」と記述せず、周辺均衡であることを研究報告で明記します。脱落がIDや条件に偏ると実現標本の均衡は崩れるため、割当数と完了数を別々に報告します。

## 9. pre・直後・遅延

pre visitは次の順です。

```text
PN練習2 → PN本番24
```

合計26試行、録音26件です。pre完了後に担当者がimmediate用の別招待を手動発行します。preの完了時刻が古いことを理由に発行・開始を拒否せず、pre完了→learning開始の上限・下限は設けません。

直後visitは次の順です。

```text
学習144 → PN練習2 → PN本番24 → L2練習3 → L2本番24
```

合計197試行、録音53件です。

遅延visitは次の順です。

```text
PN練習2 → PN本番24 → L2練習3 → L2本番24
```

合計53試行、録音53件です。遅延目標はImmediate最終L2-to-L1試行の行動応答をserverが受理した時刻＋5日です。この5日はdelayed操作を保つ開始下限です。開始にはImmediateの全応答・録音の保存確定も必要ですが、その確定時刻から5日を再計算しません。両条件を満たした後は期限切れにしません。実際の保持間隔は、直後L2-to-L1最終試行の行動応答受理時刻から遅延Picture Naming最初の試行開始時刻までとします。目標偏差は、遅延Picture Naming最初の試行開始時刻から保存済み目標時刻を引きます。リンクredeem時刻、録音upload時刻、visit確定時刻、後から変更されたdelay設定値からの逆算は用いません。これらの正本値はD1 view `analysis_intervals`から取得します。

6つのparticipant URLを用意しますが、token/sessionの境界はpre、immediate、delayedの3 visitです。招待linkに経過時間による失効はありません。短期session tokenには認証上の有効期限がありますが、同じactiveな招待linkを開き直せば未完了位置から再開できるため、これは参加期限ではありません。immediate内とdelayed内では同じsession epochを引き継ぎます。次segmentの開始前に、前segmentの録音がすべてR2へ保存済みであることをserverが検査します。

Pre・直後で録音や回答を参加者へdownloadさせると、聞き返し・復習が遅延成績を汚染し得るため、参加者向けZIPは提示しません。Delayed L2-to-L1を含むvisitをserver側で完了確定した後だけ、3 visitすべてのcanonical回答とWAVを単一ZIPとして明示ボタンから提供します。download失敗で保存済みvisitを未完了へ戻しません。

## 10. 一時中断、参加終了、通常完了

「一時中断」「参加を終了する」「visit完了」は別の状態遷移です。管理者の招待revokeも、この参加者操作の代替にはしません。

- 試行中に中断ボタンを押した場合、通常UIはその1試行の応答受理まで待ってからinterruptionをrequestし、新しい試行へは進みません。request後は送信待ち録音をflushしてからfinalizeします。
- requestと試行開始が競合した場合、先に開始済みの1試行だけは応答・録音をdrainできます。requestが先なら次のtrial startをAPIとD1 triggerの両方が拒否します。openなinterruption中はvisit完了、招待発行、管理者revokeも拒否します。
- 一時中断では参加者とvisitを完了・withdraw扱いにせず、現在sessionだけを閉じ、同じactive招待を保持します。finalize時にもserverがcanonical responseに対応する録音待ち0件を再検査し、1件でも残れば`requested`のまま拒否します。同じ招待linkへID・氏名を再入力すると新sessionとなり、serverが受理したcanonical trialの直後から再開します。
- pause requestのfinalize前にtabを失った場合、再認証しても`requested`を自動で`resumed`へ変えず、次trialを禁止したまま送信とpause確定を続行します。pauseが`paused`まで確定した後の再認証だけを明示的な再開として`resumed`にします。
- 回復不能な回答・録音エラーで安全な再開を保証できない場合、pauseを完了扱いにはしません。pause要求後なら、参加者は未確定の確認コードを残すか、同じrequest UUID・interruption UUIDを保持した一方向の`pause/requested`→`terminate/requested`切替を明示的に選びます。再訪時のoutbox照合で初めて判明した場合も新trialを始めず、新しいterminate requestによるserver受理済み範囲での参加終了か担当者連絡だけを提示します。逆方向やfinalize済み状態の変更は拒否します。
- pause時に開始済みだが未受理だったattemptを再提示する場合、旧attemptと録音slotは`superseded_on_resume`でabandoned・非canonicalにし、新attemptへ`repeated_after_interruption=1`を付けます。学習なら追加曝露として`extra_exposure=1`も付けます。
- 永続的な参加終了では、受理済みcanonical responseとupload済みR2 WAVを削除・上書きしません。未受理attemptは非canonicalのabandoned、canonical responseに対応する未upload録音は`participant_terminated`のabandonedとして区別します。完了済みvisitはそのまま保持し、未完了visitだけを`withdrawn`にします。
- 参加終了は`behavioral_completed_at_ms`、segment完了時刻、`finalized_at_ms`を新規設定しません。部分データを通常完了に見せず、active sessionと招待を閉じ、以後の再開を拒否します。
- terminate requestがserverへ届いた後、finalize前にtabを閉じても要求を失いません。同じactive招待linkでID・氏名を再確認すると、試行開始を禁止したまま新sessionで送信待ちを再送し、同じrequest UUIDの終了確定だけを続行できます。要求を出した旧session UUIDは監査用に保持し、finalize権限は同じparticipant・visitへ再認証されたsessionに限定します。
- 明示操作なしにtabやbrowserを閉じた場合は、通常完了・一時中断・参加終了のどれにも自動変換しません。server受理済み位置までの未完了visitとして残し、同じactive招待linkから再開します。

interruption request/finalizeはrequest UUIDで冪等化し、D1の一意indexとtriggerをrace-conditionのbackstopにします。監査では`requested`、`paused`、`resumed`、`terminated`を通常のbehavioral completion・finalizationと別に数えます。

## 11. 分析前の重要フラグ

次の試行・参加者は自動削除せず、PI・共同研究者がリポジトリ外で結果確認前に固定した規則に従って感度分析します。

- `repeated_after_interruption=1`: onset後のreload等で同じ試行を再提示。
- `extra_exposure=1`: 学習で追加曝露が生じた可能性。
- `abandoned_at_ms` / `abandon_reason`: 再開でsupersedeされた未完了attempt、または参加終了時に残った未送信録音。
- `missing_input_frames>0`: 録音workletで入力欠落。
- RMSが低い、clipping ratioが高い、録音が欠損。
- visibility change、audio timing deviation、ネットワーク再送。
- pre完了→学習開始、学習完了→直後PN開始、PN完了→L2開始の間隔。間隔だけを理由に自動除外しない。
- 遅延間隔の目標からの偏差。

受付を無期限にしても、数週・数か月後の測定を一律に「5日後」と解釈できるわけではありません。全観測を保持した上で実間隔の分布を報告し、5日付近を対象とするestimand、連続時間として扱うmodel、感度分析のどれを主要とするかを結果を見る前に固定します。特にdelayed実施時期は、条件や直後成績、継続意思の影響を受け得るpost-treatment変数です。機械的な共変量調整で脱落・選択biasが解消すると仮定しません。

効果の方向、除外閾値、主要モデル、欠測処理はPI・共同研究者がリポジトリ外で結果確認前に固定します。これは実験プログラムの技術ゲートではありません。
