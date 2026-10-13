-- 章ごとのチャットの件数と発言者数（issue #352）
--
-- 配信の振り返りで「どの話題で反応があったか」を見るために、章（stream_chapters）の区間の中のチャットの件数と
-- 発言者数（重複を除いた人数）を章と一緒に残す。本文は残さず、数だけを残す。
--
-- 数えるのは章を保存するとき（worker/stream-chapter-store.ts の saveStreamChapter）で、材料の stream_chat_messages が
-- 人物像の作成や保持期間切れで消えるより前である（worker/collect.ts の処理順で保証する）。
--
-- この列より前に作った章は NULL のままにする（「記録なし」であって 0件ではない。材料の発言は既に消えていて数え直せない）。
ALTER TABLE stream_chapters ADD COLUMN chat_count INTEGER;
ALTER TABLE stream_chapters ADD COLUMN chatter_count INTEGER;
