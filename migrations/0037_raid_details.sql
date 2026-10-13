-- 受けたレイドのレイド元と人数（issue #353）
--
-- 日時は 0001〜0036 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。

-- レイド（stream_events の type = 'channel.raid'）1件ごとの、レイド元の配信者と連れてきた人数。
-- 時刻と配信との結びつきは stream_events の行が持ち、ここには通知の中身だけを持つ（件数の数え方を変えないため）。
-- このテーブルを作る前に記録したレイドには行が無い（ダッシュボードはレイド元を「—」とし、時刻と定着だけを出す）。
-- 書くのは EventSub の channel.raid を受けたときだけで、stream_events の行と同じ batch で書く（worker/stats-store.ts の recordRaid）。
CREATE TABLE raid_details (
  event_id TEXT PRIMARY KEY REFERENCES stream_events (id),
  from_user_id TEXT NOT NULL,
  from_user_login TEXT NOT NULL,
  from_user_name TEXT NOT NULL,
  viewers INTEGER NOT NULL
) WITHOUT ROWID;
