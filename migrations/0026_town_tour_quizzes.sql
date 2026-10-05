-- 市町村紹介の冒頭の都道府県当てクイズの出題と、最初の正解者（issue #251）
--
-- 日時は 0001〜0025 と同じく UTC の ISO 8601（例: 2026-10-05T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- 合成ページがクイズの場面を流しはじめたときに1行開き（worker/town-tour-quiz.ts の openTownTourQuiz）、
-- Webhook がチャットの発言を受けるたびに、受け付けている出題と照らす（answerTownTourQuiz）。
-- 最初の正解者を1人に決めるため、正解者の記録は「まだ正解者がいない行」だけを書き換える1つの文で行う。
--
-- id は Worker が呼び出しを押し出すときに付ける出題の識別子。合成ページを2つ開いていても同じ行を指す。
-- prefecture は正解の都道府県の正式な名前（src/town-tour/quiz.ts の answeredPrefectureOf が返す形）。
-- closes_at は回答を受け付ける最後の時刻（クイズの長さに、届くまでの遅れの余裕を足したもの）。
-- winner_name・answered_at は最初の正解者の表示名と、その時刻。正解者がいなければ NULL。
-- 1日より前の行は、次に出題を開いたときに消す。
CREATE TABLE town_tour_quizzes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  prefecture TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  winner_name TEXT,
  answered_at TEXT
) WITHOUT ROWID;

-- 受け付けている出題を、締め切りの時刻から引くための索引
CREATE INDEX town_tour_quizzes_closes_at ON town_tour_quizzes (closes_at);
