-- 意見ボードの段階2（観点の提案と、Jev による振り分け前の絞り込み。issue #307）
--
-- 日時は 0001〜0033 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。

-- 合成ページの中央下に出す、視聴者への問いかけ（「こんな観点からも聞いてみたい」）。LLM が1文で作る。まだ作っていなければ NULL。
-- 問いかけに答える意見が届いたら作り直す（worker/opinion-run.ts）。作り直しに失敗したら前の問いかけを残す。
ALTER TABLE opinion_themes ADD COLUMN prompt TEXT;

-- コメントの status に filtered（Jev が意見ではないとみて、振り分けの LLM に渡さなかった）を足し、Jev の確率（jev_score）を持たせる。
-- SQLite は CHECK を書き換えられないので、表を作り直して移す。
-- jev_score は Jev に尋ねたコメントだけが持つ（規則で落としたもの・鍵が無くて尋ねなかったものは NULL）。しきい値を実配信の記録から
-- 決めるために、落とさなかったコメントにも残す（worker/opinion-filter.ts の OPINION_FILTER_THRESHOLD）。
CREATE TABLE opinion_comments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES opinion_themes (id),
  message_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  text TEXT NOT NULL,
  reply_name TEXT,
  reply_text TEXT,
  sent_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'dropped', 'filtered', 'ignored', 'used', 'failed')),
  drop_reason TEXT CHECK (drop_reason IN ('command', 'emote', 'reaction')),
  opinion_id INTEGER REFERENCES opinions (id),
  jev_score REAL CHECK (jev_score IS NULL OR (jev_score >= 0 AND jev_score <= 1))
);

INSERT INTO opinion_comments_new (id, theme_id, message_id, user_id, user_name, text, reply_name, reply_text, sent_at, status, drop_reason, opinion_id)
SELECT id, theme_id, message_id, user_id, user_name, text, reply_name, reply_text, sent_at, status, drop_reason, opinion_id FROM opinion_comments;

DROP TABLE opinion_comments;
ALTER TABLE opinion_comments_new RENAME TO opinion_comments;

-- 振り分け待ちのコメントを書かれた順に読む（worker/opinion-store.ts の readPendingComments）
CREATE INDEX opinion_comments_theme_status ON opinion_comments (theme_id, status, sent_at);

-- 意見ごとのもとのコメントを読む（人数ともとのコメント）
CREATE INDEX opinion_comments_opinion ON opinion_comments (opinion_id);
