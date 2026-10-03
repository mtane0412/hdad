-- 開発の出来事（配信画面の「今日の作業ログ」に並べるもの。issue #211）
--
-- 日時は 0001〜0022 と同じく UTC の ISO 8601（例: 2026-10-03T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- GitHub の Webhook で届いたコミットの push・PR のマージのうち、配信中に届いたものを1件1行で持つ（worker/work-log-store.ts）。
-- 配信外に届いたものは残さない（受け口がトリガーと同じく捨てる）。章（stream_chapters）と同じく消さずに残す。
--
-- id は 'github:' に X-GitHub-Delivery を続けたもの。GitHub の Redeliver は同じ値を使うので、再送は主キーで1行にまとまる。
-- トリガーの再送を見分ける鍵（replied_chat_messages）とは兼ねない。あちらは動作ごとの鍵で保持期間が過ぎると消え、
-- こちらは出来事ごとに配信の記録として残すためである。
-- kind は 'commit'（push）か 'merge'（PR のマージ）。text は作業ログに出す1行（コミットのメッセージの1行目、または「#番号 タイトル」）。
CREATE TABLE dev_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES stream_sessions (id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX dev_events_session ON dev_events (session_id, occurred_at);
