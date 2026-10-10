/**
 * 漢字クイズの出題と、最初の正解者の記録（issue #301）
 *
 * Worker が問題を選んだら押し出す前に出題の行を入れ（recordKanjiQuiz）、合成ページが流しはじめたら受け付ける時刻を書き（openKanjiQuiz）、
 * Webhook がチャットの発言を受けるたびに受け付けている出題と照らして、最初に正解した人を決める（answerKanjiQuiz）。
 * 同じ配信で出した問題を選ばないよう、配信中に選んだ熟語と選んだ回数も読み出す（readKanjiQuizWordCounts）。
 * 時間切れ（正解者なし）で配信を止める流れ（issue #302）の状態もこの行に持つ。停止を始め（beginKanjiQuizStop）、
 * 猶予のあいだに取り消されなければ、鍵を確保してから止める（claimKanjiQuizStop）。取り消しは cancelKanjiQuizStops。
 * テーブルの定義は migrations/0031_kanji_quizzes.sql と 0032_kanji_quiz_stop.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: 正解者の判定は SQLite の RETURNING を使い、1つの文の中で「書けたかどうか」を受け取る（town-tour-quiz.ts と同じ考え方）。
 * 「読んでから書く」に分けると、ほぼ同時に届いた2人の正解がどちらも最初の正解者になってしまう。
 * 注意: 停止の開始・取り消し・鍵の確保も、それぞれ「まだ書かれていない行」だけを書き換える1つの文にする。取り消しと停止が同時に来ても
 * どちらか一方しか通らず、同じ出題で2回止めない。
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
  /** 管理画面の試し再生で出したか。試し再生は猶予の演出までは流すが、配信は止めない */
  readonly rehearsal: boolean
}

/**
 * 選んだ出題の行を入れる。まだ回答は受け付けない（合成ページが流しはじめて openKanjiQuiz を呼ぶまで）。
 * あわせて、古い出題（7日より前）を消して増え続けないようにする。
 */
export const recordKanjiQuiz = async (db: Database, quiz: KanjiQuizRecord, now: number): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM kanji_quizzes WHERE issued_at < ?1').bind(toIso(now - KANJI_QUIZ_RETENTION_MS)),
    db
      .prepare('INSERT INTO kanji_quizzes (id, word, issued_at, rehearsal) VALUES (?1, ?2, ?3, ?4)')
      .bind(quiz.id, quiz.word, toIso(now), quiz.rehearsal ? 1 : 0),
  ])
}

/**
 * 選んだ出題の行を消す。押し出しに失敗して合成ページに流れなかった問題を、同じ配信で出したものとして数えないために使う。
 */
export const removeKanjiQuiz = async (db: Database, id: string): Promise<void> => {
  await db.prepare('DELETE FROM kanji_quizzes WHERE id = ?1').bind(id).run()
}

/**
 * 合成ページが流しはじめた出題を開く。級を出し終えて熟語が出たときから、制限時間と遅れの余裕のあいだ回答を受け付ける。
 * 同じ出題がもう開いていれば、受け付ける時刻を変えない（合成ページを2つ開いていても長さを延ばさない）。
 *
 * @param now 合成ページが流しはじめた時刻（Worker が受けた時刻で代える。届くまでの遅れは余裕に含める）
 * @returns 回答の受付を締め切る時刻（ミリ秒。2回目に開いたときも最初の時刻）。時間切れの判定をこの時刻に仕掛ける（issue #302）。
 *   選んでいない出題の識別子なら null（合成ページから熟語を受け取って行を作らない）
 */
export const openKanjiQuiz = async (db: Database, id: string, now: number): Promise<number | null> => {
  const acceptsFrom = now + GRADE_INTRO_MS
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET accepts_from = COALESCE(accepts_from, ?2), closes_at = COALESCE(closes_at, ?3)
       WHERE id = ?1
       RETURNING closes_at`,
    )
    .bind(id, toIso(acceptsFrom), toIso(acceptsFrom + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS))
    .all<{ closes_at: string }>()
  const [row] = results
  return row === undefined ? null : Date.parse(row.closes_at)
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
 * いまの配信が始まってから選んだ出題の熟語と、選んだ回数を読む。配信していなければ空（外すものが無い）。
 * 回数は、問題をすべて出し終えたあとに一巡させる（出した回数がいちばん少ないものから選ぶ）ために使う。
 */
export const readKanjiQuizWordCounts = async (db: Database, now: number): Promise<ReadonlyMap<string, number>> => {
  const { results } = await db
    .prepare(`SELECT word, COUNT(*) AS count FROM kanji_quizzes WHERE issued_at >= (${CURRENT_SESSION_STARTED_AT}) GROUP BY word`)
    .bind(toIso(now))
    .all<{ word: string; count: number }>()
  return new Map(results.map(({ word, count }) => [word, count]))
}

/**
 * 時間切れ（受付を締め切っても正解者がいない）の出題で、配信の停止を始める。猶予の終わり（配信を止める時刻）を書く。
 *
 * 締め切りの前・正解者がいる・開いていない・もう始めた出題では始めない（アラームが2回鳴っても猶予を延ばさない）。
 * 締め切りのあとは answerKanjiQuiz が正解者を書かないので、ここで「正解者なし」が確定する。
 *
 * @param graceMs 配信を止めるまでの猶予（ミリ秒）
 * @returns 始めたなら、試し再生の出題かどうか。始めなかったら null
 */
export const beginKanjiQuizStop = async (db: Database, id: string, now: number, graceMs: number): Promise<{ rehearsal: boolean } | null> => {
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET stop_at = ?3
       WHERE id = ?1 AND winner_name IS NULL AND closes_at <= ?2 AND stop_at IS NULL
       RETURNING rehearsal`,
    )
    .bind(id, toIso(now), toIso(now + graceMs))
    .all<{ rehearsal: number }>()
  const [row] = results
  return row === undefined ? null : { rehearsal: row.rehearsal === 1 }
}

/**
 * 始めた停止を、なかったことにする。猶予を合成ページと下部バーへ知らせられなかったときに使う
 * （止めないうえ、あとで下部バーから「取り消せた」ことにならないように）。命令を送った・取り消した出題には触れない。
 */
export const abandonKanjiQuizStop = async (db: Database, id: string): Promise<void> => {
  await db
    .prepare('UPDATE kanji_quizzes SET stop_at = NULL WHERE id = ?1 AND stop_cancelled_at IS NULL AND stop_sent_at IS NULL')
    .bind(id)
    .run()
}

/**
 * 猶予のあいだの停止をすべて取り消す（下部バーの取り消しボタン）。止める命令をもう送った出題は取り消せない。
 *
 * 猶予が尽きたあとでも、命令を送る前（アラームの遅れのあいだ）なら取り消せる。止めないほうに倒すためである。
 *
 * @returns 取り消した出題の識別子
 */
export const cancelKanjiQuizStops = async (db: Database, now: number): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET stop_cancelled_at = ?1
       WHERE stop_at IS NOT NULL AND stop_cancelled_at IS NULL AND stop_sent_at IS NULL
       RETURNING id`,
    )
    .bind(toIso(now))
    .all<{ id: string }>()
  return results.map(({ id }) => id)
}

/**
 * 猶予が尽きた出題で、配信を止める鍵を確保する。確保できたときだけ裏方へ停止の命令を送る。
 *
 * 猶予の前・取り消された・試し再生・停止を始めていない・もう確保した出題では確保できない（同じ出題で2回止めない）。
 *
 * @returns 確保できたか
 */
export const claimKanjiQuizStop = async (db: Database, id: string, now: number): Promise<boolean> => {
  const { results } = await db
    .prepare(
      `UPDATE kanji_quizzes SET stop_sent_at = ?2
       WHERE id = ?1 AND rehearsal = 0 AND stop_at <= ?2 AND stop_cancelled_at IS NULL AND stop_sent_at IS NULL
       RETURNING id`,
    )
    .bind(id, toIso(now))
    .all<{ id: string }>()
  return results.length > 0
}
