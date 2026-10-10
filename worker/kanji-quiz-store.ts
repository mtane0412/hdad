/**
 * 漢字クイズの出題と、最初の正解者の記録（issue #301）
 *
 * Worker が問題を選んだら押し出す前に出題の行を入れ（recordKanjiQuiz）、合成ページが流しはじめたら受け付ける時刻を書き（openKanjiQuiz）、
 * Webhook がチャットの発言を受けるたびに受け付けている出題と照らして、最初に正解した人を決める（answerKanjiQuiz）。
 * 同じ配信で出した問題を選ばないよう、配信中に選んだ熟語も読み出す（readUsedKanjiQuizWords）。
 * テーブルの定義は migrations/0031_kanji_quizzes.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: 正解者の判定は SQLite の RETURNING を使い、1つの文の中で「書けたかどうか」を受け取る（town-tour-quiz.ts と同じ考え方）。
 * 「読んでから書く」に分けると、ほぼ同時に届いた2人の正解がどちらも最初の正解者になってしまう。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import { ANSWER_LIMIT_MS, GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
import type { Database } from './database'

/**
 * 回答を受け付ける長さに足す余裕（ミリ秒）。発言が Twitch から Worker に届くまでの遅れの分だけ、
 * 合成ページで時間切れになる直前に書かれた回答を取りこぼさないようにする（市町村紹介のクイズの QUIZ_GRACE_MS と同じ値）
 */
export const KANJI_QUIZ_GRACE_MS = 2000

/** 出題を残しておく期間（ミリ秒）。同じ配信で出したかの判定に使うので、長い配信でも足りるよう7日にする */
const KANJI_QUIZ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** いま配信中の配信が始まった時刻。stream_sessions の配信中の区切り（ended_at が NULL）のうち、いちばん新しいもの */
const CURRENT_SESSION_STARTED_AT = 'SELECT started_at FROM stream_sessions WHERE ended_at IS NULL AND started_at <= ?1 ORDER BY started_at DESC LIMIT 1'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 選んだ出題 */
export interface KanjiQuizRecord {
  /** 出題の識別子（呼び出しの id） */
  readonly id: string
  /** 出題した熟語 */
  readonly word: string
}

/**
 * 選んだ出題の行を入れる。まだ回答は受け付けない（合成ページが流しはじめて openKanjiQuiz を呼ぶまで）。
 * あわせて、古い出題（7日より前）を消して増え続けないようにする。
 */
export const recordKanjiQuiz = async (db: Database, quiz: KanjiQuizRecord, now: number): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM kanji_quizzes WHERE issued_at < ?1').bind(toIso(now - KANJI_QUIZ_RETENTION_MS)),
    db.prepare('INSERT INTO kanji_quizzes (id, word, issued_at) VALUES (?1, ?2, ?3)').bind(quiz.id, quiz.word, toIso(now)),
  ])
}

/**
 * 合成ページが流しはじめた出題を開く。級を出し終えて熟語が出たときから、制限時間と遅れの余裕のあいだ回答を受け付ける。
 * 同じ出題がもう開いていれば、受け付ける時刻を変えない（合成ページを2つ開いていても長さを延ばさない）。
 *
 * @param now 合成ページが流しはじめた時刻（Worker が受けた時刻で代える。届くまでの遅れは余裕に含める）
 * @returns 開けたか。選んでいない出題の識別子なら false（合成ページから熟語を受け取って行を作らない）
 */
export const openKanjiQuiz = async (db: Database, id: string, now: number): Promise<boolean> => {
  const acceptsFrom = now + GRADE_INTRO_MS
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET accepts_from = COALESCE(accepts_from, ?2), closes_at = COALESCE(closes_at, ?3)
       WHERE id = ?1
       RETURNING id`,
    )
    .bind(id, toIso(acceptsFrom), toIso(acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS))
    .all<{ id: string }>()
  return results.length > 0
}

/**
 * チャットの回答を、受け付けている出題と照らす。回答の読みを持つ熟語の出題で、まだ正解者がいなければ、この人を正解者にする。
 *
 * @param answer 回答の読みを持つ熟語（kanji-quiz-answer.ts の wordsAnsweredBy）と、回答した人の表示名
 * @returns この回答で正解者が決まった出題の識別子。正解者にならなかったら空
 */
export const answerKanjiQuiz = async (db: Database, answer: { words: readonly string[]; userName: string }, now: number): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET winner_name = ?1, answered_at = ?2
       WHERE word IN (SELECT value FROM json_each(?3)) AND winner_name IS NULL AND accepts_from <= ?2 AND closes_at > ?2
       RETURNING id`,
    )
    .bind(answer.userName, toIso(now), JSON.stringify(answer.words))
    .all<{ id: string }>()
  return results.map(({ id }) => id)
}

/**
 * いまの配信が始まってから選んだ出題の熟語を読む。配信していなければ空（外すものが無い）。
 */
export const readUsedKanjiQuizWords = async (db: Database, now: number): Promise<ReadonlySet<string>> => {
  const { results } = await db
    .prepare(`SELECT DISTINCT word FROM kanji_quizzes WHERE issued_at >= (${CURRENT_SESSION_STARTED_AT})`)
    .bind(toIso(now))
    .all<{ word: string }>()
  return new Set(results.map(({ word }) => word))
}
