---
paths:
  - "src/bot/**"
  - "worker/auth-routes.ts"
  - "worker/token.ts"
  - "worker/token-vault.ts"
  - "worker/webhook-routes.ts"
  - "worker/bot-*.ts"
  - "worker/chat-*.ts"
  - "worker/moderation-config.ts"
  - "worker/eventsub*.ts"
---

# チャットボット（`/bot/`）

チャットボット（`/bot/`）は配信者とは別のTwitchアカウントを接続し、IRCではなく Helix の `POST /helix/chat/messages` で書き込む。トークンは役割ごとに Durable Object の保管庫（`TOKENS`。`worker/token-vault.ts`）に持ち（`worker/token.ts` の `TokenRole`）、更新の書き戻しは「保存済みが期待どおりのときだけ置き換える」1回の要求で行う（読み直しと書き込みを分けると、その間の切断・付け替えを取り消してしまう）。チャットの受信は EventSub の `channel.chat.message` を Webhook で購読する（`worker/eventsub-webhook.ts`）。届いた発言はまずコメントビューアーへ押し出し（`.claude/rules/comments.md`）、そのあと自動モデレーションの判定・アラートのトリガーの判定・コマンドの応答をこの順に行い、bot自身の発言にはどれも行わない。コマンドの応答の前に、作業机の組み込みのコマンド（`!task`・`!done`）を見る（`.claude/rules/task-desk.md`）。判定（`worker/chat-command.ts`・`worker/chat-moderation.ts`）・設定（`worker/bot-config.ts`・`worker/moderation-config.ts`）・実行（`worker/bot-chat.ts`・`worker/bot-moderation.ts`）を分ける。→ `docs/decisions/bot.md`

利用者向けの説明は `docs/guide/bot.md`。
