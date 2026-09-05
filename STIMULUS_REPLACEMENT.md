# 本番刺激への差し替え

## 1. 現在の状態

`src/lib/stimuli.js` の本番24語、学習18話者、テスト3話者、L2-to-L1統制6語は確定済みです。`public/placeholder-audio/` の英語音声とサーバー生成の仮画像は、導線・タイミング・保存の検査用であり、実験データ収集には使えません。本番24語とPicture Naming練習2語の画像は全件揃い、`../Stimuli/Main_Experiment_Staging/main-assets-v2/images/`へopaque lossless WebPで配置済みです。標準寸法は400×400、`nostril`だけは原寸の400×399を許容します。`syringe`、`podium`、`protractor`の印字・数字は現候補のまま採用します。PIは全画像の使用を承認していますが、主24画像の命名確認結果ファイルは本リポジトリにないため`waived_by_pi_without_repository_result`、練習2画像は`approved_by_pi`として`image_inventory.csv`へ記録します。指定済みの学習432、テスト72、統制6と静的TTS練習5の計515 WAVも同じstagingへ44.1 kHz / PCM16 / monoで配置し、全件を−23.979 dBFS whole-token RMSへ統一しました。`audio_qc_by_file.csv`と`audio_qc_summary.csv`が詳細・集計の正本で、自動QA failure / reviewは0件です。`audio_offset_review.csv`にはテスト72・統制6・L2練習3の計81件について`waveform_endpoint_v1`で確定した語末offsetを記録済みです。PIはElevenLabs Bellaによる練習・統制11語を聴取して承認済みです。学習音声のblind intelligibility確認も実施済みとして使用を承認しましたが、結果ファイルがないためPI判断による免除として扱います。

練習は本番24語・統制6語とは別の専用stimulus poolです。Learningは英語2語（ID 906–907、`apple`／🍎、`orange`／🍊）、Picture Namingは高頻度英語2語（ID 901–902、`dog`、`chair`）、L2-to-L1はさらに別の高頻度英語3語（ID 903–905、`book`、`water`、`house`）を使います。ID、語、画像key、音声keyは本番・統制と重複させません。LearningとL2練習は、学習accentにかかわらずAmerican Englishの`tts_us_bella`を使い、browserのruntime TTSは使いません。

本番では、語、L1訳、画像、全話者録音を一度に凍結し、`ASSIGNMENT_VERSION` と `ASSET_VERSION` を新しくします。既存参加者のmanifestを後から上書きしません。

## 2. 固定話者roster

| 用途 | accent | 固定ID | 実音声とsource talker labelを照合した声種 |
|---|---|---|---|
| 学習 | English | `E1_Audio`, `E4_Audio`, `E7_Audio`, `E12_Audio`, `E13_Audio`, `E14_Audio` | 男性声3・女性声3 |
| 学習 | Japanese | `J6_Natural`, `J8_Natural`, `J4_Natural`, `J12_Natural`, `J10_Natural`, `J15_Natural` | 女性声5・男性声1 |
| 学習 | Chinese | `C2_Natural`, `C5_Natural`, `C7_Natural`, `C15_Natural`, `C16_Natural`, `C18_Natural` | 女性声3・男性声3 |
| L2主要24語 | English | `E6_Audio` | 女性声 |
| L2主要24語 | Japanese | `J5_Natural` | 男性声 |
| L2主要24語 | Chinese | `C11_Natural` | 男性声 |
| Learning/L2練習5語 | English | `tts_us_bella` | ElevenLabs Bella（American English女性TTS） |
| L2統制6語 | English | `tts_us_bella` | ElevenLabs Bella（American English女性TTS） |

テストはEnglish、Chinese、Japaneseごとに固定された1名、計3名を使います。そのため、アクセントと個人話者が完全に交絡し、accent母集団への一般化はできません。この制約を研究報告・分析解釈に明記し、推論対象を選定した3名の音声に限定します。将来、話者一般化を目的として複数名へ増やす場合は、割当アルゴリズム、解析上の話者効果、`ASSIGNMENT_VERSION`を同時に更新してください。

American English、Mandarin-accented English、Japanese-accented Englishの操作確認は、自己申告だけでなく独立評定、居住歴・言語背景、録音条件の統一を含めて記録します。

PIは、各accentの学習24語×6話者=144 tokenを用いたblind intelligibility確認を実施済みとして本刺激の使用を承認しました。ただし、完全一致正答率などの結果ファイルは本リポジトリにありません。このため証拠付きvalidation完了とはせず、`waived_by_pi_without_repository_result`として進めます。

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

L2統制音声:

```text
stimuli/{ASSET_VERSION}/test-control/english/tts_us_bella/{word}.wav
```

統制は`strawberry`、`grape`、`pineapple`、`peach`、`kiwi`、`cherry`の6 WAVです。PI承認済みのElevenLabs v3候補をPCM16 mono 44.1 kHzへ変換し、他のテスト音声と同じwhole-token RMSへ揃えました。staging側のhashと測定値は`audio_qc_by_file.csv`へ記録し、生成条件は`elevenlabs_generation_manifest.csv`と`elevenlabs_generation_metadata.json`に保持します。runtime生成はせず、同じWAVを直後・遅延で使用します。

このkeyはtimepointを含まないため、現行実装では直後と遅延に同一WAVを使います。同一の3話者を維持しつつ時点別の別takeを使う場合は、差し替え作業の前に`test/{timepoint}/...`等へkey規約とmanifest生成を同時に変更し、`ASSIGNMENT_VERSION`を更新してください。

本番ゲートの `TEST_TOKEN_POLICY` は、この決定を設定として明示するためのものです。現行コードが受け付ける値は `same_token` だけです。別takeを選んだ場合は、新key規約を実装・検証するまでは `undecided` のままにし、production回収を解除しません。

L2練習音声:

```text
stimuli/{ASSET_VERSION}/practice/english/tts_us_bella/{word}.wav
```

L2練習3語はすべてAmerican Englishの`tts_us_bella`で固定し、3個の専用WAVを使います。開発用`public/placeholder-audio/book.wav`と`water.wav`は旧version再開のため既存Samantha音声を保持します。v10で追加した`house`と統制6語の公開filenameは非本番の汎用`book`音声を返し、本番Bella WAVを`public/`へ置きません。

Learning練習音声:

```text
stimuli/{ASSET_VERSION}/learning-practice/english/tts_us_bella/{apple|orange}.wav
```

練習TTS話者はAmerican English=`tts_us_bella` / ElevenLabs Bellaです。offline生成した5 WAVをLearning/L2練習で使い、runtime TTSは行いません。全件をPCM mono 16-bit / 44.1 kHz、−23.979 dBFS whole-token RMSへ揃え、duration、無音、peak、SHA-256をQA台帳へ固定しました。v9以前のassetと開発用`ringo.wav`・`mikan.wav`・`car.wav`は削除せず保持します。voiceまたはengineを変更する場合は同じfile keyを上書きせず、新しい`ASSET_VERSION`で聴取確認をやり直します。

内部accent値は `english`、`chinese`、`japanese` です。TTS voiceの性別は割付・解析因子にしません。

## 4. 音声形式

ブラウザ互換性と音響QAを単純化するため、本番入力は次を推奨します。

- RIFF/WAVE
- PCM、16-bit
- mono
- 全ファイルで44.1 kHz。選定済み元音声は44.1 / 48 / 96 kHzが混在するため原本のまま保存し、最終配置用copyだけを変換する
- clippingなし
- 語頭・語末の無音区間を規則化
- 同一のpeakまたはloudness基準で正規化
- DC offset、クリック、背景雑音、残響を検査

本番Learning音声は、原研究と同様に防音された録音環境で収録します。参加者側の再生音量75 dBは原研究のLearning手順として報告された値ではないため、本実装へ固定値として転用せず、共通の機材・音量校正手順を別途事前登録します。

学習では音声が画像onsetから750 ms後に始まり、画像は5秒で消えます。音声durationがこの窓を超えるファイルはクライアントが拒否します。L2では音響的な語末offsetから発話開始までを分析するため、ファイル末尾と語末を同一視しません。各test、control、L2 practice tokenの`acoustic_word_offset_ms`と`buffer_end_minus_word_offset_ms`は、`scripts/finalize-audio-offsets.py`の`waveform_endpoint_v1`で自動確定します。これは20 ms RMS frame、5 ms hop、max(peak frame − 40 dB, −55 dBFS)の閾値、25 ms以下のgap結合、30 ms未満のregion除外を使い、整数msはhalf-upでsample化します。Learning practiceはresponse latencyを測らないためoffset台帳の対象外です。収集後はaudio keyで台帳を結合し、WAV内に保存されたbuffer末尾基準を音響語末基準へ補正します。この補正はWAV内のbuffer差だけを扱い、再生機器やbrowserの絶対latencyを校正するものではありません。TTSは時間伸縮を行わず、総durationを強制的に同一化しません。

現stagingはpeak正規化ではなく、既存コーパスの標準値−23.979 dBFSへのwhole-token RMS正規化を採用します。これにより、元データで約8–10 dB大きかった`E1_Audio`と`E6_Audio`も他の指定話者と同じ基準になります。統制・練習TTSも配置用WAVを同じwhole-token RMSへ揃えます。原音声と既存統制TTS原稿は変更しません。

## 5. 画像形式

- 本番24語とPicture Naming専用練習2語について1枚ずつ（合計26枚）。
- `webp`、同じcanvasサイズ、同じ背景、同程度の視覚的複雑性。
- 文字、綴り、文化依存の手掛かりを含めない。
- 主24画像の命名確認は、結果ファイルなしのPI判断による免除として記録する。練習2画像はPI承認を記録する。
- 同義語が生じる場合は採点規則を事前に定義。
- canonical語`raccoon`の元画像だけ`Stimuli/Pictures/racoon.png`なので、最終bundleでは内容を確認して`raccoon.webp`へ明示的に対応づける。
- 原PNGは変更せず、配置用copyを400×400のlossless WebPにする。`nostril`だけは400×399を許容する。
- `syringe`、`podium`、`protractor`の印字・数字と、`nostril`の赤い囲み表示はPI判断で現候補のまま採用する。

## 6. 差し替え手順

1. `src/lib/stimuli.js` の本番24語、統制6語、各練習pool、訳、話者rosterを正本として、全poolのID・語が交わらないことを機械検査する。
2. 全ファイルをkey規約どおりに準備する。
3. ファイル名の大文字小文字、拡張子、話者IDを機械検査する。
4. SHA-256、duration、sample rate、channel、bit depth、RMS、peak、leading/trailing silenceを一覧化し、test/control/L2-practice音声ではversion付き波形規則で音響語末とbuffer末尾の差も記録する。practice/main間の同一SHA-256を拒否する。
5. 別担当者が画像・音声を実際に見聞きして一覧と内容を照合し、別encode・別crop等でSHAが異なる実質同一刺激も拒否する。
6. R2 `STIMULI`へuploadする。
7. `ASSET_VERSION` と `ASSIGNMENT_VERSION` を更新する。
8. `env.production.vars` で `ALLOW_PLACEHOLDER_ASSETS=false`、`ENVIRONMENT=production`、現行方針なら `TEST_TOKEN_POLICY=same_token` にする。
9. 新規の非本番IDで全試行を生成し、404やplaceholder fallbackが1件もないことを確認する。
10. 直後・遅延を通しで実施し、音声・画像・録音・時刻を人手でも確認する。

## 7. 音響QA台帳の最低列

```text
asset_version, category, accent, talker_id,
item_id, word, r2_key, sha256, sample_rate_hz, channels,
bit_depth, duration_ms, leading_silence_ms, trailing_silence_ms,
rms_dbfs, peak_dbfs, clipping_samples, candidate_acoustic_word_offset_ms,
acoustic_word_offset_ms,
buffer_end_minus_word_offset_ms, reviewer, review_status
```

`candidate_acoustic_word_offset_ms`は−40 dBFS単一sample判定による旧レビュー補助値であり、RT補正には使用しません。RT補正には`waveform_endpoint_v1`で求めた`acoustic_word_offset_ms`を使い、`reviewer=waveform_endpoint_v1`、`review_status=approved_automatic`とします。`python3 scripts/finalize-audio-offsets.py ../Stimuli/Main_Experiment_Staging/main-assets-v2 --check`でhash・形式・全offsetを再検査できます。本番開始条件は、期待される全keyが存在し、対象全行が`approved_automatic`で、manifestに使われない余分なファイルもversion単位で把握できていることです。

## 8. 変更管理

収集開始後に1ファイルでも差し替える場合は、同じkeyを上書きせず新しい`ASSET_VERSION`へ配置します。割当・話者数・語リスト・seed文脈を変える場合は`ASSIGNMENT_VERSION`も更新します。version間の参加者数と変更理由を分析報告に残します。
