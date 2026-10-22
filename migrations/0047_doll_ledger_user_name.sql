-- 人形の台帳に、渡した相手の表示名を控える
--
-- 人形のランキングを合成ページに出すとき、名前が要る。台帳の鍵は Twitch のユーザーID だけで、視聴者の記録（viewers）を指さない
-- （発言していない人にもトリガーで渡すため）。そこで増減のたびに、その時点の表示名を控える。worker/doll-store.ts の changeDolls だけが書く。
-- この列を足す前の行は、発言したことのある人なら視聴者の記録の表示名で埋める。発言したことの無い人の行は NULL のまま残る
-- （ランキングでは視聴者の記録の表示名を先に使い、どちらも無ければ黙って飛ばさずエラーにする）。
-- 適用方法は docs/guide/stats.md を参照。
ALTER TABLE doll_ledger ADD COLUMN user_name TEXT;

UPDATE doll_ledger SET user_name = (SELECT display_name FROM viewers WHERE viewers.user_id = doll_ledger.user_id);
