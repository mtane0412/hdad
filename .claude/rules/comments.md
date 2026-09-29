---
paths:
  - "src/comments/**"
  - "worker/comment-*.ts"
---

# コメントビューアー（`/comments/`）

コメントビューアー（`/comments/`）は配信中に配信者が横に開いておく画面で、チャットの発言と出来事（サブスク・ギフト・レイド・ビッツ・チャンネルポイントの引き換え・フォロー）を届いた順に1本の流れとして並べる。Webhook で届いた通知を `worker/comment-feed.ts` の `toFeedItem` が1件に直し（通信を持たない）、配送先の Durable Object（`worker/comment-channel.ts` の `CommentChannel`）へ押し出す。押し出しはほかの処理（自動モデレーション・トリガー・応答）より先に行い、失敗しても2xxを返して `comment-feed-failed` を記録する（コメントビューアーのためにトリガーや応答を止めない）。**サブスク・ギフト・レイドは `channel.chat.notification` から読み**、同じ出来事の `channel.subscribe`・`channel.subscription.message`・`channel.raid` は流さない（二重に並ぶため。逆にお知らせのほうは数えずトリガーにもかけない＝`FEED_ONLY_EVENT_TYPES`）。**Durable Object は中身を読まない配送者で**、直近 `RECENT_LIMIT` 件を保管に覚えてつないだ直後に履歴として渡す。形の確かめと並べ方（同じ通知のメッセージIDを二重に並べない・消された発言は並びから消さず印を付ける）は `src/comments/feed.ts` だけが持つ。アイコンは1件に添えず、画面が初めて見た人のIDだけをまとめて `GET /api/admin/comments/icons` に問い合わせる。WebSocketの接続は手書きと同じく `Origin` を自分で確かめる。→ `docs/decisions/comments.md`

利用者向けの説明は `docs/guide/comments.md`。
