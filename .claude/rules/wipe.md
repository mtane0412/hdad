---
paths:
  - "src/wipe/**"
  - "worker/wipe-*.ts"
  - "src/speech/voice.ts"
  - "src/speech/task.ts"
---

# ワイプ（素材の種類 `wipe`）

ワイプはチャットの発言を1件ずつ、発言した人のアイコンの枠と吹き出しで出す素材で、読み上げも自分で行う（読み上げているあいだだけ吹き出しを出す。ミュート中は `silentDurationOf` の時間だけ出す。次の発言が無ければ `LINGER_MS` 残す）。出す発言は読み上げる発言と同じで、判断は `src/speech/text.ts` の `speechTextOf` だけが持つ（`src/wipe/comment.ts` は呼ぶだけ）。いつ何を出し・いつ読むかは `src/wipe/runner.ts` だけが持ち、合成・再生・DOM・待ち時間は引数で受け取る。読み上げの設定・合成先・ミュートは裏方の読み上げと共有する `src/speech/voice.ts` の `startSpeechVoice` から使う。アイコンは `GET /api/overlay/wipe/icon?login=`（`worker/wipe-routes.ts`）で引き、合成ページがログイン名ごとに覚える。引けなかった1件は出さずに箱へ失敗を出す。

二重読みを防ぐため、ワイプは構成全体で1つまで（`worker/overlay-layout.ts` が保存のときに断る）、構成にワイプがあれば裏方の読み上げ（`src/speech/task.ts`）は始めずに投げ、起動のあとも30秒おきに構成を読み直してワイプが置かれたらやめる（`src/wipe/layout.ts` の `wipeOverlayNameOf`）。→ `docs/decisions/wipe.md`

利用者向けの説明は `docs/guide/wipe.md`。
