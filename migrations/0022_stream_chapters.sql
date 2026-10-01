-- 配信の章立て（配信ごとの「何が話されたか」の記録）
--
-- 日時は 0001〜0021 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 配信を約30分ごとの区間に分け、区間ごとに LLM がまとめた見出しと要約を1章として持つ（worker/stream-chapter.ts）。
-- 材料（transcripts・stream_chat_messages・screen_lines）は配信のあと間もなく消えるが、章は消さずに残し、
-- ダッシュボードの配信の詳細から読み返す。
--
-- 区間は配信の開始から積み上げるので、1配信の中で started_at が重ならない。主キーは配信と区間の始まりの組にする。
CREATE TABLE stream_chapters (
  session_id TEXT NOT NULL REFERENCES stream_sessions (id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (session_id, started_at)
) WITHOUT ROWID;

-- どこまでを章にしたか。NULL はまだ1章も作っていない（配信の開始から始める）。
--
-- 発話の無い区間は章を作らずにこの目印だけを進めるので、章の行からは「どこまで見たか」が分からない。そのため別に持つ。
-- 人物像づくりは、終わった配信をこの目印が終わりまで進んでから始める（worker/stream-chat-store.ts）。
-- 人物像を作ると発言の材料が消えるので、先に作ると最後の章から視聴者の反応が抜けるためである。
ALTER TABLE stream_sessions ADD COLUMN chaptered_until TEXT;

-- この機能より前に終わった配信は、章を作らずに作り終えたものとして扱う（材料の発言は既に人物像づくりで消えているため）
UPDATE stream_sessions SET chaptered_until = ended_at WHERE ended_at IS NOT NULL;
