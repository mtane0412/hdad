/**
 * チャットで推理のゲームと質問と解答の読み書き（D1 の chat_deduction_games・chat_deduction_questions・chat_deduction_guesses。issue #375〜#377）
 *
 * 開催中のゲーム（ended_at が NULL）は1つだけで、開始のときに1つの文の中で確かめる（意見ボードのテーマと同じ形）。
 * 報酬をONにできなかったときに開始を無かったことにできるよう、開催中のゲームの行は消せる（cancelGame）。
 * 質問は、交換のIDを鍵に行を作るのと、受け付けるかどうか（開催中のゲーム・上限）の判断を1つの文で行う（reserveQuestion）。
 * 解答も交換のIDを鍵に行を作り（reserveGuess）、正解なら正解者を1人に決めてゲームを終えるまでを1つのトランザクションで行う（solveGame）。
 *
 * 注意: SQL はこのファイルだけが持ち、必ずプレースホルダを使う。
 */
import type { Database } from './database'

/** ゲームの終わり方（stopped: 配信者が打ち切った。solved: 正解者が出た） */
export type ChatDeductionEndReason = 'stopped' | 'solved'

/** ゲーム1つ */
export interface ChatDeductionGame {
  id: number
  /** src/chat-deduction/problems.json の問題のID */
  problemId: string
  startedAt: string
  /** 終えた時刻。開催中なら null */
  endedAt: string | null
  /** 終わり方。開催中なら null */
  endReason: ChatDeductionEndReason | null
}

const GAME_COLUMNS = 'id, problem_id AS problemId, started_at AS startedAt, ended_at AS endedAt, end_reason AS endReason'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 質問の状態（pending: 答え待ち。answered: 答えた。rejected: 受け付けなかった。failed: LLM が答えられなかった） */
export type ChatDeductionQuestionStatus = 'pending' | 'answered' | 'rejected' | 'failed'

/**
 * 質問を受け付けなかった理由（no-game: 開催中のゲームが無い。limit: 1問あたりの上限。
 * cooldown: 同じ人の待ち時間の内。待ち時間は廃止したので新しくは付けず、廃止前の行にだけ残る）
 */
export type ChatDeductionRejectReason = 'no-game' | 'limit' | 'cooldown'

/** 質問への答え（yes: はい。no: いいえ。unknown: 分からない） */
export type ChatDeductionVerdict = 'yes' | 'no' | 'unknown'

/** 視聴者が「質問」の報酬で送った交換 */
export interface ChatDeductionQuestionInput {
  /** Twitch の交換のID。再送で二重に答えないための鍵 */
  redemptionId: string
  userId: string
  userLogin: string
  userName: string
  /** 交換で書かれた質問（user_input） */
  question: string
}

/** 質問を受け付ける上限 */
export interface ChatDeductionQuestionLimits {
  /** 1問（ゲーム1つ）あたりに受け付ける質問の数 */
  maxQuestionsPerGame: number
}

/** 質問1件 */
export interface ChatDeductionQuestion {
  id: number
  /** 質問を受けたゲーム。開催中のゲームが無かったときは null */
  gameId: number | null
  redemptionId: string
  userId: string
  userLogin: string
  userName: string
  question: string
  status: ChatDeductionQuestionStatus
  /** 受け付けなかった理由。rejected のときだけ入る */
  rejectReason: ChatDeductionRejectReason | null
  /** はい・いいえ・分からない。answered のときだけ入る */
  verdict: ChatDeductionVerdict | null
  /** 答えに添える1文。answered のときだけ入る */
  reply: string | null
  /** 答えられなかった理由。failed のときだけ入る */
  failure: string | null
  askedAt: string
  /** 答えた・受け付けなかった・失敗した時刻。答え待ちなら null */
  settledAt: string | null
}

const QUESTION_COLUMNS = `id, game_id AS gameId, redemption_id AS redemptionId, user_id AS userId, user_login AS userLogin, user_name AS userName,
  question, status, reject_reason AS rejectReason, verdict, reply, failure, asked_at AS askedAt, settled_at AS settledAt`

/**
 * ゲームを始める。
 *
 * @param startRewardId トリガーのチャンネルポイントで始めたときの、その報酬のID（終えたら交換できるように戻す）。
 *   /chat-deduction/ のページから始めたときは null
 * @returns 作ったゲーム。ほかのゲームが開催中なら作らず null
 */
export const startGame = async (db: Database, problemId: string, now: number, startRewardId: string | null = null): Promise<ChatDeductionGame | null> =>
  db
    .prepare(
      `INSERT INTO chat_deduction_games (problem_id, started_at, start_reward_id)
       SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM chat_deduction_games WHERE ended_at IS NULL)
       RETURNING ${GAME_COLUMNS}`,
    )
    .bind(problemId, toIso(now), startRewardId)
    .first<ChatDeductionGame>()

/**
 * ゲームを始めたチャンネルポイントの報酬のIDを読む（startGame で控えたもの）。
 *
 * ゲームの形（ChatDeductionGame）には含めない。アプリのページと合成ページには要らず、報酬を切り替える Worker だけが読むため。
 *
 * @returns 報酬のID。ページから始めたゲームなら null
 * @throws そのIDのゲームが無い場合（呼び出し側の誤り）
 */
export const readGameStartReward = async (db: Database, id: number): Promise<string | null> => {
  const row = await db.prepare('SELECT start_reward_id AS startRewardId FROM chat_deduction_games WHERE id = ?1').bind(id).first<{ startRewardId: string | null }>()
  if (row === null) throw new Error(`チャットで推理のゲーム（${id}）がありません`)
  return row.startRewardId
}

/**
 * 開催中のゲームを終える。
 *
 * @returns 終えたゲーム。そのIDのゲームが無い・もう終えていれば null
 */
export const endGame = async (db: Database, id: number, reason: ChatDeductionEndReason, now: number): Promise<ChatDeductionGame | null> =>
  db
    .prepare(`UPDATE chat_deduction_games SET ended_at = ?2, end_reason = ?3 WHERE id = ?1 AND ended_at IS NULL RETURNING ${GAME_COLUMNS}`)
    .bind(id, toIso(now), reason)
    .first<ChatDeductionGame>()

/**
 * 開催中のゲームの行を消す。報酬をONにできず、ゲームを始められなかったときに使う（始まらなかったことにする）。
 *
 * 終えたゲームは消さない（記録として残す）。
 */
export const cancelGame = async (db: Database, id: number): Promise<void> => {
  await db.prepare('DELETE FROM chat_deduction_games WHERE id = ?1 AND ended_at IS NULL').bind(id).run()
}

/** 開催中のゲームを読む。開催中でなければ null */
export const readCurrentGame = async (db: Database): Promise<ChatDeductionGame | null> =>
  db.prepare(`SELECT ${GAME_COLUMNS} FROM chat_deduction_games WHERE ended_at IS NULL`).first<ChatDeductionGame>()

/** 最後に始めたゲームを読む（終えたものも含む）。一度も始めていなければ null */
export const readLatestGame = async (db: Database): Promise<ChatDeductionGame | null> =>
  db.prepare(`SELECT ${GAME_COLUMNS} FROM chat_deduction_games ORDER BY id DESC LIMIT 1`).first<ChatDeductionGame>()

/** IDでゲームを読む（終えたものも含む）。無ければ null */
export const readGame = async (db: Database, id: number): Promise<ChatDeductionGame | null> =>
  db.prepare(`SELECT ${GAME_COLUMNS} FROM chat_deduction_games WHERE id = ?1`).bind(id).first<ChatDeductionGame>()

/**
 * 質問の交換を受け、受け付けるかどうかを決めて行を作る。
 *
 * 受け付けるかどうかは次の順に、行を作るのと同じ1つの文の中で決める（同時に届いた交換が上限を越えて通らないようにするため）。
 * 1. 開催中のゲームが無い → no-game
 * 2. そのゲームの答え待ち・答えた質問が上限に達している → limit
 * 受け付けなかった質問と答えられなかった質問（failed）はポイントを返すので、上限に数えない。
 * 同じ人が続けて質問しても受け付ける（待ち時間は設けない）。
 *
 * @returns 作った質問（受け付けたなら pending、受け付けなかったなら rejected）。同じ交換のIDの行がもうあれば（再送）null
 */
export const reserveQuestion = async (
  db: Database,
  input: ChatDeductionQuestionInput,
  { maxQuestionsPerGame }: ChatDeductionQuestionLimits,
  now: number,
): Promise<ChatDeductionQuestion | null> =>
  db
    .prepare(
      `INSERT INTO chat_deduction_questions (game_id, redemption_id, user_id, user_login, user_name, question, status, reject_reason, asked_at, settled_at)
       SELECT judged.game_id, ?1, ?2, ?3, ?4, ?5,
              CASE WHEN judged.reason IS NULL THEN 'pending' ELSE 'rejected' END, judged.reason,
              ?6, CASE WHEN judged.reason IS NULL THEN NULL ELSE ?6 END
       FROM (
         SELECT game.id AS game_id,
                CASE
                  WHEN game.id IS NULL THEN 'no-game'
                  WHEN (SELECT COUNT(*) FROM chat_deduction_questions AS asked
                        WHERE asked.game_id = game.id AND asked.status IN ('pending', 'answered')) >= ?7 THEN 'limit'
                END AS reason
         FROM (SELECT 1) AS one LEFT JOIN chat_deduction_games AS game ON game.ended_at IS NULL
       ) AS judged
       WHERE true
       ON CONFLICT (redemption_id) DO NOTHING
       RETURNING ${QUESTION_COLUMNS}`,
    )
    .bind(input.redemptionId, input.userId, input.userLogin, input.userName, input.question, toIso(now), maxQuestionsPerGame)
    .first<ChatDeductionQuestion>()

/**
 * 答え待ちの質問に答えを書き、答えた（answered）にする。
 *
 * @returns 書いた質問。答え待ちでなければ（受け付けなかった・もう答えた）何も書かず null
 */
export const answerQuestion = async (
  db: Database,
  id: number,
  { verdict, reply }: { verdict: ChatDeductionVerdict; reply: string },
  now: number,
): Promise<ChatDeductionQuestion | null> =>
  db
    .prepare(
      `UPDATE chat_deduction_questions SET status = 'answered', verdict = ?2, reply = ?3, settled_at = ?4
       WHERE id = ?1 AND status = 'pending' RETURNING ${QUESTION_COLUMNS}`,
    )
    .bind(id, verdict, reply, toIso(now))
    .first<ChatDeductionQuestion>()

/**
 * ゲームでこれまでに答えた（answered）質問の数を数える。
 *
 * 質問に答えるときの手がかりの段階（worker/chat-deduction-answer.ts の chatDeductionHintLevelOf）に使う。
 * 答え待ち・失敗・受け付けなかった質問は、視聴者が答えを見ていないので数えない。
 */
export const countAnsweredQuestions = async (db: Database, gameId: number): Promise<number> => {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM chat_deduction_questions WHERE game_id = ?1 AND status = 'answered'`)
    .bind(gameId)
    .first<{ count: number }>()
  if (row === null) throw new Error(`ゲーム（${gameId}）の答えた質問を数えられませんでした`)
  return row.count
}

/**
 * 答え待ちの質問を、理由を添えて失敗（failed）にする。
 *
 * @returns 書いた質問。答え待ちでなければ何も書かず null
 */
export const failQuestion = async (db: Database, id: number, failure: string, now: number): Promise<ChatDeductionQuestion | null> =>
  db
    .prepare(`UPDATE chat_deduction_questions SET status = 'failed', failure = ?2, settled_at = ?3 WHERE id = ?1 AND status = 'pending' RETURNING ${QUESTION_COLUMNS}`)
    .bind(id, failure, toIso(now))
    .first<ChatDeductionQuestion>()

/** 解答の状態（pending: 照合待ち。correct: 正解。wrong: 不正解。rejected: 受け付けなかった） */
export type ChatDeductionGuessStatus = 'pending' | 'correct' | 'wrong' | 'rejected'

/** 解答を受け付けなかった理由（no-game: 届いたときに開催中のゲームが無い。closed: 照合するまでにゲームが終わった） */
export type ChatDeductionGuessRejectReason = 'no-game' | 'closed'

/** 視聴者が「解答」の報酬で送った交換 */
export interface ChatDeductionGuessInput {
  /** Twitch の交換のID。再送で二重に照合しないための鍵 */
  redemptionId: string
  userId: string
  userLogin: string
  userName: string
  /** 交換で書かれた解答（user_input） */
  guess: string
}

/** 解答1件 */
export interface ChatDeductionGuess {
  id: number
  /** 解答を受けたゲーム。開催中のゲームが無かったときは null */
  gameId: number | null
  redemptionId: string
  userId: string
  userLogin: string
  userName: string
  guess: string
  status: ChatDeductionGuessStatus
  /** 受け付けなかった理由。rejected のときだけ入る */
  rejectReason: ChatDeductionGuessRejectReason | null
  guessedAt: string
  /** 正誤を決めた・受け付けなかった時刻。照合待ちなら null */
  settledAt: string | null
}

const GUESS_COLUMNS = `id, game_id AS gameId, redemption_id AS redemptionId, user_id AS userId, user_login AS userLogin, user_name AS userName,
  guess, status, reject_reason AS rejectReason, guessed_at AS guessedAt, settled_at AS settledAt`

/**
 * 解答の交換を受けて行を作る。開催中のゲームがあれば照合待ち（pending）、無ければ理由 no-game で受け付けなかった（rejected）にする。
 *
 * @returns 作った解答。同じ交換のIDの行がもうあれば（再送）null
 */
export const reserveGuess = async (db: Database, input: ChatDeductionGuessInput, now: number): Promise<ChatDeductionGuess | null> =>
  db
    .prepare(
      `INSERT INTO chat_deduction_guesses (game_id, redemption_id, user_id, user_login, user_name, guess, status, reject_reason, guessed_at, settled_at)
       SELECT game.id, ?1, ?2, ?3, ?4, ?5,
              CASE WHEN game.id IS NULL THEN 'rejected' ELSE 'pending' END, CASE WHEN game.id IS NULL THEN 'no-game' END,
              ?6, CASE WHEN game.id IS NULL THEN ?6 END
       FROM (SELECT 1) AS one LEFT JOIN chat_deduction_games AS game ON game.ended_at IS NULL
       WHERE true
       ON CONFLICT (redemption_id) DO NOTHING
       RETURNING ${GUESS_COLUMNS}`,
    )
    .bind(input.redemptionId, input.userId, input.userLogin, input.userName, input.guess, toIso(now))
    .first<ChatDeductionGuess>()

/**
 * 照合待ちの解答を不正解（wrong）にする。
 *
 * @returns 書いた解答。照合待ちでなければ何も書かず null
 */
export const markGuessWrong = async (db: Database, id: number, now: number): Promise<ChatDeductionGuess | null> =>
  db
    .prepare(`UPDATE chat_deduction_guesses SET status = 'wrong', settled_at = ?2 WHERE id = ?1 AND status = 'pending' RETURNING ${GUESS_COLUMNS}`)
    .bind(id, toIso(now))
    .first<ChatDeductionGuess>()

/**
 * 照合して正解だった解答で、ゲームを終える。
 *
 * 次の3つの文を1つのトランザクション（batch）で行う。
 * 1. 解答を受けたゲームがまだ開催中なら、解答を正解（correct）にする（ここで正解者が1人に決まる。先に正解した人がいれば、
 *    その時点でゲームは終わっているので正解にならない）
 * 2. 解答が正解になったなら、そのゲームを solved で終える
 * 3. 正解にならなかった（照合待ちのまま残った）なら、理由 closed で受け付けなかった（rejected）にする
 *
 * @returns 書いたあとの解答（correct か rejected）
 * @throws 解答の行が無い場合（呼び出し側の誤り）
 */
export const solveGame = async (db: Database, id: number, now: number): Promise<ChatDeductionGuess> => {
  const settledAt = toIso(now)
  await db.batch([
    db
      .prepare(
        `UPDATE chat_deduction_guesses SET status = 'correct', settled_at = ?2
         WHERE id = ?1 AND status = 'pending'
           AND EXISTS (SELECT 1 FROM chat_deduction_games AS game WHERE game.id = chat_deduction_guesses.game_id AND game.ended_at IS NULL)`,
      )
      .bind(id, settledAt),
    db
      .prepare(
        `UPDATE chat_deduction_games SET ended_at = ?2, end_reason = 'solved'
         WHERE ended_at IS NULL AND id = (SELECT game_id FROM chat_deduction_guesses WHERE id = ?1 AND status = 'correct')`,
      )
      .bind(id, settledAt),
    db.prepare(`UPDATE chat_deduction_guesses SET status = 'rejected', reject_reason = 'closed', settled_at = ?2 WHERE id = ?1 AND status = 'pending'`).bind(id, settledAt),
  ])
  const guess = await db.prepare(`SELECT ${GUESS_COLUMNS} FROM chat_deduction_guesses WHERE id = ?1`).bind(id).first<ChatDeductionGuess>()
  if (guess === null) throw new Error(`チャットで推理の解答（${id}）がありません`)
  return guess
}

/** 合成ページに並べるカード1枚（答えた質問か、正誤を決めた解答） */
export type ChatDeductionCard =
  | { kind: 'question'; id: number; userName: string; text: string; verdict: ChatDeductionVerdict; reply: string }
  | { kind: 'guess'; id: number; userName: string; text: string; correct: boolean }

/** readGameCards の1行。質問と解答を1つの問い合わせで読むため、使わない列は NULL になる */
interface CardRow {
  kind: 'question' | 'guess'
  id: number
  userName: string
  text: string
  verdict: ChatDeductionVerdict | null
  reply: string | null
  status: string
}

/**
 * ゲームの、合成ページに並べるカードを読む（issue #378）。
 *
 * 並べるのは答えた質問（answered）と正誤を決めた解答（correct・wrong）だけで、答え・正誤を決めた順（settled_at）に並べる。
 * 答え待ち・照合待ちと、ポイントを返したもの（受け付けなかった・答えられなかった）は映さない。
 *
 * @throws 答えた質問に答えが無い場合（書き込みの誤り。黙って空の答えを映さない）
 */
export const readGameCards = async (db: Database, gameId: number): Promise<ChatDeductionCard[]> => {
  const { results } = await db
    .prepare(
      `SELECT 'question' AS kind, id, user_name AS userName, question AS text, verdict, reply, status, settled_at AS settledAt
       FROM chat_deduction_questions WHERE game_id = ?1 AND status = 'answered'
       UNION ALL
       SELECT 'guess' AS kind, id, user_name AS userName, guess AS text, NULL AS verdict, NULL AS reply, status, settled_at AS settledAt
       FROM chat_deduction_guesses WHERE game_id = ?1 AND status IN ('correct', 'wrong')
       ORDER BY settledAt, kind DESC, id`,
    )
    .bind(gameId)
    .all<CardRow>()
  return results.map(({ kind, id, userName, text, verdict, reply, status }): ChatDeductionCard => {
    if (kind === 'guess') return { kind, id, userName, text, correct: status === 'correct' }
    if (verdict === null || reply === null) throw new Error(`答えた質問（${id}）に答えがありません`)
    return { kind, id, userName, text, verdict, reply }
  })
}
