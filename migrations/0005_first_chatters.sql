-- 「その配信で初めての発言」の記録（issue #52）
--
-- 日時は 0001〜0004 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- 適用方法は README.md の「配信の記録」を参照。

-- 配信の区切りごとに、その配信で最初に発言した人を1行持つ（worker/chat-store.ts の claimFirstChatOfStream）。
-- 配信の区切りは stream_sessions（0001）で、配信中の行が無いとき（配信外の発言）は行を足さない。
--
-- message_id を持つのは、同じ発言についての問い合わせに何度でも同じ答えを返すため。
-- この判定は Webhook（worker/webhook-routes.ts）とオーバーレイ（POST /api/overlay/alert）の両方から呼ばれ、
-- 同じ発言が別々の経路で届く（メッセージIDはTwitchの通知ごとに違うが、発言そのもののIDは同じ）。
-- 先に問い合わせた側だけが「初回」になってしまうと、音が鳴るのにお礼が送られない（またはその逆）ことになる。
--
-- 古い行は cron（worker/collect.ts）が消すので増え続けない。ただし配信中の区切りのぶんは、古くても消さない
-- （期限より長く続く配信の途中で消すと、すでに発言した人がまた「初回」と判定されてしまう）。
CREATE TABLE first_chatters (
  session_id TEXT NOT NULL REFERENCES stream_sessions (id),
  chatter_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  first_chatted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, chatter_user_id)
) WITHOUT ROWID;

-- 古い行の削除（first_chatted_at）に効かせるための索引
CREATE INDEX first_chatters_first_chatted_at ON first_chatters (first_chatted_at);
