/**
 * チャットで推理の出題（問題集から1問を決める）
 *
 * 配信者は問題集だけを選び、どの問題を出すかはここが乱数で決める（配信者も答えを知らずに一緒に推理するため）。
 * 直前のゲームの問題は選ばない（同じ問題が続かないように）。ただし問題集に1問しか無ければ、その問題を選ぶ。
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
