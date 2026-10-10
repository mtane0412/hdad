-- 漢字クイズの出題と、最初の正解者（issue #301）
--
-- 日時は 0001〜0030 と同じく UTC の ISO 8601（例: 2026-10-10T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。

-- Worker が問題を選んで合成ページへ押し出す前に1行入れ（worker/kanji-quiz-store.ts の recordKanjiQuiz）、
-- 合成ページが流しはじめたら受け付ける時刻を書き（openKanjiQuiz）、Webhook がチャットの発言を受けるたびに、
-- 受け付けている出題と照らす（answerKanjiQuiz）。同じ配信で出した問題を選ばないためにも、この行を読む（readUsedKanjiQuizWords）。
-- 最初の正解者を1人に決めるため、正解者の記録は「まだ正解者がいない行」だけを書き換える1つの文で行う。
--
-- id は Worker が呼び出しを押し出すときに付ける出題の識別子。合成ページを2つ開いていても同じ行を指す。
-- word は出題した熟語（src/kanji-quiz/problems.json の word）。正解の読みは問題集から引くので、ここには持たない。
-- issued_at は Worker が問題を選んだ時刻（同じ配信で出したかの判定に使う）。
-- accepts_from・closes_at は回答を受け付ける最初と最後の時刻（熟語が出てから、制限時間に届くまでの遅れの余裕を足したところまで）。
-- 合成ページがまだ流していない（開いていない）行では NULL。
-- winner_name・answered_at は最初の正解者の表示名と、その時刻。正解者がいなければ NULL。
-- 7日より前の行は、次に出題を選んだときに消す。
CREATE TABLE kanji_quizzes (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  accepts_from TEXT,
  closes_at TEXT,
  winner_name TEXT,
  answered_at TEXT
) WITHOUT ROWID;

-- 受け付けている出題を、締め切りの時刻から引くための索引
CREATE INDEX kanji_quizzes_closes_at ON kanji_quizzes (closes_at);
-- 同じ配信で出した問題を、選んだ時刻から引くための索引
CREATE INDEX kanji_quizzes_issued_at ON kanji_quizzes (issued_at);
