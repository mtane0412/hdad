---
paths:
  - "src/bot/**"
  - "worker/auth-routes.ts"
  - "worker/token.ts"
  - "worker/webhook-routes.ts"
  - "worker/bot-*.ts"
  - "worker/chat-*.ts"
  - "worker/moderation-config.ts"
  - "worker/eventsub*.ts"
---

# チャットボット（`/bot/`）

チャットボット（`/bot/`）は配信者とは別のTwitchアカウントを接続し、IRCではなく Helix の `POST /helix/chat/messages` で書き込む。トークンは役割ごとに別のキーでKVに持つ（`worker/token.ts` の `TokenRole`）。チャットの受信は EventSub の `channel.chat.message` を Webhook で購読する（`worker/eventsub-webhook.ts`）。届いた発言はまずコメントビューアーへ押し出し（`.claude/rules/comments.md`）、そのあと自動モデレーションの判定・アラートのトリガーの判定・コマンドの応答をこの順に行い、bot自身の発言にはどれも行わない。判定（`worker/chat-command.ts`・`worker/chat-moderation.ts`）・設定（`worker/bot-config.ts`・`worker/moderation-config.ts`）・実行（`worker/bot-chat.ts`・`worker/bot-moderation.ts`）を分ける。→ `docs/decisions/bot.md`

利用者向けの説明は `docs/guide/bot.md`。
