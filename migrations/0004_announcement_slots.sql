-- アナウンスの送信枠（issue #46）
--
-- 日時は 0001〜0003 と同じく UTC の ISO 8601（例: 2026-09-21T12:00:00.000Z）の文字列で持つ。桁数が揃っているので、文字列のまま大小を比べられる。
-- 適用方法は README.md の「配信の記録」を参照。

-- 「次にアナウンスを送ってよい時刻」をチャンネルごとに1行で持つ。
-- アナウンス（POST /helix/chat/announcements）はそのエンドポイント自身の制限として2秒に1回しか送れないため、
-- 別々のEventSub通知が2秒以内に続いても間隔が空くよう、送る前にここで枠を確保する（worker/chat-store.ts の reserveAnnouncementSlot）。
-- 行は取り合いを避けるためだけにあり、アナウンスを送らなければ増えないので、古い行を消す必要はない。
CREATE TABLE announcement_slots (
  broadcaster_id TEXT PRIMARY KEY,
  next_available_at TEXT NOT NULL
) WITHOUT ROWID;
