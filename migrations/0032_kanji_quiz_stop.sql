-- 漢字クイズの時間切れで配信を止める（issue #302）
--
-- 日時は 0001〜0031 と同じく UTC の ISO 8601（例: 2026-10-10T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- 時間切れ（正解者なし）を Worker が確かめたら stop_at に配信を止める時刻（猶予の終わり）を書き（worker/kanji-quiz-store.ts の beginKanjiQuizStop）、
-- 猶予のあいだに下部バーで取り消されたら stop_cancelled_at を書く（cancelKanjiQuizStops）。猶予が尽きたら、取り消されていない行だけ
-- stop_sent_at を書いてから裏方へ停止の命令を送る（claimKanjiQuizStop）。どれも「まだ書かれていない行」だけを書き換える1つの文で行うので、
-- 取り消しと停止が同時に来ても、どちらか一方しか通らない。同じ出題で2回止めることもない。
--
-- rehearsal は管理画面の試し再生で出した出題なら 1。試し再生は猶予の演出までは流すが、配信は止めない（stop_sent_at を書かない）。
ALTER TABLE kanji_quizzes ADD COLUMN rehearsal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kanji_quizzes ADD COLUMN stop_at TEXT;
ALTER TABLE kanji_quizzes ADD COLUMN stop_cancelled_at TEXT;
ALTER TABLE kanji_quizzes ADD COLUMN stop_sent_at TEXT;
