/**
 * 漢字クイズの呼び出し（Worker が押し出す、1回ぶんの出題）
 *
 * Worker（worker/kanji-quiz-call.ts）が、チャンネルポイントの交換と管理画面の試し再生で、合成ページの素材「漢字クイズ」へ
 * WebSocket で押し出す。どの問題を出すかは Worker が問題集（problems.json）から選ぶので、呼び出しは選ばれた1問と、
 * 交換して出題させた人の名前（試し再生は null）を持つ。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。
 */
import { readKanjiQuizProblem, type KanjiQuizProblem } from './problems'

/** 1回ぶんの出題 */
export interface KanjiQuizCall {
  /** 呼び出しごとの識別子 */
  readonly id: string
  readonly problem: KanjiQuizProblem
  /** チャンネルポイントを交換して出題させた人の表示名。試し再生は null */
  readonly requesterName: string | null
}

/**
 * WebSocket で押し出された文字列を、漢字クイズの呼び出しとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseKanjiQuizCall = (payload: string): KanjiQuizCall => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された漢字クイズの呼び出しをJSONとして読めません')
  }
  const { id, problem, requesterName }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (typeof id !== 'string' || id === '' || (requesterName !== null && typeof requesterName !== 'string')) {
    throw new Error('押し出された漢字クイズの呼び出しが想定した形ではありません')
  }
  return { id, problem: readKanjiQuizProblem(problem, '押し出された漢字クイズの問題'), requesterName }
}
