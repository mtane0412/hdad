-- 配信画面の隅に出すテロップ「サイドスーパー」
--
-- 日時は 0001〜0010 と同じく UTC の ISO 8601（例: 2026-09-24T12:00:00.000Z）の文字列で持つ。
-- 適用方法は README.md の「配信の記録」を参照。

-- いま進んでいる配信のサイドスーパー。cron（worker/collect.ts）が5分おきに作り直し、
-- オーバーレイ（side-super/index.html）が GET /api/overlay/side-super で読み出して映す。
--
-- 配信ごとに1行だけ持つ（session_id が主キー）。配信が変われば行も別になるので、
-- 前の配信の文言が次の配信に持ち越されることはない（stream_summaries と同じ作り）。
--
-- あらすじ（stream_summaries）と違って前回のものに積み上げないので、「どこまでを材料にしたか」の
-- 目印は持たない。毎回その時点の直近の材料から作り直す（worker/side-super.ts）。
--
-- 行は列に分けて持つ（1行あたりの文字数に上限がある表示なので、行の区切りが値の中の改行に埋もれないようにする）。
-- 2行目が無いサイドスーパーでは line2 に空文字を入れる。
CREATE TABLE side_supers (
  session_id TEXT PRIMARY KEY,
  line1 TEXT NOT NULL,
  line2 TEXT NOT NULL,
  -- この文言を作った日時。オーバーレイが「いつ時点か」を読めるようにするために持つ
  updated_at TEXT NOT NULL
);
