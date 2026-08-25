# 本番刺激への差し替え

## 1. 現在のプレースホルダー

`src/lib/stimuli.js` の24語、練習5語、話者IDはすべて仮です。`public/placeholder-audio/` の音声とサーバー生成の仮画像は、導線・タイミング・保存の検査用であり、実験データ収集には使えません。

本番では、語、L1訳、画像、全話者録音を一度に凍結し、`ASSIGNMENT_VERSION` と `ASSET_VERSION` を新しくします。既存参加者のmanifestを後から上書きしません。

## 2. 必要な話者構成

| 用途 | アクセントごとの必要数 | 条件 |
|---|---:|---|
| 学習 | 6名 | Noでは参加者ごとに1名、Highでは6名全員 |
| L2練習・本番 | ちょうど1名 | 女性、学習話者とは別。同じ固定話者を練習・本番、直後・遅延で使用 |

テストはEnglish、Chinese、Japaneseごとに固定された1名、計3名を使います。そのため、アクセントと個人話者が完全に交絡し、accent母集団への一般化はできません。この制約を事前登録・論文・分析解釈に明記し、推論対象を選定した3名の音声に限定します。将来、話者一般化を目的として複数名へ増やす場合は、割当アルゴリズム、解析上の話者効果、`ASSIGNMENT_VERSION`を同時に更新してください。

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

L2練習音声:

```text
stimuli/{ASSET_VERSION}/practice/{accent}/{talker_id}/{word}.wav
```

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

学習では音声が画像onsetから750 ms後に始まり、画像は5秒で消えます。音声durationがこの窓を超えるファイルはクライアントが拒否します。L2では音声offset後10秒を測るため、ファイル末尾の余分な無音は反応時間と録音窓を歪めます。音響的な語末endpointを統一してtrimしてください。

## 5. 画像形式

- 24語とPicture Naming練習2語について1枚ずつ。
- `webp`、同じcanvasサイズ、同じ背景、同程度の視覚的複雑性。
- 文字、綴り、文化依存の手掛かりを含めない。
- 画像の命名一致度と概念同定率を対象母集団に近い別サンプルで確認。
- 同義語が生じる場合は採点規則を事前に定義。

## 6. 差し替え手順

1. `src/lib/stimuli.js` の24語、訳、話者rosterを確定する。
2. 全ファイルをkey規約どおりに準備する。
3. ファイル名の大文字小文字、拡張子、話者IDを機械検査する。
4. SHA-256、duration、sample rate、channel、bit depth、RMS、peak、leading/trailing silenceを一覧化する。
5. 別担当者が一覧と音声内容を照合する。
6. R2 `STIMULI`へuploadする。
7. `ASSET_VERSION` と `ASSIGNMENT_VERSION` を更新する。
8. `ALLOW_PLACEHOLDER_ASSETS=false`、`ENVIRONMENT=production` にする。
9. 新規の非本番IDで全試行を生成し、404やplaceholder fallbackが1件もないことを確認する。
10. 直後・遅延を通しで実施し、音声・画像・録音・時刻を人手でも確認する。

## 7. 音響QA台帳の最低列

```text
asset_version, category, accent, talker_id, talker_gender,
item_id, word, r2_key, sha256, sample_rate_hz, channels,
bit_depth, duration_ms, leading_silence_ms, trailing_silence_ms,
rms_dbfs, peak_dbfs, clipping_samples, reviewer, review_status
```

本番開始条件は、期待される全keyが存在し、全行が`review_status=approved`で、manifestに使われない余分なファイルもversion単位で把握できていることです。

## 8. 変更管理

収集開始後に1ファイルでも差し替える場合は、同じkeyを上書きせず新しい`ASSET_VERSION`へ配置します。割当・話者数・語リスト・seed文脈を変える場合は`ASSIGNMENT_VERSION`も更新します。version間の参加者数と変更理由を分析報告に残します。
