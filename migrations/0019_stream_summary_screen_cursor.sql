-- あらすじが画面の文字をどこまで材料にしたかの目印（issue #122 Phase 4）
--
-- 適用方法は docs/guide/stats.md を参照。
--
-- 0018 で積んだ「画面に新しく現れた文字」（screen_lines）も、発話・発言と同じくあらすじの材料になる。
-- あらすじは前回のものに積み上げて書き直させるので、材料ごとに「どこまで渡したか」を持ち、次に作るときは
-- その続きだけを読む（0010 の transcripts_until・chat_until と同じ形）。
--
-- 目印を日時だけにしないのは、同じ時刻に撮った1枚が件数の上限で分かれると、残りが次からの「この日時より後」に
-- 一度も入らず永久に漏れるためである。読む順（撮った時刻・画像IDの順）と同じ組で比べる。
-- 1枚の中の並び（line_no）は目印に持たない。篩（worker/screen-ocr.ts）は1枚ぶんの行をまとめて積むので、
-- 材料にするのも1枚ぶんまとめてであり、1枚の途中で切れることがないためである。
--
-- 既にあるあらすじの行には空文字が入る。文字列比較では空文字が最小なので、その配信の画面の文字は
-- 次に作り直すときに古いものから材料になる。
ALTER TABLE stream_summaries ADD COLUMN screen_until TEXT NOT NULL DEFAULT '';
ALTER TABLE stream_summaries ADD COLUMN screen_until_id TEXT NOT NULL DEFAULT '';
