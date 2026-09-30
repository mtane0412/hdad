---
paths:
  - "src/transcript/**"
  - "transcript/**"
  - "worker/transcript-store.ts"
---

# 配信中の文字起こし（`/transcript/`）

配信中の文字起こし（`/transcript/`）はアプリのページ（`src/transcript/transcript-page.tsx`）だが、取り込むのはOBSに置く中継ページ（`transcript/relay/index.html`）である。同じPCで動くゆかコネNEO のWebSocket（既定 `ws://localhost:11901/`。`host` は `localhost` か `127.0.0.1` だけ）につなぎ、確定した母国語（`Text1`）の1件をオーバーレイ用キーで `POST /api/overlay/transcript` へ送る。暫定（`TextFixed` が偽）と `isDeleted` の1件は送らない。保存は `worker/transcript-store.ts`（`transcripts`）で、配信中の区切りが無ければ1行も書かない。→ `docs/decisions/transcript.md`

利用者向けの説明は `docs/guide/transcript.md`。
