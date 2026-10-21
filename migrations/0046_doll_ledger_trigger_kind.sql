-- 人形の台帳に、トリガーで渡したときのトリガーの項目を控える（issue #419）
--
-- trigger_kind は、理由（reason）が trigger の行で、どのトリガーの項目（worker/trigger-menu.ts の TriggerKind。reward・raid など）で
-- 渡したかを持つ。トリガーは一覧の中の位置でしか見分けられず、位置は設定を並べ替えると変わるので、変わらない項目の種類を控える。
-- trigger 以外の理由の行では NULL のまま持つ。種類は今後も増えるので CHECK にせず、worker/doll-store.ts の changeDolls だけが書く。
-- 適用方法は docs/guide/stats.md を参照。
ALTER TABLE doll_ledger ADD COLUMN trigger_kind TEXT;
