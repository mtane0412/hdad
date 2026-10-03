-- 作業机の宣言に、打ち直す前の作業時間を足し込む列を追加する（作業した時間の合計。issue #209）
--
-- 適用方法は docs/guide/stats.md を参照。

-- task_declarations は1人1行で、!task を打ち直すと宣言した時刻を差し替える（0024）。そのままでは前の宣言で作業した時間が消えるので、
-- 打ち直すときに「前の宣言から完了まで（未完了なら打ち直した時刻まで）」のミリ秒をこの列へ足し込む（worker/task-desk-store.ts の declareTask）。
-- 同じ発言の再送では足し込まない。配信の合計は、この列といまの宣言の時間を行ごとに足して出す（worker/task-desk-worktime.ts の sumWorkTime）。
-- 既にある行は打ち直しの時間を記録していないので 0 から始める。
ALTER TABLE task_declarations ADD COLUMN prior_work_ms INTEGER NOT NULL DEFAULT 0;
