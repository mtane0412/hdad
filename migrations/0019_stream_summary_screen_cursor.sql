-- あらすじが画面の文字をどこまで材料にしたかの目印（issue #122 Phase 4）
--
-- 適用方法は docs/guide/stats.md を参照。
--
-- 0018 で積んだ「画面に新しく現れた文字」（screen_lines）も、発話・発言と同じくあらすじの材料になる。
-- あらすじは前回のものに積み上げて書き直させるので、材料ごとに「どこまで渡したか」を持ち、次に作るときは
-- その続きだけを読む（0010 の transcripts_until・chat_until と同じ形）。
--
-- 目印にするのは撮った時刻（captured_at）ではなく、篩を通して積んだ時刻（sifted_at）である。
-- OCRの取得は撮ってから遅れて起きるうえ、生成が間に合わない1枚は次の収集へ回るので、撮った順と
-- 積まれる順は一致しない。撮った時刻を目印にすると、遅れて積まれた1枚が目印より前に入り、
-- 一度も材料にならないまま保持期間で消える。積んだ順であれば、後から積まれた行も必ず目印より後ろに来る。
--
-- 組で持つのは、同じ時刻に積んだ行が読み出しの件数の上限で分かれたときに、残りが次からの
-- 「この時刻より後」に一度も入らず永久に漏れるためである（0010 の目印と同じ理由）。
-- 1枚の中の並び（line_no）まで持つのは、1枚から出た行が上限を超えたときに、その1枚の途中から
-- 読み直せるようにするためである（1枚ぶんを飛ばしてしまわないため）。
ALTER TABLE screen_lines ADD COLUMN sifted_at TEXT NOT NULL DEFAULT '';

-- 積んだ順での読み出し（あらすじ・サイドスーパーの材料）に効かせるための索引
CREATE INDEX screen_lines_sifted ON screen_lines (session_id, sifted_at, image_id, line_no);

-- 最後に材料にした行の、積んだ時刻・画像ID・1枚の中の並び。
-- 既にあるあらすじの行には空文字と -1 が入る。文字列比較では空文字が最小で、line_no は0から始まるので、
-- その配信の画面の文字は次に作り直すときに古いものから材料になる。
ALTER TABLE stream_summaries ADD COLUMN screen_until TEXT NOT NULL DEFAULT '';
ALTER TABLE stream_summaries ADD COLUMN screen_until_id TEXT NOT NULL DEFAULT '';
ALTER TABLE stream_summaries ADD COLUMN screen_until_line INTEGER NOT NULL DEFAULT -1;
