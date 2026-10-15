-- チャットで推理のゲーム（視聴者がチャンネルポイントの質問で答えを絞り込み、解答で当てる。issue #375）
--
-- 日時は 0001〜0038 と同じく UTC の ISO 8601（例: 2026-10-15T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- 開催中のゲーム（ended_at が NULL）は1つだけで、開始のときに1つの文の中で確かめる（worker/chat-deduction-store.ts の startGame）。
-- problem_id は src/chat-deduction/problems.json の問題のID。問題集はリポジトリにあるので、ここには写さない。
-- end_reason は終わり方（stopped: 配信者が打ち切った。solved: 正解者が出た（issue #377））。終えたときにだけ入る。
CREATE TABLE chat_deduction_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('stopped', 'solved')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
