-- 意見ボードの段階4（配信後のまとめ。issue #309）
--
-- 日時は 0001〜0034 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。

-- 締め切ったテーマの「合意が見える点・意見が分かれた点・残った問い」。LLM（箇所 opinionSummary）が作った機械のまとめで、
-- 配信者のメモとは別に持つ（アプリのページでは「AIのまとめ」として分けて出す）。1つのテーマに1つだけで、作り直したら置き換える。
-- 各欄は短い文の JSON 配列（worker/opinion-summary.ts が数と文字数を照合してから書く）。人数は持たない。
-- 締め切ったテーマにだけ書く（worker/opinion-store.ts の saveThemeSummary）。作れなかったときは行を作らない（失敗は collection_failures に残す）。
CREATE TABLE opinion_summaries (
  theme_id INTEGER PRIMARY KEY REFERENCES opinion_themes (id),
  agreements TEXT NOT NULL,
  disagreements TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  created_at TEXT NOT NULL
);
