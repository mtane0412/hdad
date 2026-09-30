-- コメントビューアーの発言の既読・未読（issue #146）
--
-- 日時は 0001〜0019 と同じく UTC の ISO 8601（例: 2026-09-29T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- 配信でもらったコメントに反応したかどうかを、発言1件ごとに持つ。行が無い発言は未読である。
-- 画面だけでなくここにも持つのは、配信者の発話からコメントへの反応を判定する処理（issue #147）が、
-- どの発言がまだ未読か・配信者が手で未読に戻したかを Worker の側で読むためである。
--
-- stream_chat_messages に列を追加せず別の表にするのは、あちらが配信中の区切りが無いと1行も書かれないためである
-- （配信外に開いたコメントビューアーでも、手で既読にできるようにする）。
--
-- marked_by は最後に付け替えたのが誰か（manual: 配信者が手で / jev: 発話から判定して）である。
-- 手で未読に戻した発言（read = 0 かつ marked_by = 'manual'）には、Jev が既読を付け直さない。
CREATE TABLE comment_reads (
  message_id TEXT PRIMARY KEY,
  read INTEGER NOT NULL CHECK (read IN (0, 1)),
  marked_by TEXT NOT NULL CHECK (marked_by IN ('manual', 'jev')),
  updated_at TEXT NOT NULL
);

-- 古い行の掃除（日時での絞り込み）に効かせるための索引
CREATE INDEX comment_reads_updated_at ON comment_reads (updated_at);
