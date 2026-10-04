---
paths:
  - "src/speech/**"
  - "speech/**"
  - "worker/speech-*.ts"
---

# チャットの読み上げ（`speech/reader/`）

チャットの読み上げ（`speech/reader/`）は映すものを持たない単独のページで、合成は既定では同じPCで動く VOICEVOX ENGINE（既定 `http://localhost:50021`。`host` は `localhost` か `127.0.0.1` だけ）に任せる。合成先（`engine`）に `sakura` を選んだときだけ、さくらのAI Engine で合成する（従量課金。APIキー `SAKURA_AI_API_KEY` をブラウザに置かないため、`worker/speech-routes.ts` の `POST /api/overlay/speech/check`・`/synthesis` を経由する。Worker は保存済みの設定が `sakura` でなければ409で断り、話者と速度も保存済みの設定から取る。呼び出しは `worker/speech-sakura.ts`、ブラウザ側は `src/speech/sakura.ts`）。合成先・ホスト・ポートは起動のときにしか使わない（変わったかの見分けは `src/speech/engine.ts`）。設定（話者・速度・音量・長さ・名前を読むか・読み上げない人）は Worker が持ち（画面はコネクターのページ `/connectors/` の VOICEVOX の区画 `src/speech/speech-section.tsx`。読み上げだけのURLは出さない）（`worker/speech-config.ts`。KVは `speech-settings`）、配送はポーリング（30秒）。値の範囲の検証は Worker だけが持つ。変換（`text.ts`・`queue.ts`・`form.ts`）と呼び出し（`voicevox.ts`・`sakura.ts`・`api.ts`）を `audio.ts`・`stage.ts` から分ける。読み上げそのものは `src/speech/task.ts` の `startSpeech`。→ `docs/decisions/speech.md`

利用者向けの説明は `docs/guide/speech.md`。
