-- 配信タイトルの候補の記録を消す（issue #268 で廃止）
--
-- 0028 で作った stream_title_candidates は、配信タイトルの候補（試験運用）を章ごとに残す表だった。
-- 試験運用の結果は issue #268 のコメントにまとめたうえで機能ごと廃止したので、読み書きする箇所がなくなった表を消す。
-- 経緯は docs/decisions/stream-title.md を参照。
DROP TABLE IF EXISTS stream_title_candidates;
