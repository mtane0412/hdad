---
paths:
  - "src/transcript/**"
  - "transcript/**"
  - "worker/transcript-store.ts"
  - "worker/transcript-routes.ts"
---

# 配信中の文字起こし（アプリの枠の Web Speech API・`transcript/relay/`・裏方の `?transcript=`）

取り込み方は2つある。

**アプリの枠の音声認識（issue #189）**: 認識はページではなくアプリの枠（`src/app/app.tsx` の `Shell`）が `src/transcript/recognition-context.tsx` の `RecognitionProvider` で持ち、どのページを見ていても続く。オン・オフと様子はコネクターのページの区画（`recognition-section.tsx`）、オンのあいだの状態はサイドバー（`recognition-status.tsx`）に出し、言い方は `recognition-label.ts` だけが決める。オン・オフはこのブラウザの localStorage に覚え、認識するのは Web Locks の鍵を取れた1つのタブだけにする。途切れたらタイマーを挟まずすぐ始め直し、マイクを開いたままにする（`recognizer.ts`）。確定した1件は `webspeech:<UUID>` のメッセージIDで、セッションで守る `POST /api/admin/transcripts` へ送り、やり直せる失敗だけを同じIDで送り直す（`delivery.ts`）。Chrome の音声認識・マイク・鍵・localStorage・送信は `RecognitionDeps` で受け取ってテストで差し替える。

**ゆかコネNEO からの中継**: アプリのページを持たず（OBSに貼るURLとポートはコネクターのページ `/connectors/` が出す。`.claude/rules/backstage.md`）、取り込むのはOBSに置く中継（裏方の1枚の中の `src/transcript/task.ts`。単独の `transcript/relay/index.html` も残す）である。同じPCで動くゆかコネNEO のWebSocket（既定 `ws://localhost:11901/`。`host` は `localhost` か `127.0.0.1` だけ）につなぎ、確定した母国語（`Text1`）の1件をオーバーレイ用キーで `POST /api/overlay/transcript` へ送る。暫定（`TextFixed` が偽）と `isDeleted` の1件は送らない。

本文の検証と記録は2つの受け口で共通の `worker/transcript-routes.ts` の `receiveTranscript` を通す。保存は `worker/transcript-store.ts`（`transcripts`）で、配信中の区切りが無ければ1行も書かない。→ `docs/decisions/transcript.md`

利用者向けの説明は `docs/guide/transcript.md`。
