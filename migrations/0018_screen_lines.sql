-- 画面に新しく現れた文字（issue #122 Phase 3）
--
-- 適用方法は docs/guide/stats.md を参照。
--
-- 0017 で貯めた読み取った文字（screen_captures.ocr_text）を篩（worker/screen-ocr.ts）に通し、
-- 残った行だけをここに積む。LLM へ渡すのはこの行であって、読み取った文字そのものではない。
--
-- 行を別の表に持つのは、篩の3段目（既出の除去）が「その配信で既に渡した行」と照らすためである。
-- 読み取った文字のまま持つと、同じ画面を撮り続けたぶんの重複を毎回読み直すことになる。
--
-- line_no は1枚の中での並び（0から）である。image_id との組を主キーにするのは、同じ1枚を二度篩に
-- かけても行が増えないようにするためで、screen_captures が image_id を主キーにしているのと同じ理由による。
CREATE TABLE screen_lines (
  image_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (image_id, line_no)
);

-- 材料の読み出し（配信ごとに、画面に現れた順）と、既出の照合に効かせるための索引
CREATE INDEX screen_lines_session ON screen_lines (session_id, captured_at, image_id);

-- 古い行の掃除（日時での絞り込み）に効かせるための索引
CREATE INDEX screen_lines_captured_at ON screen_lines (captured_at);

-- 篩に通し終えた時刻。NULL なら「読み取った文字はあるが、まだ篩に通していない」である。
-- 残った行が0行のときにも時刻を入れるので、screen_lines に行があるかどうかでは代用できない
-- （同じ画面を撮り続けるあいだ、篩を通った行は0行になるのが普通である）。
ALTER TABLE screen_captures ADD COLUMN sifted_at TEXT;

-- まだ篩に通していない行の引き出し（cron が5分おきに行う）に効かせるための索引。
-- 部分索引にするのは、通し終えた行が積み上がっても索引が太らないようにするためである
CREATE INDEX screen_captures_pending_sift ON screen_captures (captured_at) WHERE ocr_text IS NOT NULL AND sifted_at IS NULL;
