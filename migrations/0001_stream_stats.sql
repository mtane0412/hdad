-- 配信の記録（issue #18）
--
-- 日時はすべて UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- 適用方法は README.md の「配信の記録」を参照。

-- 配信セッション。id はTwitchの配信ID。ended_at が NULL の行は配信中
CREATE TABLE stream_sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  title TEXT NOT NULL,
  category_name TEXT NOT NULL
);
CREATE INDEX stream_sessions_started_at ON stream_sessions (started_at);

-- 配信中の視聴者数（cron のたびに1行）
CREATE TABLE viewer_samples (
  session_id TEXT NOT NULL REFERENCES stream_sessions (id),
  sampled_at TEXT NOT NULL,
  viewer_count INTEGER NOT NULL,
  PRIMARY KEY (session_id, sampled_at)
) WITHOUT ROWID;

-- フォロワー数。前回から変わったときだけ1行足すので、ある時刻の値は「その時刻以前で最新の行」になる
CREATE TABLE follower_samples (
  sampled_at TEXT PRIMARY KEY,
  follower_total INTEGER NOT NULL
) WITHOUT ROWID;

-- サブスク・ポイント交換・レイドなどのイベント。id はEventSubのメッセージID（重複排除に使う）。配信外のイベントは session_id が NULL
CREATE TABLE stream_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES stream_sessions (id),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX stream_events_session ON stream_events (session_id, type);

-- 収集の失敗（トークンが無い・更新できない、Twitchが失敗を返した など）
CREATE TABLE collection_failures (
  occurred_at TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  message TEXT NOT NULL
) WITHOUT ROWID;
