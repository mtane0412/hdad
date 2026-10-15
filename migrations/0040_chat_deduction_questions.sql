-- チャットで推理の質問（視聴者がチャンネルポイントの「質問」の報酬で送った問いと、LLM の答え。issue #376）
--
-- 日時は 0001〜0039 と同じく UTC の ISO 8601（例: 2026-10-15T12:00:00.000Z）の文字列で持つ。
-- 適用方法は docs/guide/stats.md を参照。
--
-- redemption_id（Twitch の交換のID）が一意なので、同じ通知の再送では行を作れず、二重に答えない。
-- 受け付けるかどうか（開催中のゲーム・1問あたりの上限・同じ人の待ち時間）は、行を作る1つの文の中で決める
-- （worker/chat-deduction-store.ts の reserveQuestion）。
-- status は pending（答え待ち）・answered（答えた。交換を FULFILLED にする）・rejected（受け付けなかった）・
-- failed（LLM が答えられなかった）。rejected と failed は交換を CANCELED にしてポイントを返す。
-- reject_reason は受け付けなかった理由（no-game: 開催中のゲームが無い。limit: 1問あたりの上限。cooldown: 同じ人の待ち時間の内）。
-- game_id は開催中のゲームが無かった質問では NULL。開始を取り消したゲーム（cancelGame）の行を消せるよう、外部キーにはしない。
CREATE TABLE chat_deduction_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER,
  redemption_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_name TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'rejected', 'failed')),
  reject_reason TEXT CHECK (reject_reason IN ('no-game', 'limit', 'cooldown')),
  verdict TEXT CHECK (verdict IN ('yes', 'no', 'unknown')),
  reply TEXT,
  failure TEXT,
  asked_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CHECK ((status = 'answered') = (verdict IS NOT NULL AND reply IS NOT NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK ((status = 'pending') = (settled_at IS NULL))
);

-- 上限と待ち時間の確かめで、ゲームごと・人ごとの質問を引く
CREATE INDEX chat_deduction_questions_game ON chat_deduction_questions (game_id, user_id);
