-- 配信タイトルの候補（試験運用。issue #268）
--
-- 日時は 0001〜0027 と同じく UTC の ISO 8601（例: 2026-10-06T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 章が切り替わるたびに LLM が作った配信タイトルの候補（配信者が書いた固定部分のあとに続く一言）と、
-- それを配信タイトルとして公開してよいかを Jev に尋ねた答えを持つ（worker/stream-title.ts）。
-- この段階では Twitch のタイトルは書き換えず、記録をダッシュボードの配信の詳細で章と並べて見比べる。
--
-- 候補は章ごとに1つなので、主キーは配信と章の始まりの組（stream_chapters の主キー）にする。
-- publishable は「公開してよい」の確率（0〜1）。しきい値と比べずにそのまま残し、段階1のしきい値を決める材料にする。
CREATE TABLE stream_title_candidates (
  session_id TEXT NOT NULL,
  chapter_started_at TEXT NOT NULL,
  candidate TEXT NOT NULL,
  publishable REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, chapter_started_at),
  FOREIGN KEY (session_id, chapter_started_at) REFERENCES stream_chapters (session_id, started_at)
) WITHOUT ROWID;
