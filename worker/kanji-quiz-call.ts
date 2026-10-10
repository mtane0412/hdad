/**
 * 漢字クイズの呼び出しの組み立て（issue #300）
 *
 * チャンネルポイントのトリガー（alert-actions.ts）と管理画面の試し再生（kanji-quiz-routes.ts）が、合成ページの素材「漢字クイズ」へ
 * 押し出す呼び出しの形と、問題の選び方を持つ（選んで記録して押し出すのは kanji-quiz-issue.ts）。問題は問題集（src/kanji-quiz/problems.json）から、動作の設定で選んだ級のものを1問選ぶ。
 * LLM や辞書からその場で作らない（正答の判定が配信の強制終了に直結するため、配信者が確かめた問題だけを出す。issue #293）。
 * 同じ配信で出した問題は選ばず、選べる問題が尽きたら黙って重複させずに投げる（issue #301）。
 * 正解者と失敗の知らせ（KanjiQuizNotice）も、出題と同じ素材へ押し出す。
 *
 * 注意: 問題集と級の一覧は合成ページと同じもの（src/kanji-quiz/）を読む。Worker から src/ を読み込む例外の1つで、
 * 問題集を2か所に持たないためである（.claude/rules/kanji-quiz.md）。形は合成ページの読み取り（src/kanji-quiz/call.ts）と合わせる。
 */
import { kankenGradeLabel, type KankenGrade } from '../src/kanji-quiz/grade'
import { readKanjiQuizProblems, type KanjiQuizProblem } from '../src/kanji-quiz/problems'
import problemSet from '../src/kanji-quiz/problems.json'

/** リポジトリの問題集。形の誤りは読み込んだ時点で投げる */
export const KANJI_QUIZ_PROBLEMS = readKanjiQuizProblems(problemSet)

/** 1回ぶんの出題 */
export interface KanjiQuizCall {
  readonly id: string
  readonly problem: KanjiQuizProblem
  /** チャンネルポイントを交換して出題させた人の表示名。試し再生は null */
  readonly requesterName: string | null
}

/**
 * 出題と同じ素材へ押し出す知らせ。呼び出しと見分けるため type を持つ（呼び出しは type を持たない）。
 * - answer: 最初の正解者（Webhook がチャットの正解を受けたとき）
 * - failure: 出題できなかった理由（素材の箱に出す。選べる問題が尽きたときなど）
 */
export type KanjiQuizNotice =
  | { readonly type: 'answer'; readonly quizId: string; readonly userName: string }
  | { readonly type: 'failure'; readonly message: string }

/** その級の問題を、同じ配信ですべて出し終えた（黙って重複させずに投げる） */
export class KanjiQuizExhaustedError extends Error {
  override readonly name = 'KanjiQuizExhaustedError'
}

/**
 * 選んだ級の問題のうち、同じ配信でまだ出していないものを1問選ぶ。
 *
 * @param random 0 以上 1 未満の乱数を返す（呼び出し側は Math.random を渡す）
 * @param usedWords 同じ配信で出した問題の熟語（kanji-quiz-store.ts の readUsedKanjiQuizWords）
 * @param problems 選ぶ元の問題集。省けばリポジトリの問題集
 * @throws その級の問題が無い場合（ほかの級から黙って出さない）
 * @throws KanjiQuizExhaustedError その級の問題を同じ配信ですべて出した場合（黙って重複させない）
 */
export const pickKanjiQuizProblem = (
  grade: KankenGrade,
  random: () => number,
  usedWords: ReadonlySet<string>,
  problems: readonly KanjiQuizProblem[] = KANJI_QUIZ_PROBLEMS,
): KanjiQuizProblem => {
  const inGrade = problems.filter((problem) => problem.grade === grade)
  if (inGrade.length === 0) throw new Error(`漢字クイズの問題集に${kankenGradeLabel(grade)}の問題がありません`)
  const candidates = inGrade.filter((problem) => !usedWords.has(problem.word))
  const problem = candidates[Math.floor(random() * candidates.length)]
  if (problem === undefined) {
    throw new KanjiQuizExhaustedError(`漢字クイズの問題集の${kankenGradeLabel(grade)}の問題は、この配信ですべて出しました（${inGrade.length}問）`)
  }
  return problem
}
