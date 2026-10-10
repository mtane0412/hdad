/**
 * 漢字クイズの出題（issue #301）
 *
 * チャンネルポイントの交換（alert-actions.ts）と管理画面の試し再生（kanji-quiz-routes.ts）が呼ぶ。
 * 級ごとの重みに沿って、同じ配信で出した回数がいちばん少ない問題を1問選び（kanji-quiz-call.ts の pickKanjiQuizProblem）、出題の行を D1 に入れてから（kanji-quiz-store.ts）
 * 合成ページの素材「漢字クイズ」へ押し出す。行を押し出す前に入れるのは、合成ページが流しはじめて出題を開くまでに行が要るためである。
 * 試し再生で出した問題も、同じ配信で出したものとして数える（配信中の試し再生も OBS の画面に映るため）。
 *
 * 注意: 押し出しに失敗したら、流れなかった問題を「出した」に数えないよう行を消してから投げる（消せなければその理由も添える）。
 * 重みのある級の問題をすべて出し終えたら、出した回数がいちばん少ない問題から選び直す（一巡する）。
 */
import type { KankenGradeWeights } from '../src/kanji-quiz/grade'
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { pushKanjiQuiz, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import { KANJI_QUIZ_PROBLEMS, pickKanjiQuizProblem, type KanjiQuizCall } from './kanji-quiz-call'
import { readKanjiQuizWordCounts, recordKanjiQuiz, removeKanjiQuiz } from './kanji-quiz-store'

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
 * 級ごとの重みに沿って問題を1問選んで記録し、合成ページへ押し出す。
 *
 * @param request 級ごとの出題の重みと、交換して出題させた人の表示名（試し再生は null）と、試し再生か（試し再生は時間切れでも配信を止めない。issue #302）
 * @param problems 選ぶ元の問題集。省けばリポジトリの問題集
 * @returns 押し出した呼び出し
 * @throws 押し出せなかった場合（出題の行は消してから投げる）
 */
export const issueKanjiQuiz = async (
  { db, alerts, now, random, id }: KanjiQuizIssueDeps,
  request: { readonly weights: KankenGradeWeights; readonly requesterName: string | null; readonly rehearsal: boolean },
  problems: readonly KanjiQuizProblem[] = KANJI_QUIZ_PROBLEMS,
): Promise<KanjiQuizCall> => {
  const wordCounts = await readKanjiQuizWordCounts(db, now)
  const problem = pickKanjiQuizProblem(request.weights, random, wordCounts, problems)
  await recordKanjiQuiz(db, { id, word: problem.word, rehearsal: request.rehearsal }, now)
  const call: KanjiQuizCall = { id, problem, requesterName: request.requesterName }
  try {
    await pushKanjiQuiz(alerts, call)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 流れなかった問題を「出した」に数えない。消せなかったら黙らず、その理由も添えて投げる
    await removeKanjiQuiz(db, id).catch((removeError: unknown) => {
      throw new Error(`${reason}（出題の行も消せませんでした: ${removeError instanceof Error ? removeError.message : String(removeError)}）`)
    })
    throw error
  }
  return call
}
