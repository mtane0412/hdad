-- 初めての発言への挨拶の記録と、発言の既読・未読の廃止（issue #158）
--
-- 日時は 0001〜0020 と同じく UTC の ISO 8601（例: 2026-09-30T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- first_chatters（0005）の1行は「その配信で、その人が初めて発言した」ことを表す。そこに、配信者がその人に
-- 挨拶したかを greeted_at として持つ（NULL なら挨拶していない）。挨拶したかはコメントビューアー（/comments/）で
-- 配信者が手で切り替える（worker/chat-store.ts の recordGreeting）。
-- 挨拶は配信ごと・人ごとに1回なので、初めての発言の行に並べて持てば足りる。古い行は cron が消すが、
-- 配信中の区切りのぶんは消さないので、配信のあいだは記録が残る。
--
-- comment_reads（0020）は、全発言の既読・未読をやめたので消す（docs/decisions/comments.md）。
ALTER TABLE first_chatters ADD COLUMN greeted_at TEXT;

-- 挨拶の付け替えは発言のID（message_id）で行を探すので、そのための索引
CREATE INDEX first_chatters_message_id ON first_chatters (message_id);

DROP TABLE comment_reads;
