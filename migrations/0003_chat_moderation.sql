-- チャットの自動モデレーションの状態（issue #42）
--
-- 日時は 0001・0002 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- 適用方法は README.md の「配信の記録」を参照。

-- 直近のチャットの文面。連投（同じ文面のくり返し）の判定だけに使う。
-- 本文そのものではなくハッシュを持つのは、数えるのに本文が要らないうえ、チャットの中身を貯め込まないため。
-- 書き込むのは連投のルールが有効なときだけで、判定のたびに窓（最大10分）より古い行を消すので増え続けない。
CREATE TABLE chat_recent_messages (
  chatter_user_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  sent_at TEXT NOT NULL
);

-- 「この発言者の、この文面が、窓の中に何件あるか」を数えるための索引。古い行の削除（sent_at）にも効く
CREATE INDEX chat_recent_messages_lookup ON chat_recent_messages (chatter_user_id, text_hash, sent_at);
CREATE INDEX chat_recent_messages_sent_at ON chat_recent_messages (sent_at);
