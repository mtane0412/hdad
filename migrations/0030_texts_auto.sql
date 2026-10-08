-- テキストを LLM に書き換えさせる（issue #295）
--
-- 適用方法は docs/guide/stats.md を参照。

-- mode: 本文の書き方。manual は配信者が手で書き、auto は指示文に沿って cron（worker/collect.ts）が LLM に書き直させる。
-- instruction: LLM に本文を書かせるときの指示文。手動のあいだも残す（自動へ戻したときにまた使うため）。
-- written_by: いまの本文を誰が書いたか（human は配信者、llm は自動の書き換え）。管理画面で見分けられるようにする（方針11）。
-- これまでのテキストはどれも配信者が手で書いたものなので、既定は manual・human にする。
ALTER TABLE texts ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'auto'));
ALTER TABLE texts ADD COLUMN instruction TEXT NOT NULL DEFAULT '';
ALTER TABLE texts ADD COLUMN written_by TEXT NOT NULL DEFAULT 'human' CHECK (written_by IN ('human', 'llm'));
