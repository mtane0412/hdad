/**
 * 漢字クイズの呼び出しの組み立て（issue #300）
 *
 * チャンネルポイントのトリガー（alert-actions.ts）と管理画面の試し再生（kanji-quiz-routes.ts）が、合成ページの素材「漢字クイズ」へ
 * 押し出す呼び出しの形と、問題の選び方を持つ（選んで記録して押し出すのは kanji-quiz-issue.ts）。問題は問題集（src/kanji-quiz/problems.json）から、
 * 動作の設定の級ごとの重みに沿って級を選び、その級のものを1問選ぶ。
 * LLM や辞書からその場で作らない（正答の判定が配信の強制終了に直結するため、配信者が確かめた問題だけを出す。issue #293）。
 * 同じ配信で出した問題は選ばず（issue #301）、出し終えた級は外して残りの級の重みで選ぶ。重みのある級をすべて出し終えたら、
 * エラーにせず出した回数がいちばん少ない問題から選び直す（一巡する）。
 * 正解者と失敗の知らせ（KanjiQuizNotice）も、出題と同じ素材へ押し出す。
 *
 * 注意: 問題集と級の一覧は合成ページと同じもの（src/kanji-quiz/）を読む。Worker から src/ を読み込む例外の1つで、
 * 問題集を2か所に持たないためである（.claude/rules/kanji-quiz.md）。形は合成ページの読み取り（src/kanji-quiz/call.ts）と合わせる。
 */
import { KANKEN_GRADES, kankenGradeLabel, type KankenGradeWeights } from '../src/kanji-quiz/grade'
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
 * - failure: 出題できなかった理由（素材の箱に出す。合成ページは読めるが、いまの Worker は押し出していない）
 * - stopping: 時間切れで、graceMs ののちに配信を止める（issue #302）。rehearsal は試し再生（止めない）。
 *   時刻ではなく長さで送るのは、合成ページと下部バーの時計が Worker とずれていても、残り秒数を正しく数えるためである
 * - stopCancelled: 下部バーで配信の停止を取り消した
 */
export type KanjiQuizNotice =
  | { readonly type: 'answer'; readonly quizId: string; readonly userName: string }
  | { readonly type: 'failure'; readonly message: string }
  | { readonly type: 'stopping'; readonly quizId: string; readonly graceMs: number; readonly rehearsal: boolean }
  | { readonly type: 'stopCancelled'; readonly quizId: string }

/** 裏方のページへ送る、配信を止める命令（issue #302）。どの出題で止めたかを結果の記録に添えるため、出題の識別子を持つ */
export interface StreamStopOrder {
  readonly quizId: string
}

/**
 * 級ごとの重みに沿って級を選び、その級の問題のうち同じ配信で出した回数がいちばん少ないものを1問選ぶ。
 *
 * 出した回数がいちばん少ない問題だけを候補にするので、1巡目はまだ出していない問題から選び、出し終えた級は候補が無くなって外れる
 * （残りの級の重みで選び直す）。重みのある級をすべて出し終えたら、2巡目として全問が候補に戻る。
 *
 * @param weights 級ごとの出題の重み（0の級からは出さない）
 * @param random 0 以上 1 未満の乱数を返す（呼び出し側は Math.random を渡す）。1回目で級、2回目で問題を選ぶ
 * @param wordCounts 同じ配信で出した問題の熟語と、出した回数（kanji-quiz-store.ts の readKanjiQuizWordCounts）
 * @param problems 選ぶ元の問題集。省けばリポジトリの問題集
 * @throws 重みのある級の問題が問題集に無い場合（ほかの級から黙って出さない）
 */
export const pickKanjiQuizProblem = (
  weights: KankenGradeWeights,
  random: () => number,
  wordCounts: ReadonlyMap<string, number>,
  problems: readonly KanjiQuizProblem[] = KANJI_QUIZ_PROBLEMS,
): KanjiQuizProblem => {
  const weightedGrades = KANKEN_GRADES.filter((grade) => weights[grade] > 0)
  const missing = weightedGrades.find((grade) => !problems.some((problem) => problem.grade === grade))
  if (missing !== undefined) throw new Error(`漢字クイズの問題集に${kankenGradeLabel(missing)}の問題がありません`)

  // 重みのある級の問題のうち、出した回数がいちばん少ないものだけを候補にする
  const countOf = (problem: KanjiQuizProblem): number => wordCounts.get(problem.word) ?? 0
  const weighted = problems.filter((problem) => weights[problem.grade] > 0)
  const fewest = Math.min(...weighted.map(countOf))
  const candidates = weighted.filter((problem) => countOf(problem) === fewest)

  // 候補の残っている級だけで、重みの割合に沿って級を選ぶ（乱数を重みの合計まで引き伸ばし、級の重みの幅に入ったものを選ぶ）
  const grades = weightedGrades.filter((grade) => candidates.some((problem) => problem.grade === grade))
  const total = grades.reduce((sum, grade) => sum + weights[grade], 0)
  let point = random() * total
  const grade = grades.find((each) => (point -= weights[each]) < 0)
  if (grade === undefined) throw new Error('漢字クイズの級を重みから選べませんでした（乱数が 0 以上 1 未満ではありません）')
  const inGrade = candidates.filter((problem) => problem.grade === grade)
  const problem = inGrade[Math.floor(random() * inGrade.length)]
  if (problem === undefined) throw new Error('漢字クイズの問題を選べませんでした（乱数が 0 以上 1 未満ではありません）')
  return problem
}
