-- 「このチャンネルで初めての発言」「お久しぶり」の判定に要る2列（issue #62）
--
-- どちらもトリガーの条件（worker/alert-config.ts の firstChatEver・returningAfter）の判定に使う。
-- 判定は worker/viewer-store.ts の readChatHistory が読み取りだけで行い、書き込むのは
-- recordViewerMessage（発言の記録）と同じ1文である。
-- 適用方法は README.md の「配信の記録」を参照。

-- その人の記録を作った発言のID。
--
-- 「このチャンネルで初めての発言」を、同じ通知が再送されても同じ答えで返せるようにするための鍵である
-- （行ができたあとの2通目で「初めてではない」と答えてしまうと、1通目が途中で失敗していた場合に
-- アラートが鳴らなくなる。worker/chat-store.ts の first_chatters が message_id を持つのと同じ考え方）。
--
-- この列を足す前からある行には空文字が入る。空文字はどの発言のIDとも一致しないので、
-- 以前から記録のある人は「初めてではない」と判定される（常連に初見の挨拶が飛ばない）。
ALTER TABLE viewers ADD COLUMN first_message_id TEXT NOT NULL DEFAULT '';

-- last_seen_at を更新する直前の last_seen_at（その発言が空けた間隔の起点）。
--
-- 「最後の発言から何日空いているか」は、記録を更新したあとでは last_seen_at から読めないため、
-- 更新のたびに1つ前の値をここへ退避する。初めての発言で作った行と、この列を足す前からある行では NULL である。
ALTER TABLE viewers ADD COLUMN previous_seen_at TEXT;
