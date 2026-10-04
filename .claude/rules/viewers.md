---
paths:
  - "src/viewers/**"
  - "worker/viewer-*.ts"
  - "worker/stream-chat-store.ts"
  - "worker/webhook-routes.ts"
  - "worker/collect.ts"
  - "worker/ai-chat.ts"
  - "migrations/*viewer*.sql"
---

# 視聴者の記録（`/viewers/`）

視聴者の記録（`/viewers/`）は発言ではなく人を貯める（`viewers`。1人1行）。照合の鍵はTwitchのユーザーIDだけで、名前・バッジ・その人自身のチャンネルの内容は「最後に観測した値」として持つ（真偽値にしない）。読み書きは `worker/viewer-store.ts`、経路は `worker/viewer-routes.ts`。記録は `worker/webhook-routes.ts` のチャットの受け口だけで行い、前回から10分が経つまでは1行も書かない。人物像（`summary`）は cron（`worker/collect.ts` の `summarizeViewers`）が作り、配信者が書く `note` とは別の列に持つ。材料にするのは、終わりまで章にし終えた配信（`stream_sessions.chaptered_until`）の発言だけである（`.claude/rules/stream-chapters.md`）。材料の本文（`stream_chat_messages`）は自動モデレーションの判定のあとに貯め、Twitch の削除の通知（発言の削除・一掃・クリア）が届いたら行を消す（`removeModeratedStreamChat`）。→ `docs/decisions/viewers.md`

利用者向けの説明は `docs/guide/viewers.md`。
