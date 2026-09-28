-- 配信画面から読み取った文字（issue #122 Phase 2）
--
-- 適用方法は docs/guide/stats.md を参照。
--
-- 0016 で残した1枚ごとの記録（screen_captures）に、Gyazo が作るOCRのテキストを書き戻す場所を足す。
-- 上げた直後は生成が終わっていないので（実測で約10〜13秒）、上げるときには取らず、cron が5分おきに
-- まとめて取りに行く（worker/collect.ts）。
--
-- ocr_text が NULL なのは「まだ取れていない」で、空文字は「取りに行って、文字が1つも写っていなかった」である。
-- 両者を分けるのは、前者だけを取りに行き直すためである。
--
-- ocr_attempts は取りに行って空で返った回数である。Gyazo の生成が何らかの理由で終わらない画像を
-- いつまでも取りに行き続けないための歯止めであり、上限に達した行はもう取りに行かない
-- （worker/screen-store.ts の OCR_MAX_ATTEMPTS）。
ALTER TABLE screen_captures ADD COLUMN ocr_text TEXT;
ALTER TABLE screen_captures ADD COLUMN ocr_attempts INTEGER NOT NULL DEFAULT 0;

-- まだ取れていない行の引き出し（cron が5分おきに行う）に効かせるための索引。
-- 部分索引にするのは、取れた行が積み上がっても索引が太らないようにするためである
CREATE INDEX screen_captures_pending_ocr ON screen_captures (captured_at) WHERE ocr_text IS NULL;
