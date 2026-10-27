-- チャットで推理の制限時間（ゲームを始めてから設定の分数たっても正解者が出なければ、Worker が時間切れで終える）
--
-- 日時は 0001〜0048 と同じく UTC の ISO 8601 の文字列で持つ。適用方法は docs/guide/stats.md を参照。
--
-- closes_at は始めたときの制限時間の設定から決めた締め切りの時刻。制限時間をなしにして始めたゲームと、これより前のゲームは NULL。
-- 開催中に設定を変えても、始めたゲームの締め切りは変えない（視聴者に見せた残り時間を途中で変えないため）。
-- end_reason に timeout（制限時間が尽きた）を足す。SQLite は CHECK を書き換えられないので、表を作り直して移す
-- （chat_deduction_questions・chat_deduction_guesses の game_id は外部キーを持たないので、作り直しても参照は切れない）。
-- 読み書きは worker/chat-deduction-store.ts だけが行う。
CREATE TABLE chat_deduction_games_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('stopped', 'solved', 'timeout')),
  start_reward_id TEXT,
  closes_at TEXT,
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

INSERT INTO chat_deduction_games_new (id, problem_id, started_at, ended_at, end_reason, start_reward_id)
SELECT id, problem_id, started_at, ended_at, end_reason, start_reward_id FROM chat_deduction_games;

DROP TABLE chat_deduction_games;
ALTER TABLE chat_deduction_games_new RENAME TO chat_deduction_games;
