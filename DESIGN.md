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

## 2. 参加者IDの確認と学習時アクセント

通常参加者IDは、JavaScriptの安全整数範囲内にある、先頭ゼロのない正の10進整数だけを受け付けます。`01`、`P01`、`sub01`、0、負数、小数は拒否し、文字列中の数字だけを抽出しません。非本番では通常参加者の入口を`ALLOW_DEVELOPMENT_PARTICIPANTS=false`で既定拒否し、承認済みの永続保存pilotでだけ明示的に有効化します。正確な`999`は開発環境の非保存testモードに予約し、通常参加者IDとしては拒否します。ID `999`は永続manifestを作らず、既存の管理Bearer認証後だけ`RESEARCHER_TEST_ASSET_VERSION`の実刺激をprivate R2から読みます。回答・録音はD1、`RECORDINGS`、browser storageへ保存せず、productionのtest APIは認証前に404とします。

| `participant_id % 3` | 学習時アクセント | 内部値 |
|---:|---|---|
| 1 | American English | `english` |
| 2 | Mandarin-accented English | `chinese` |
| 0 | Japanese-accented English | `japanese` |

同じIDで再アクセスしても、新しい条件やmanifestは生成されません。既存の不変manifestを再利用します。

管理画面は参加者を先に作成せず、数値IDによる保存状態の参照だけを行います。参加者は全員共通のPre入口でIDを1回入力し、確認画面に表示された同じIDを確認します。`POST /api/participant-access/start`は`participant_id_confirmed=true`を必須とし、確認後にだけ参加者、3 visit分の割付・manifest、最初のsessionを作成します。確認前の離脱ではD1を変更しません。後続visitと再開も同じID入力・表示確認を使い、保存済みmanifestとcanonical位置を再利用します。

氏名は参加者画面、管理画面、API、D1、R2、browser storage、監査、ZIPのいずれにも収集・表示・保存しません。`participant_name`、`participant_name_confirmed`、`name_action`を開始APIへ送るとHTTP 422で拒否します。旧migration由来の`participant_names` tableは非破壊のschema互換性のため残しますが、runtimeは読み書きせず0行を維持します。trial responseとtelemetry eventもtask/type別のfield allowlist以外を拒否します。

同じIDの初回開始が競合しても、先に保存された不変manifestを正本として再利用し、参加者・visit・manifestを二重作成しません。参加者designの保存後にsession開始が一時失敗した場合も、再試行で保存済みdesignを再利用して条件を再抽選しません。IDは秘密情報や本人認証要素ではありません。参加終了・離脱後もIDは再利用しません。

学習時アクセント、24-cell、manifest seedは数値IDだけから決まります。healthとproduction gateが要求するsecretは独立した`ADMIN_TOKEN`と`RANDOMIZATION_SECRET`だけです。旧`participant_names` tableを追加したmigration `0006`は適用済みのため削除せず、未使用のまま保持します。

## 3. 語、話者、専用練習刺激、変動性

24語を12語ずつのList 1 / List 2に分けます。各アクセント内で24セルの割当表を回し、どちらのリストがNo/Highになるかを反転します。

| List A | List B |
|---|---|
| tweezers | razor |
| scapula | podium |
| cocoon | protractor |
| lotus | acorn |
| xylophone | scalpel |
| porcupine | casket |
| carousel | detergent |
| spatula | nostril |
| syringe | binoculars |
| catapult | raccoon |
| wardrobe | parakeet |
| abacus | toupee |

- No Variability: 12語。参加者内では1名の学習話者を固定し、各語6回。
- High Variability: 12語。6名の学習話者を各語に1回ずつ、計6回。
- No-first / High-firstを参加者間で均衡させ、6回の各24語反復で同じ条件順にNo/High各12語を提示する。
- 各条件の12語は参加者ごとに一度だけseed付きでシャッフルし、その語順を6反復すべてで固定する。
- High条件では、各語について6話者をseed付きで無作為・非復元抽出し、6反復へ1名ずつ割り当てる。反復内の話者頻度や隣接話者には追加制約を置かない。
- 各語6回の総学習試行数は144。

学習話者は次の順序で固定します。この配列順は`talker_cell`の割付に使います。従来の「各accentで男女3名ずつ」という要件は適用しません。

| 学習accent | 話者roster | 実音声とsource talker labelを照合した声種構成 |
|---|---|---|
| English | `E1_Audio`, `E4_Audio`, `E7_Audio`, `E12_Audio`, `E13_Audio`, `E14_Audio` | 男性声3・女性声3 |
| Japanese | `J6_Natural`, `J8_Natural`, `J4_Natural`, `J12_Natural`, `J10_Natural`, `J15_Natural` | 女性声5・男性声1 |
| Chinese | `C2_Natural`, `C5_Natural`, `C7_Natural`, `C15_Natural`, `C16_Natural`, `C18_Natural` | 女性声3・男性声3 |

テスト話者はEnglish=`E6_Audio`（女性声）、Japanese=`J5_Natural`（男性声）、Chinese=`C11_Natural`（男性声）の3名です。`E6_Audio`はEnglishのテスト専用で、Learningには使用しません。性別は割付・解析因子にはせず、各accentで指定された固定音声を正本とします。

練習では本番24語を一切使いません。固定する練習項目は次の7語です。

| task | ID | word | gloss | asset |
|---|---:|---|---|---|
| Learning | 906 | apple | りんご | 🍎、American English固定TTS |
| Learning | 907 | orange | オレンジ | 🍊、American English固定TTS |
| Picture Naming | 901 | dog | 犬 | 専用画像、音声なし |
| Picture Naming | 902 | chair | 椅子 | 専用画像、音声なし |
| L2-to-L1 | 903 | book | 本 | 専用練習音声、画像なし |
| L2-to-L1 | 904 | water | 水 | 専用練習音声、画像なし |
| L2-to-L1 | 905 | house | 家 | 専用練習音声、画像なし |

ID、word、非nullのimage key・audio keyはいずれも本番項目と非重複にし、3課題の練習語も互いに重複させません。LearningとL2-to-L1の練習音声は、学習accentにかかわらずAmerican Englishの固定TTS `tts_us_bella`（ElevenLabs Bella）を使います。音声はoffline生成した固定WAVであり、browser実行時のTTSは使用しません。L2-to-L1練習音声は`practice`専用keyを使います。全練習trialは`practice=1`かつ`exclude_from_analysis=1`で、本分析に含めません。この分離はmanifest生成後のinvariant checkerでも検査します。

Barcroft and Sommers (2005), Experiment 2はExperiment 1と同じ手順を用い、24語全体を6回提示し、各word group内の語順を6反復で固定し、High条件では各itemに対応する話者を無作為・非復元で選んでいます。原文は最初のword group内語順の生成法を示していないため、本実装では再現可能な最小解として、各条件内の最初の12語順だけをseed付きFisher–Yates shuffleで決めて再利用します。各24語反復は、参加者間でカウンターバランスした同一の条件順（No 12語→High 12語、またはその逆）で構成します。

v8 manifestの`exposure`と`cycle`は、いずれも時間的に連続する24語全体の反復番号1–6を表します。各cycleには同じ条件順でNo/Highの12語blockが1つずつ入り、`learningBlock`はその12語blockを提示順に1–12で表します。

参加者制御の休憩は24本番試行ごと、すなわち各反復の間に維持します。原論文は休憩、注視点、練習trial、試行間隔を報告していないため、これらはBarcroft and Sommers (2005)からの再現項目ではなく、本研究の運用上の追加です。

## 4. 学習試行の時系列

本番144回の前に、ID 906（`apple`／🍎）と907（`orange`／🍊）の英語練習2回を固定順で行います。練習も同じ5,000 ms・750 ms・650 msのtimingを使い、D1へ実施ログを残しますが、録音せず本分析から除外します。練習は操作の理解だけを目的とし、main randomizationの乱数domainや消費順には入れません。本番前には、原論文Experiment 2と同様に、一部の語は異なる話者によって発音されることを参加者へ知らせます。参加者向け画面には、行動を変えない5,000 ms・750 ms・650 msの実装値を表示せず、「＋のあとに絵と英単語が出て、自動で進む」とだけ案内します。

1. 画像を表示する。
2. 画像onsetから750 ms後に学習音声を開始する。
3. 画像はonsetから5,000 msで消す。
4. 画像消失または応答窓終了から次onsetまで、650 msを最小目標間隔とする。

750 msと5秒は Barcroft and Sommers (2005) の手順を踏襲します。650 msは本実装で追加した値で、同論文からの引用値ではありません。絶対時計で次onsetの最早時刻を決め、応答確定後の録音uploadはバックグラウンドで行います。ただし、応答のserver受理や次刺激読込が650 msを超えた場合に試行順を破って開始はしません。実onsetの超過を`onset_late_ms`と`trial_onset_late`に記録します。画像は事前decodeし、実paintに最も近いanimation frame時刻を記録します。音声はWeb Audio clockで予約し、ネットワーク保存は5秒・10秒の提示deadlineを延長しません。

## 5. Picture Naming

pre・直後・遅延の各時点で練習2試行、本番24試行です。

練習2回はID 901（`dog`）と902（`chair`）の専用画像です。3時点とも同じ高頻度2項目を使いますが、本番24語のword・imageとは重複しません。手順練習そのものが低頻度語彙知識を測ることを避けるための選択です。練習でも本番と同じ10秒の発話手順と録音品質確認を行いますが、音声Blobは応答保存キューへ入れず、IndexedDB・R2・研究者ZIP・参加者ZIPのいずれにも保存しません。練習trialの実施、timing、client側QC metadataだけをD1に残します。

- 音声captureは画像onset直前にarmし、冒頭欠落を防ぐ。採点・QCの分析窓は画像onsetから開始。
- 応答窓は10秒。
- No 12語、High 12語。
- 12組のNo/Highペアを作り、No-first 6組、High-first 6組。
- 条件連続は最大2。
- pre・直後・遅延では別domain seedを使い、3順序の完全同一をpairwiseに明示的に拒否。

Picture Naming latencyは、Barcroft and Sommers (2005) Experiment 2が踏襲したExperiment 1の定義に合わせ、画像cue onsetから参加者の最初の発声までとします。参加者には、`えーと`、`うーんと`、`あっ`等を付けず、答えの英単語だけを最初から1回発話し、分からなければ無言で待つよう、練習前と本番前に表示します。

preでは正答語、英語音声、綴り、正誤feedbackを提示しません。それでも、同じ24画像を見て英語語彙を検索・発話しようとする行為は画像馴化とpretesting/retrieval-attempt効果を導入します。このため、主要推論の対象は「pre Picture Namingを受けた学習者」に限られ、preなしの学習へ直接一般化できません。pre完了から学習開始までの実施上の上限・下限は設けず、間隔だけを理由に受付拒否や自動除外をしません。実間隔の分布とpre後離脱は条件別に報告し、主要解析での扱いと感度分析はPI・共同研究者がリポジトリ外の解析計画で結果確認前に固定します。参加者IDはpre後の離脱があっても再利用しません。pre→学習間隔の正本は、pre Picture Naming最終試行の行動応答受理時刻からimmediate学習最初の試行開始時刻までとします。共通入口でのsession開始時刻や、録音upload完了後のvisit確定時刻はこの間隔に用いません。

## 6. L2-to-L1

各時点で練習3試行、本番30試行です。本番30試行はNo/Highの主要24語と、未学習の簡単な統制6語からなります。

練習3回はID 903（`book`）、904（`water`）、905（`house`）のAmerican English専用音声です。3語とも固定TTS `tts_us_bella`を使い、本番24語のword・audioとは重複しません。練習でも本番と同じ発話手順と録音品質確認を行いますが、参加者の練習音声Blobは保存せず、実施・timing・client側QC metadataだけをD1に残します。

録音課題の開始前にはマイク確認で1回録音・再生します。練習中は本番と同じ連続した課題流れを保つため、各練習回答後の自己録音再生は行いません。

- 録音は音声開始150 ms前から開始。
- Web Audioの再生buffer末尾後に10秒の応答窓。latency分析では、QA済みの音響的語末へ別途補正する。
- English / Chinese / Japaneseを各8語。
- 各アクセント内でNo 4語、High 4語。
- 6 strata（2 variability×3 accents）を1つずつ含む6試行miniblockを4つ作る。
- 統制はID 908–913の`strawberry`（いちご）、`grape`（ぶどう）、`pineapple`（パイナップル）、`peach`（桃）、`kiwi`（キウイ）、`cherry`（さくらんぼ）。学習phaseでは提示しない。
- 統制音声はAmerican Englishの固定TTS `tts_us_bella`を使い、主要24語の相対順とminiblockを保ったままseed付きで挿入する。
- variabilityとaccentの連続はいずれも、主要24語と統制6語からなる本番30試行内で最大2。練習3試行は別phaseとしてこの制約に含めない。
- 直後と遅延では語→アクセント→話者の写像を固定し、提示順だけを独立化。

統制6語は`practice=0`、`exclude_from_analysis=1`、`expects_recording=1`、`variability=null`としてD1へ記録し、No/High Variabilityの主要解析から除外します。同じ6 WAVを直後・遅延で使います。「未学習」はLearning phaseで学習していないという意味であり、遅延時点では直後テストで一度聴取済みです。統制の提示位置や除外flagは参加者用manifestへ出しません。

L2-to-L1のlatencyは、本研究の操作的定義として、テスト語の音響的offsetから日本語回答の最初の発声までとします。Barcroft and Sommers (2005)はL2-to-L1にもlatencyを報告していますが、本文の手順記述はその起点が音声onsetかoffsetかを明記していないため、offset基準を同論文の明示的定義として引用しません。参加者への前置き・言い直し・無回答指示はPicture Namingと同じ方針です。

現行録音の`analysis_start_seconds`はWeb Audio buffer末尾です。これは音響的な語末と同一とは限らないため、本番刺激ごとにQA台帳の`acoustic_word_offset_ms`を確定し、buffer末尾との差を補正してlatencyを算出します。末尾無音を未検査のままbuffer末尾を音響offsetとみなしません。

2026-09-05、PI／ユーザーの了承により、両発話課題のRTは機器遅延未補正のbrowser/software基準の近似値として扱う方針に固定しました。現行programはremote端末のloopback校正を実施せず、実ヘッドホン出力・マイク入力のhardware latencyを除去しません。Picture Namingの画像基準もDOM更新直後のbrowser timestampであり、光学的なpixel onsetを測った値ではありません。L2の音響語末への補正は引き続き行いますが、校正済み絶対RTや機器間の精密比較は主張しません。raw WAVと既存timing metadataを保持し、発話onsetのオフライン採点・QCは別工程とします。この方針決定を、測定値の外部校正やpilotの全工程完了の証拠にはしません。

L2-to-L1主要24語はEnglish=`E6_Audio`、Japanese=`J5_Natural`、Chinese=`C11_Natural`の固定3話者を本番で使い、練習は別の固定TTS話者を使います。同じ本番語に対する話者は直後と遅延で変えません。現行R2 keyはtimepointを含まないため、同じ本番語には直後・遅延で同一WAV tokenを再提示します。同一話者の別takeを使う場合は、刺激確定前にtimepointをkeyとasset inventoryへ追加し、反復効果とtoken差のどちらを統制するかをPI・共同研究者がリポジトリ外の解析計画で決定します。

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

seedが固定するのは、割付、試行順、語、条件、話者、刺激key、protocol timingを含むplanned manifestです。実際のvisual onset、音声schedule・終了、lateness、visibility、server受理時刻等のruntime logはseedで事前生成されず、参加者実施時に観測して別に保存します。分析の正本はD1へ固定したmanifestとcanonical runtime responseであり、分析時にseedから再生成した順序ではありません。研究者ZIPの`design.json`は割付・version・visit別manifest hashを、`item_assignments.csv`は保存済みの参加者×本番語24行についてList、No/High、No条件の固定学習話者、test accent、固定test話者を、`learning_trials.csv`は全Learning計画行について`planned_`列とcanonical `runtime_`列を分離して出力します。`item_assignments.csv`の`no_training_talker_id`はNo行のみ値を持ち、High行は空欄です。High語の各6曝露の話者と提示順は`learning_trials.csv`のplanned manifestを正本とします。未実施行のruntime値は空欄とし、開始後に未受理・再提示となったtrialも全attempt数とnoncanonical attempt数で見分けます。氏名、secret、raw root seedはZIPへ出しません。

本番24語、指定話者roster、新しいL2統制6語、Bella固定練習TTSを含む開発manifest契約は`main-v10-english-practice-placeholder`です。本番用asset候補は`main-assets-v2`で、production反映時は`main-v10-english-practice-real-assets`を使います。練習発話WAV非保存契約は変えません。root seed入力に`ASSIGNMENT_VERSION`を含める契約上、v10で新規作成する参加者のmain順序はv9以前と同じであるとは仮定しません。旧versionで作成済みの参加者は保存済みmanifestを正本として変更せず、version別cohortとして区別します。

生成後のmanifestは再利用可能なinvariant checkerで検査します。学習・各テストの試行数、録音数、Learningの条件順、各条件で6回固定される語順、各High語の6話者非復元割当、Picture NamingのNo/High pair orientation、L2主要24語のminiblock、統制6語の分析除外・録音・挿入、直後・遅延の語→accent→話者→WAV写像を契約として扱います。監査scriptはID 1–2160を独立した2つのrandomization secretで生成し、計4,320 designを検査します。同じserial positionの一致数は報告指標であり、恣意的に順序を再抽選する制約にはしません。

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

合計26試行、保存対象録音24件です。練習2件は発話手順を実施しますが音声を保存しません。pre完了後、担当者は全員共通のMain Experiment入口を案内します。preの完了時刻が古いことを理由に開始を拒否せず、pre完了→learning開始の上限・下限は設けません。

直後visitは次の順です。

```text
学習練習2 → 学習本番144 → PN練習2 → PN本番24 → L2練習3 → L2本番30（主要24＋統制6）
```

合計205試行、保存対象録音54件です。Picture Naming練習2件とL2-to-L1練習3件の音声は保存しません。

遅延visitは次の順です。

```text
PN練習2 → PN本番24 → L2練習3 → L2本番30（主要24＋統制6）
```

合計59試行、保存対象録音54件です。Picture Naming練習2件とL2-to-L1練習3件の音声は保存しません。3 visit全体では290応答・132 WAVです。遅延目標はImmediate最終L2-to-L1試行の行動応答をserverが受理した時刻＋5日です。この5日はdelayed操作を保つ開始下限です。開始にはImmediateの全応答・録音の保存確定も必要ですが、その確定時刻から5日を再計算しません。両条件を満たした後は期限切れにしません。実際の保持間隔は、直後L2-to-L1最終試行の行動応答受理時刻から遅延Picture Naming最初の試行開始時刻までとします。目標偏差は、遅延Picture Naming最初の試行開始時刻から保存済み目標時刻を引きます。共通入口でのsession開始時刻、録音upload時刻、visit確定時刻、後から変更されたdelay設定値からの逆算は用いません。これらの正本値はD1 view `analysis_intervals`から取得します。

6つのparticipant pageを用意しますが、通常配布する全員共通の入口はpre、immediate、delayedの3つです。短期session tokenには認証上の有効期限がありますが、同じ共通入口を開き直して同じIDを入力・確認すれば未完了位置から再開できるため、これは参加期限ではありません。immediate内とdelayed内では同じsession epochを引き継ぎます。次segmentの開始前に、前segmentの録音がすべてR2へ保存済みであることをserverが検査します。

課題画面はviewport内へ固定し、ページscrollを無効にします。課題進行に使えるkeyboard shortcutはfreshなSpace押下だけとし、EnterとSpace長押しrepeatでは進めません。timed trialは自動進行し、Spaceで短縮できません。Space案内はclick可能なCTAではなくkeyboard keyとして表示します。ID確認、中断・終了は誤操作を避けるため明示button／入力操作のままにしますが、中断導線を出すのは開始前・課題間案内・休憩などの非計測画面だけです。練習の注視点は中央の`+`だけ、本番の注視点は`+`と細い進捗barだけを表示し、刺激onsetでbarを隠します。注視点・刺激・回答時間には課題名、現在位置、総試行数、完了数、保存状態、説明文、中断buttonを表示しません。録音課題の回答中は必要な録音表示と残り時間だけを示します。participant向けの開始・再開・休憩文にも`144`、`24`、`x/y`を出しません。fatal時はallowlist済みの固定案内または一般案内とopaqueなお問い合わせ番号だけを表示します。部分データを失う可能性がある終了確認では、安全側の「終了せず担当者へ連絡」を先頭・初期focusにします。

2026-09-05、PIは途中配布による自己録音の聞き返し・復習が成績へ影響し得ることを説明されたうえで、Pre・Immediate・Delayed各visit完了後の参加者ZIP配布を明示承認しました。各visitをserver側で保存確定後、認証済みsessionのvisitまでの累積canonical回答とWAVを自動ダウンロードします。Preは26回答・24 WAV、ImmediateはPreを含む231回答・78 WAV、Delayedは全3 visitの290回答・132 WAVです。後続visitは実施済みであっても、以前のvisitのsessionで取得するZIPには含めません。未実施課題、刺激、正答、割付、研究者用CSVは配布しません。Pre・Immediateの完了画面とZIP内READMEに「全課題終了まで開かず聞き返さず保管」を案内しますが、遵守や復習防止を保証しません。filenameは参加者ID・visit・生成日の日本時間日付を含む`accentedness_p{numeric_id}_{visit_type}_{YYYYMMDD}.zip`とし、通常完了と完了画面再読み込みを共通処理にして手動再ダウンロードリンクを残します。download失敗で保存済みvisitを未完了へ戻しません。ID 999はZIPを生成せず完全非保存です。

## 10. 一時中断、参加終了、通常完了

「一時中断」「参加を終了する」「visit完了」は別の状態遷移です。

- 中断buttonは開始前・課題間案内・休憩などの非計測画面だけに表示し、注視点・刺激・回答時間には表示しません。安全な画面でrequestした後は新しい試行へ進まず、送信待ち録音をflushしてからfinalizeします。
- requestと試行開始が競合した場合、先に開始済みの1試行だけは応答・録音をdrainできます。requestが先なら次のtrial startをAPIとD1 triggerの両方が拒否します。openなinterruption中はvisit完了、通常の新session、別visitの開始を拒否し、同じvisitの送信・finalize復旧と、確定済みpauseからの制御された再開だけを許可します。
- 一時中断では参加者とvisitを完了・withdraw扱いにせず、現在sessionだけを閉じます。finalize時にもserverがcanonical responseに対応する録音待ち0件を再検査し、1件でも残れば`requested`のまま拒否します。同じ共通入口で同じIDを入力・確認すると新sessionとなり、serverが受理したcanonical trialの直後から再開します。
- pause requestのfinalize前にtabを失った場合、再認証しても`requested`を自動で`resumed`へ変えず、次trialを禁止したまま送信とpause確定を続行します。pauseが`paused`まで確定した後の再認証だけを明示的な再開として`resumed`にします。
- 回復不能な回答・録音エラーで安全な再開を保証できない場合、pauseを完了扱いにはしません。pause要求後なら、参加者は未確定の確認番号を残すか、同じrequest UUID・interruption UUIDを保持した一方向の`pause/requested`→`terminate/requested`切替を明示的に選びます。再訪時のoutbox照合で初めて判明した場合も新trialを始めず、新しいterminate requestによるserver受理済み範囲での参加終了か担当者連絡だけを提示します。逆方向やfinalize済み状態の変更は拒否します。
- pause時に開始済みだが未受理だったattemptを再提示する場合、旧attemptと録音slotは`superseded_on_resume`でabandoned・非canonicalにし、新attemptへ`repeated_after_interruption=1`を付けます。学習なら追加曝露として`extra_exposure=1`も付けます。
- 永続的な参加終了では、受理済みcanonical responseとupload済みR2 WAVを削除・上書きしません。未受理attemptは非canonicalのabandoned、canonical responseに対応する未upload録音は`participant_terminated`のabandonedとして区別します。完了済みvisitはそのまま保持し、未完了visitだけを`withdrawn`にします。
- 参加終了は`behavioral_completed_at_ms`、segment完了時刻、`finalized_at_ms`を新規設定しません。部分データを通常完了に見せず、active sessionを閉じ、以後の再開を拒否します。
- terminate requestがserverへ届いた後、finalize前にtabを閉じても要求を失いません。同じ共通入口で同じIDを入力・確認すると、試行開始を禁止したまま新sessionで送信待ちを再送し、同じrequest UUIDの終了確定だけを続行できます。要求を出した旧session UUIDは監査用に保持し、finalize権限は同じparticipant・visitへ再認証されたsessionに限定します。
- 明示操作なしにtabやbrowserを閉じた場合は、通常完了・一時中断・参加終了のどれにも自動変換しません。server受理済み位置までの未完了visitとして残し、同じ共通入口から再開します。

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
