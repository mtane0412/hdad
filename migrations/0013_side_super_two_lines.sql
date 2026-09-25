-- サイドスーパーを必ず2行（見出し・本文）にする
--
-- side_supers は「1行だけのサイドスーパーでは line2 に空文字を入れる」という作りだったが、
-- テレビのサイドスーパーと同じく上段＝コーナー名・下段＝いまの話題という役割に分けたため、
-- 行数は常に2行になった（worker/side-super.ts の SIDE_SUPER_LINES）。
--
-- 本文の無い古い行が残っていると、オーバーレイ（src/side-super/view.ts）が
-- 「2行でも0行でもない」として投げてしまう。サイドスーパーは配信の区切りごとの一時的な文言で、
-- cron（worker/collect.ts）が5分おきに作り直すため、消しても作り直される。
DELETE FROM side_supers WHERE line2 = '';
