-- 視聴者の作業の宣言（配信画面の「作業机」に並べるもの。issue #207）
--
-- 日時は 0001〜0023 と同じく UTC の ISO 8601（例: 2026-10-03T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 視聴者がチャットの組み込みのコマンド !task <作業> で宣言した作業を、配信ごとに1人1行で持つ（worker/task-desk-store.ts）。
-- 発言ではなく人を貯める。!task を打ち直すと同じ行の作業と宣言した時刻を差し替え、完了を外す。
-- 配信外の宣言は残さない（作業机は配信ごとに片付け、次の配信は空から始める）。配信が終わっても消さずに残し、
-- 作業した時間の合計（issue #209）の材料にする。
--
-- display_name は宣言したときの表示名で、作業机に出す名前である（照合には user_id を使う）。
-- message_id は宣言した発言（!task）のID。モデレーションでその発言が消されたときに、行を引いて消すのに使う。
-- 同じ発言の再送（Twitch は応答が届かなかった通知を再送する）を見分けるのにも使い、再送では宣言した時刻も完了も変えない。
-- done_at は !done で完了にした時刻。未完了なら NULL。
CREATE TABLE task_declarations (
  session_id TEXT NOT NULL REFERENCES stream_sessions (id),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  task TEXT NOT NULL,
  message_id TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (session_id, user_id)
) WITHOUT ROWID;

-- モデレーションで消された発言から、その発言で宣言した行を引くための索引
CREATE INDEX task_declarations_message ON task_declarations (message_id);
