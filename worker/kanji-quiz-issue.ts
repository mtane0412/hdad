/**
 * 漢字クイズの出題（issue #301）
 *
 * チャンネルポイントの交換（alert-actions.ts）と管理画面の試し再生（kanji-quiz-routes.ts）が呼ぶ。
 * 同じ配信で出していない問題を1問選び（kanji-quiz-call.ts の pickKanjiQuizProblem）、出題の行を D1 に入れてから（kanji-quiz-store.ts）
 * 合成ページの素材「漢字クイズ」へ押し出す。行を押し出す前に入れるのは、合成ページが流しはじめて出題を開くまでに行が要るためである。
 * 試し再生で出した問題も、同じ配信で出したものとして数える（配信中の試し再生も OBS の画面に映るため）。
 *
 * 注意: 選べる問題が尽きたら、黙って重複させず、素材の箱に出す知らせを押し出してから投げる（呼び出し側が失敗として記録するか返す）。
 */
import type { KankenGrade } from '../src/kanji-quiz/grade'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { pushKanjiQuiz, pushKanjiQuizNotice, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import { KANJI_QUIZ_PROBLEMS, KanjiQuizExhaustedError, pickKanjiQuizProblem, type KanjiQuizCall } from './kanji-quiz-call'
import { readUsedKanjiQuizWords, recordKanjiQuiz } from './kanji-quiz-store'

/** 出題に使うもの。乱数と識別子はテストで差し替えるため引数で受け取る */
export interface KanjiQuizIssueDeps {
  readonly db: Database
  readonly alerts: AlertChannelNamespace
  readonly now: number
  /** 0 以上 1 未満の乱数を返す（呼び出し側は Math.random を渡す） */
  readonly random: () => number
  /** 出題の識別子（呼び出し側は crypto.randomUUID() を渡す） */
  readonly id: string
}

/**
 * 級の問題を1問選んで記録し、合成ページへ押し出す。
 *
 * @param request 級と、交換して出題させた人の表示名（試し再生は null）
 * @param problems 選ぶ元の問題集。省けばリポジトリの問題集
 * @returns 押し出した呼び出し
 * @throws KanjiQuizExhaustedError 同じ配信でその級の問題をすべて出した場合（素材の箱への知らせは押し出し済み）
 */
export const issueKanjiQuiz = async (
  { db, alerts, now, random, id }: KanjiQuizIssueDeps,
  request: { readonly grade: KankenGrade; readonly requesterName: string | null },
  problems: readonly KanjiQuizProblem[] = KANJI_QUIZ_PROBLEMS,
): Promise<KanjiQuizCall> => {
  const usedWords = await readUsedKanjiQuizWords(db, now)
  let problem: KanjiQuizProblem
  try {
    problem = pickKanjiQuizProblem(request.grade, random, usedWords, problems)
  } catch (error) {
    if (error instanceof KanjiQuizExhaustedError) await pushKanjiQuizNotice(alerts, { type: 'failure', message: error.message })
    throw error
  }
  await recordKanjiQuiz(db, { id, word: problem.word }, now)
  const call: KanjiQuizCall = { id, problem, requesterName: request.requesterName }
  await pushKanjiQuiz(alerts, call)
  return call
}
