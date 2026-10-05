-- 市町村紹介で紹介した市町村の記録（全国制覇マップ。issue #252）
--
-- 日時は 0001〜0026 と同じく UTC の ISO 8601（例: 2026-10-05T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 合成ページが紹介を流しきったら（配信者への振りまで流したら）1行書く（worker/town-tour-visits.ts の recordTownTourVisit）。
-- 試し再生と、紹介を作れなかった再生は書かない。
--
-- code は全国地方公共団体コードの5桁（src/town-tour/towns.json のコード）。1市町村1行なので、行の数は一覧の数（1,747）が上限になる。
-- 同じ市町村をもう一度紹介しても（全国制覇の後の2周目・合成ページを2つ開いていて2回届いた）、最初に紹介したときの行を残す。
-- occasion は紹介したきっかけ（raid か keyword）、user_name は冒頭で名前を出した相手（レイド元・キーワードを書いた人）の表示名。
-- 引くときにすべての行のコードを読み、紹介済みの市町村を除く。古い行も消さない（制覇の記録そのものであるため）。
CREATE TABLE town_tour_visits (
  code TEXT PRIMARY KEY,
  visited_at TEXT NOT NULL,
  occasion TEXT NOT NULL,
  user_name TEXT NOT NULL
) WITHOUT ROWID;
