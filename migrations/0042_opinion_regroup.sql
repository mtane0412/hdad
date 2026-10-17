-- 意見ボードの論点の作り直し（集まった意見の全体から、論点を分け直して名前を付け直す。issue #402）
--
-- 日時は 0001〜0041 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。

-- 最後に作り直しを引き受けたときの、テーマの意見の数（隠したものも含む）。意見がこの数から決まった数だけ増えたら作り直す
-- （worker/opinion-store.ts の claimRegroup）。作り直しに失敗しても戻さない（同じ盤面で失敗し続けて無料枠を食わないため）。
ALTER TABLE opinion_themes ADD COLUMN regrouped_opinions INTEGER NOT NULL DEFAULT 0;

-- 配信者が名前を変えた・まとめ先にした論点か。1なら、作り直しで対応しても名前を変えない（worker/opinion-regroup.ts の planRegrouping）。
ALTER TABLE opinion_topics ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0 CHECK (title_locked IN (0, 1));
