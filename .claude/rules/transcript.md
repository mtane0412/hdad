---
paths:
  - "src/transcript/**"
  - "worker/transcript-store.ts"
  - "worker/transcript-routes.ts"
---

# 配信中の文字起こし（アプリの枠の Web Speech API）

認識はページではなくアプリの枠（`src/app/app.tsx` の `Shell`）が `src/transcript/recognition-context.tsx` の `RecognitionProvider` で持ち、どのページを見ていても続く。オン・オフと様子はコネクターのページの区画（`recognition-section.tsx`）、オンのあいだの状態はサイドバー（`recognition-status.tsx`）に出し、言い方は `recognition-label.ts` だけが決める。オン・オフはこのブラウザの localStorage に覚え、認識するのは Web Locks の鍵を取れた1つのタブだけにする。途切れたらタイマーを挟まずすぐ始め直し、マイクを開いたままにする（`recognizer.ts`）。確定した1件は `webspeech:<UUID>` のメッセージIDで、セッションで守る `POST /api/admin/transcripts` へ送り、やり直せる失敗だけを同じIDで送り直す（`delivery.ts`）。認識しているタブは暫定・確定の文を字幕の中継先へも送る（`.claude/rules/caption.md`）。Chrome の音声認識・マイク・鍵・localStorage・送信・字幕の中継先への接続は `RecognitionDeps` で受け取ってテストで差し替える。

本文の検証と記録は `worker/transcript-routes.ts` の `postAdminTranscript` が行う。ゆかコネNEO からの中継（`transcript/relay/`・`POST /api/overlay/transcript`・裏方の `?transcript=`）は issue #192 で消したので戻さない。保存は `worker/transcript-store.ts`（`transcripts`）で、配信中の区切りが無ければ1行も書かない。→ `docs/decisions/transcript.md`

利用者向けの説明は `docs/guide/transcript.md`。
