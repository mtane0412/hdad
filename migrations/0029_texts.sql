-- 配信者が自由に書いた文字（合成ページの素材「テキスト」に映すもの。issue #294）
--
-- 日時は 0001〜0028 と同じく UTC の ISO 8601（例: 2026-10-08T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- テキストを1件1行で持つ（worker/text-store.ts）。配信をまたいで残し、配信者が消すまで消さない。
-- KV ではなく D1 に置くのは、KV は書いた直後に古い値が返りうるためである（配信中に書き換えて押し出した直後に読み直すので）。
--
-- id は合成ページの素材のパラメータに入る。AUTOINCREMENT にして、消したテキストのIDを次のテキストに使い回させない
-- （素材が消えたテキストを指したまま、黙って別のテキストを映さないため。消えていれば素材の箱にエラーを出す）。
-- name は素材の選択欄に並べる名前で、重ねさせない。本文の文字数と行数の上限は worker/text.ts が検証する。
CREATE TABLE texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
