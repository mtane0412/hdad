-- 意見ボード（配信者が出したテーマについて、視聴者のコメントから意見を取り出して観点ごとに並べる。issue #306）
--
-- 日時は 0001〜0032 と同じく UTC の ISO 8601（例: 2026-10-10T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- 配信をまたいで残し、消さない（配信のあとの振り返り（issue #309）で読むため）。書くのはテーマを出しているあいだだけである。

-- テーマ。開いているテーマ（closed_at が NULL）は1つだけで、開くときに1つの文の中で確かめる（worker/opinion-store.ts の openTheme）。
-- 合成ページは締め切ったあとも、次のテーマを開くまで最後のテーマを映し続ける。
CREATE TABLE opinion_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

-- 論点（観点）。LLM が名前を付け、1つのテーマに6つまで（worker/opinion.ts の MAX_TOPICS）。同じテーマで名前を重ねさせない。
CREATE TABLE opinion_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES opinion_themes (id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (theme_id, title)
);

-- 意見。LLM が発言から作った1文と札の種類（課題・解決策・問い・気づき）を持つ。人数は持たず、もとのコメント（opinion_comments の
-- opinion_id）から数える。hidden は配信者が隠した意見（合成ページに出さない。荒らし対策）。
-- first_comment_id は最初のもとのコメントで、振り分けを1つの batch で書くときに、作った意見をコメントから指すための鍵にする。
CREATE TABLE opinions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES opinion_topics (id),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'solution', 'question', 'insight')),
  text TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  first_comment_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- テーマを出しているあいだに届いたコメント。チャットの全文は貯めないという方針の、意識して設けた例外である
-- （意見のもとの発言を配信者が確かめられるようにし、拾えなかった発言を救い出せるようにするため。issue #308）。
-- status: pending は振り分け待ち、dropped は規則で落とした（drop_reason に理由）、ignored は LLM が無関係とした、
-- used は意見になった（opinion_id に意見）、failed は振り分けに失敗した回の発言。
-- message_id はTwitchのメッセージのIDで、通知の再送で同じコメントを二重に貯めないための鍵にする。
CREATE TABLE opinion_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES opinion_themes (id),
  message_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_name TEXT,
  reply_text TEXT,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dropped', 'ignored', 'used', 'failed')),
  drop_reason TEXT CHECK (drop_reason IN ('command', 'emote', 'reaction')),
  opinion_id INTEGER REFERENCES opinions (id)
);

-- 振り分け待ちのコメントを書かれた順に読む（worker/opinion-store.ts の readPendingComments）
CREATE INDEX opinion_comments_theme_status ON opinion_comments (theme_id, status, sent_at);

-- 意見ごとのもとのコメントを読む（人数ともとのコメント）
CREATE INDEX opinion_comments_opinion ON opinion_comments (opinion_id);
