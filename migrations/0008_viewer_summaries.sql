-- 人物像（summary）と、その材料になるチャットの一時的な記録（issue #63 Phase 7c の残り）
--
-- 日時は 0001〜0007 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は README.md の「配信の記録」を参照。

-- LLMが作った人物像。配信者が手で書く note とは別の列にする。
--
-- 機械の推測と人が書いたものを混ぜない（画面でも別々に出す）。作り直しのたびに上書きするので、
-- 過去の推測は残らない。まだ作っていない人では空文字である。
ALTER TABLE viewers ADD COLUMN summary TEXT NOT NULL DEFAULT '';

-- その人物像を作った日時。まだ作っていない人では NULL。
-- 画面で「いつ時点の推測か」を添えるために持つ（材料はその時点までの発言だけなので、古いほど当てにならない）。
ALTER TABLE viewers ADD COLUMN summarized_at TEXT;

-- 人物像の材料になる、配信中のチャットの本文。
--
-- チャットの全文は貯めないという方針（.claude/CLAUDE.md）の、意識して設けた例外である。人物像は
-- 集計値（発言数・バッジ・初回と最後の発言日時）だけからは作れず、その人が何を話したかが要るためである。
-- 貯めるのは配信中に届いた発言だけで、人物像を作り終えた人のぶんはすぐ消す（worker/collect.ts）。
-- 配信をまたいで残った取りこぼしも、cron が一定期間で消す。永く持つのは人の記録（viewers）だけである。
--
-- session_id を持つのは、「終わった配信の発言だけを材料にする」ためである（配信中の発言はまだ材料にしない。
-- 配信の途中で人物像を作っても、その後の発言が入らない）。記録するときの結びつけ方は stream_events と同じで、
-- 配信中の区切りが無ければ1行も書かない。
--
-- message_id を主キーにするのは、Twitchが再送した通知で同じ発言を二重に貯めないためである
-- （viewers の last_message_id・first_chatters の message_id と同じ考え方）。
CREATE TABLE stream_chat_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  text TEXT NOT NULL
);

-- 人物像を作る対象（人ごとのまとまり）と、その人の発言の読み出しに効かせるための索引
CREATE INDEX stream_chat_messages_user ON stream_chat_messages (user_id, sent_at);

-- 取り残しの掃除（日時での絞り込み）に効かせるための索引
CREATE INDEX stream_chat_messages_sent_at ON stream_chat_messages (sent_at);
