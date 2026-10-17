-- 締め切った意見ボードの片付け（下部バーの「演出を消す」で、合成ページから締め切ったボードを下げる）
--
-- 日時は 0001〜0042 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。

-- 締め切ったテーマを合成ページから片付けた日時。片付けていなければ NULL。
-- 最後に開いたテーマがこれを持てば、合成ページへは何も映さない（worker/opinion-store.ts の readOverlayBoard）。
-- 開いているテーマには書かない（視聴者への問いかけを消さないため。dismissClosedTheme）。
ALTER TABLE opinion_themes ADD COLUMN dismissed_at TEXT;
