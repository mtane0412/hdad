-- チャットで推理の解答（視聴者がチャンネルポイントの「解答」の報酬で送った答えと、その正誤。issue #377）
--
-- 日時は 0001〜0040 と同じく UTC の ISO 8601（例: 2026-10-15T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- redemption_id（Twitch の交換のID）が一意なので、同じ通知の再送では行を作れず、二重に照合しない。
-- 開催中のゲームがあるかどうかは、行を作る1つの文の中で決める（worker/chat-deduction-store.ts の reserveGuess）。
-- status は pending（照合待ち）・correct（正解。ゲームを終えた）・wrong（不正解）・rejected（受け付けなかった）。
-- correct と wrong は交換を FULFILLED にし、rejected は交換を CANCELED にしてポイントを返す。
-- reject_reason は受け付けなかった理由（no-game: 届いたときに開催中のゲームが無かった。
-- closed: 受けたあと照合するまでに、ほかの人の正解か配信者の打ち切りでゲームが終わった）。
-- game_id は開催中のゲームが無かった解答では NULL。0040 の質問と同じ理由で外部キーにはしない。
CREATE TABLE chat_deduction_guesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  redemption_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  guess TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'correct', 'wrong', 'rejected')),
  reject_reason TEXT CHECK (reject_reason IN ('no-game', 'closed')),
  guessed_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CHECK ((status = 'pending') = (settled_at IS NULL))
);

-- 正解者は1つのゲームに1人だけ（正解にする文の条件で決めるが、表の側でも守る）
CREATE UNIQUE INDEX chat_deduction_guesses_winner ON chat_deduction_guesses (game_id) WHERE status = 'correct';
