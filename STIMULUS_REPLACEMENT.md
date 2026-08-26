# 本番刺激への差し替え

## 1. 現在のプレースホルダー

`src/lib/stimuli.js` の本番24語、Picture Naming練習2語、L2-to-L1練習3語と実験話者IDは仮です。`public/placeholder-audio/` の英語音声とサーバー生成の仮画像は、導線・タイミング・保存の検査用であり、実験データ収集には使えません。

練習は本番24語とは別の専用stimulus poolです。Learningは英語2語（ID 906–907、`apple`／🍎、`orange`／🍊）、Picture Namingは高頻度英語2語（ID 901–902、`dog`、`chair`）、L2-to-L1はさらに別の高頻度英語3語（ID 903–905、`book`、`water`、`car`）を使います。ID、語、画像key、音声keyは本番と重複させません。Learning練習は参加者の割当学習accentに一致するaccent別専用練習話者を使い、browserのruntime TTSは使いません。L2練習は本番と同じaccent別固定女性話者を使いますが、練習専用語の別WAV tokenです。

本番では、語、L1訳、画像、全話者録音を一度に凍結し、`ASSIGNMENT_VERSION` と `ASSET_VERSION` を新しくします。既存参加者のmanifestを後から上書きしません。

## 2. 必要な話者構成

| 用途 | アクセントごとの必要数 | 条件 |
|---|---:|---|
| 学習 | 6名 | Noでは参加者ごとに1名、Highでは6名全員 |
| Learning練習 | 1名 | 学習6話者・テスト話者とは別。割当学習accentと一致 |
| L2練習・本番 | ちょうど1名 | 女性、学習話者とは別。同じ固定話者を練習・本番、直後・遅延で使用 |

テストはEnglish、Chinese、Japaneseごとに固定された1名、計3名を使います。そのため、アクセントと個人話者が完全に交絡し、accent母集団への一般化はできません。この制約を研究報告・分析解釈に明記し、推論対象を選定した3名の音声に限定します。将来、話者一般化を目的として複数名へ増やす場合は、割当アルゴリズム、解析上の話者効果、`ASSIGNMENT_VERSION`を同時に更新してください。

American English、Mandarin-accented English、Japanese-accented Englishの操作確認は、自己申告だけでなく独立評定、居住歴・言語背景、録音条件の統一を含めて記録します。

## 3. R2 key規約

画像:

```text
stimuli/{ASSET_VERSION}/images/{word}.webp
```

学習音声:

```text
stimuli/{ASSET_VERSION}/learning/{accent}/{talker_id}/{word}.wav
```

L2本番音声:

```text
stimuli/{ASSET_VERSION}/test/{accent}/{talker_id}/{word}.wav
```

このkeyはtimepointを含まないため、現行実装では直後と遅延に同一WAVを使います。同一の3話者を維持しつつ時点別の別takeを使う場合は、差し替え作業の前に`test/{timepoint}/...`等へkey規約とmanifest生成を同時に変更し、`ASSIGNMENT_VERSION`を更新してください。

本番ゲートの `TEST_TOKEN_POLICY` は、この決定を設定として明示するためのものです。現行コードが受け付ける値は `same_token` だけです。別takeを選んだ場合は、新key規約を実装・検証するまでは `undecided` のままにし、production回収を解除しません。

L2練習音声:

```text
stimuli/{ASSET_VERSION}/practice/{accent}/{talker_id}/{word}.wav
```

L2練習3語は参加者ごとに3accentを1回ずつ提示します。accent順と練習語の対応はseedで変わるため、本番asset inventoryには3練習語 × 3 accents = 9個の専用WAVが必要です。開発用`public/placeholder-audio/book.wav`、`water.wav`、`car.wav`はmacOS American-English voice `Samantha`による共通fallbackで、3accentの妥当な代替ではありません。形式・振幅・SHA-256に加え、認可済みstimulus endpointから3ファイルを順に取得できることだけを自動testします。本番では固定女性3話者による9 WAVへ置換します。

Learning練習音声:

```text
stimuli/{ASSET_VERSION}/learning-practice/{accent}/{practice_talker_id}/{apple|orange}.wav
```

話者IDはEnglish=`e_practice_f1`、Chinese=`c_practice_f1`、Japanese=`j_practice_f1`です。本番asset inventoryには2語×3 accentsの6 WAVが必要で、各accentは同accentの専用練習話者で録音します。開発用`public/placeholder-audio/apple.wav`と`orange.wav`はmacOS American-English voice `Samantha`で生成した共通fallbackです。PCM mono 16-bit / 44.1 kHz、duration、RMS、peak、SHA-256は自動testで固定していますが、Mandarin/Japanese-accented Englishを表さないため、本番回収には使用できません。v4保存済みmanifestの再開用`ringo.wav`・`mikan.wav`も削除せずhashを固定します。話者またはengineを変更する場合は同じfile keyを上書きせず、新しい`ASSET_VERSION`で聴取確認をやり直します。

内部accent値は `english`、`chinese`、`japanese` です。話者IDには氏名を含めず、研究用コードを使います。

## 4. 音声形式

ブラウザ互換性と音響QAを単純化するため、本番入力は次を推奨します。

- RIFF/WAVE
- PCM、16-bit
- mono
- 全ファイルで同じsample rate（例: 48 kHz）
- clippingなし
- 語頭・語末の無音区間を規則化
- 同一のpeakまたはloudness基準で正規化
- DC offset、クリック、背景雑音、残響を検査

学習では音声が画像onsetから750 ms後に始まり、画像は5秒で消えます。音声durationがこの窓を超えるファイルはクライアントが拒否します。L2では音響的な語末offsetから発話開始までを分析するため、ファイル末尾と語末を同一視しません。各test/practice tokenについて人手確認した`acoustic_word_offset_ms`をQA台帳へ保存し、`buffer_end_minus_word_offset_ms`も算出してください。収集後はaudio keyで台帳を結合し、WAV内に保存されたbuffer末尾基準を音響語末基準へ補正します。

## 5. 画像形式

- 本番24語とPicture Naming専用練習2語について1枚ずつ（合計26枚）。
- `webp`、同じcanvasサイズ、同じ背景、同程度の視覚的複雑性。
- 文字、綴り、文化依存の手掛かりを含めない。
- 画像の命名一致度と概念同定率を対象母集団に近い別サンプルで確認。
- 同義語が生じる場合は採点規則を事前に定義。

## 6. 差し替え手順

1. `src/lib/stimuli.js` の本番24語、Picture Naming練習2語、L2-to-L1練習3語、訳、話者rosterを確定し、固定Learning練習2語を含む全poolのID・語が交わらないことを機械検査する。
2. 全ファイルをkey規約どおりに準備する。
3. ファイル名の大文字小文字、拡張子、話者IDを機械検査する。
4. SHA-256、duration、sample rate、channel、bit depth、RMS、peak、leading/trailing silenceを一覧化し、test/practice音声では人手確認した音響語末とbuffer末尾の差も記録する。practice/main間の同一SHA-256を拒否する。
5. 別担当者が画像・音声を実際に見聞きして一覧と内容を照合し、別encode・別crop等でSHAが異なる実質同一刺激も拒否する。
6. R2 `STIMULI`へuploadする。
7. `ASSET_VERSION` と `ASSIGNMENT_VERSION` を更新する。
8. `env.production.vars` で `ALLOW_PLACEHOLDER_ASSETS=false`、`ENVIRONMENT=production`、現行方針なら `TEST_TOKEN_POLICY=same_token` にする。
9. 新規の非本番IDで全試行を生成し、404やplaceholder fallbackが1件もないことを確認する。
10. 直後・遅延を通しで実施し、音声・画像・録音・時刻を人手でも確認する。

## 7. 音響QA台帳の最低列

```text
asset_version, category, accent, talker_id, talker_gender,
item_id, word, r2_key, sha256, sample_rate_hz, channels,
bit_depth, duration_ms, leading_silence_ms, trailing_silence_ms,
rms_dbfs, peak_dbfs, clipping_samples, acoustic_word_offset_ms,
buffer_end_minus_word_offset_ms, reviewer, review_status
```

本番開始条件は、期待される全keyが存在し、全行が`review_status=approved`で、manifestに使われない余分なファイルもversion単位で把握できていることです。

## 8. 変更管理

収集開始後に1ファイルでも差し替える場合は、同じkeyを上書きせず新しい`ASSET_VERSION`へ配置します。割当・話者数・語リスト・seed文脈を変える場合は`ASSIGNMENT_VERSION`も更新します。version間の参加者数と変更理由を分析報告に残します。
