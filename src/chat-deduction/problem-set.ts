/**
 * リポジトリの、チャットで推理の問題集（problems.json を読んだもの。issue #375）
 *
 * Worker（ゲームの開始・質問への答え・解答の照合）とアプリのページ（問題集を選ぶ欄）が同じものを読む
 * （漢字クイズの問題集と同じく、Worker から src/ を読み込む例外）。形の誤りは読み込んだ時点で投げる。
 * - CHAT_DEDUCTION_PROBLEM_SETS: 問題集の一覧（ゲームを始めるときに選ぶ）
 * - CHAT_DEDUCTION_PROBLEMS: すべての問題集の問題を並べたもの（ゲームの行の問題のIDから問題を引く）
 * - CHAT_DEDUCTION_IMAGES: 問題のIDから解説に添える画像を引く表（images.json を読んだもの。画像が無ければ null）
 */
import images from './images.json'
import { readChatDeductionImages, type ChatDeductionImage } from './images'
import problemSets from './problems.json'
import { readChatDeductionProblemSets, type ChatDeductionProblem, type ChatDeductionProblemSet } from './problems'

export const CHAT_DEDUCTION_PROBLEM_SETS: readonly ChatDeductionProblemSet[] = readChatDeductionProblemSets(problemSets)

export const CHAT_DEDUCTION_PROBLEMS: readonly ChatDeductionProblem[] = CHAT_DEDUCTION_PROBLEM_SETS.flatMap((set) => set.problems)

export const CHAT_DEDUCTION_IMAGES: ReadonlyMap<string, ChatDeductionImage | null> = readChatDeductionImages(images, CHAT_DEDUCTION_PROBLEMS)
