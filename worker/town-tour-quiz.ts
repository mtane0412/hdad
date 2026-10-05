/**
 * 市町村紹介の冒頭の都道府県当てクイズの出題と、最初の正解者の記録（issue #251）
 *
 * 合成ページがクイズの場面を流しはじめたら出題を開き（openTownTourQuiz）、Webhook がチャットの発言を受けるたびに
 * 受け付けている出題と照らして、最初に正解した人を決める（answerTownTourQuiz）。
 * テーブルの定義は migrations/0026_town_tour_quizzes.sql にある。日時は UTC の ISO 8601 の文字列で持つ。
 *
 * 注意: 正解者の判定は SQLite の RETURNING を使い、1つの文の中で「書けたかどうか」を受け取る（chat-store.ts と同じ考え方）。
 * 「読んでから書く」に分けると、ほぼ同時に届いた2人の正解がどちらも最初の正解者になってしまう。
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。
 */
import { QUIZ_MS } from '../src/town-tour/quiz'
import type { Database } from './database'

/**
 * 回答を受け付ける長さに足す余裕（ミリ秒）。発言が Twitch から Worker に届くまでの遅れの分だけ、
 * 合成ページで時間切れになる直前に書かれた回答を取りこぼさないようにする（合成ページは時間切れの後に届いた正解者を出さない）
 */
export const QUIZ_GRACE_MS = 2000

/** 出題を残しておく期間（ミリ秒）。正解者を決め終えた行は使わないので、1日で足りる */
const QUIZ_RETENTION_MS = 24 * 60 * 60 * 1000

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** 開く出題 */
export interface TownTourQuiz {
  /** 出題の識別子（呼び出しの quizId） */
  readonly id: string
  readonly code: string
  /** 正解の都道府県の正式な名前 */
  readonly prefecture: string
}

/**
 * 出題を開き、now から受け付けはじめる。同じ出題がもう開いていれば何もしない（受け付ける長さを延ばさない）。
 * あわせて、古い出題（1日より前）を消して増え続けないようにする。
 */
export const openTownTourQuiz = async (db: Database, quiz: TownTourQuiz, now: number): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM town_tour_quizzes WHERE opened_at < ?1').bind(toIso(now - QUIZ_RETENTION_MS)),
    db
      .prepare(
        `INSERT INTO town_tour_quizzes (id, code, prefecture, opened_at, closes_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(quiz.id, quiz.code, quiz.prefecture, toIso(now), toIso(now + QUIZ_MS + QUIZ_GRACE_MS)),
  ])
}

/**
 * チャットの回答を、受け付けている出題と照らす。正解で、その出題にまだ正解者がいなければ、この人を正解者にする。
 *
 * @param answer 回答した都道府県（正式な名前）と、回答した人の表示名
 * @returns この回答で正解者が決まった出題の識別子。正解者にならなかったら空
 */
export const answerTownTourQuiz = async (db: Database, answer: { prefecture: string; userName: string }, now: number): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `UPDATE town_tour_quizzes SET winner_name = ?1, answered_at = ?2
       WHERE prefecture = ?3 AND winner_name IS NULL AND opened_at <= ?2 AND closes_at > ?2
       RETURNING id`,
    )
    .bind(answer.userName, toIso(now), answer.prefecture)
    .all<{ id: string }>()
  return results.map(({ id }) => id)
}
