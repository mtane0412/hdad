/**
 * リポジトリの、チャットで推理の問題集（problems.json を読んだもの。issue #375）
 *
 * Worker（ゲームの開始・質問への答え・解答の照合）とアプリのページ（問題を選ぶ欄）が同じものを読む
 * （漢字クイズの問題集と同じく、Worker から src/ を読み込む例外）。形の誤りは読み込んだ時点で投げる。
 */
import problems from './problems.json'
import { readChatDeductionProblems, type ChatDeductionProblem } from './problems'

export const CHAT_DEDUCTION_PROBLEMS: readonly ChatDeductionProblem[] = readChatDeductionProblems(problems)
