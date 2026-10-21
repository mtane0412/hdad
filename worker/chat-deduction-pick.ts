/**
 * チャットで推理の出題（問題集から1問を決める）
 *
 * /chat-deduction/ のページでは配信者は問題集だけを選び、どの問題を出すかはここが乱数で決める（配信者も答えを知らずに一緒に推理するため）。
 * 直前のゲームの問題は選ばない（同じ問題が続かないように）。ただし問題集に1問しか無ければ、その問題を選ぶ。
 * トリガーの動作 chatDeduction では、配信者が問題を指定することもできる（pickConfiguredChatDeductionProblem）。
 *
 * 注意: 乱数は引数で受け取る（呼び出し側は Math.random を渡す。テストで決まった値を渡すため）。
 */
import type { ChatDeductionProblem, ChatDeductionProblemSet } from '../src/chat-deduction/problems'

/**
 * 問題集から出題する1問を決める。
 *
 * @param set 配信者が選んだ問題集（1問以上。problems.ts の読み取りで確かめてある）
 * @param previousProblemId 直前のゲームの問題のID（一度も始めていなければ null）
 * @param random 0 以上 1 未満の乱数を返す
 */
export const pickChatDeductionProblem = (set: ChatDeductionProblemSet, previousProblemId: string | null, random: () => number): ChatDeductionProblem => {
  const others = set.problems.filter((problem) => problem.id !== previousProblemId)
  const candidates = others.length > 0 ? others : set.problems
  const picked = candidates[Math.floor(random() * candidates.length)]
  if (picked === undefined) throw new Error(`問題集「${set.id}」に出題できる問題がありません`)
  return picked
}

/**
 * トリガーの動作の設定（問題集と、指定した問題か null）から出題する1問を決める。
 *
 * 問題を指定していればその問題を選び、直前のゲームと同じでも差し替えない。null なら pickChatDeductionProblem で選ぶ。
 *
 * @param sets 問題集の一覧（呼び出し側は CHAT_DEDUCTION_PROBLEM_SETS を渡す）
 * @throws 問題集か問題が無い場合（保存したあとで problems.json から消した。ほかの問題で黙って始めない）
 */
export const pickConfiguredChatDeductionProblem = (
  sets: readonly ChatDeductionProblemSet[],
  choice: { readonly setId: string; readonly problemId: string | null },
  previousProblemId: string | null,
  random: () => number,
): ChatDeductionProblem => {
  const set = sets.find((candidate) => candidate.id === choice.setId)
  if (set === undefined) throw new Error(`トリガーに設定した問題集「${choice.setId}」がありません。トリガーの画面で選び直してください`)
  if (choice.problemId === null) return pickChatDeductionProblem(set, previousProblemId, random)
  const problem = set.problems.find((candidate) => candidate.id === choice.problemId)
  if (problem === undefined) throw new Error(`トリガーに設定した問題「${choice.problemId}」が問題集「${set.id}」にありません。トリガーの画面で選び直してください`)
  return problem
}
