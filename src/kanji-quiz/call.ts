/**
 * 漢字クイズの呼び出し（Worker が押し出す、1回ぶんの出題）と知らせ
 *
 * Worker（worker/kanji-quiz-issue.ts）が、チャンネルポイントの交換と管理画面の試し再生で、合成ページの素材「漢字クイズ」へ
 * WebSocket で押し出す。どの問題を出すかは Worker が問題集（problems.json）から選ぶので、呼び出しは選ばれた1問と、
 * 交換して出題させた人の名前（試し再生は null）を持つ。
 * 同じ経路で、最初の正解者（type: answer。Webhook がチャットの正解を受けたとき）と、出題できなかった理由
 * （type: failure。同じ配信で選べる問題が尽きたときなど）も届く（issue #301）。呼び出しは type を持たない。
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

/** 押し出されたもの1件 */
export type KanjiQuizMessage =
  | { readonly type: 'call'; readonly call: KanjiQuizCall }
  | { readonly type: 'answer'; readonly quizId: string; readonly userName: string }
  | { readonly type: 'failure'; readonly message: string }

/**
 * WebSocket で押し出された文字列を、漢字クイズの呼び出しか知らせとして読む。
 *
 * @throws JSONとして読めない・想定した形でない・知らない type の場合
 */
export const parseKanjiQuizMessage = (payload: string): KanjiQuizMessage => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された漢字クイズの呼び出しをJSONとして読めません')
  }
  const { type, id, problem, requesterName, quizId, userName, message }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (type === 'answer') {
    if (typeof quizId !== 'string' || quizId === '' || typeof userName !== 'string' || userName === '') {
      throw new Error('押し出された漢字クイズの正解者が想定した形ではありません')
    }
    return { type: 'answer', quizId, userName }
  }
  if (type === 'failure') {
    if (typeof message !== 'string' || message === '') throw new Error('押し出された漢字クイズの失敗の知らせが想定した形ではありません')
    return { type: 'failure', message }
  }
  if (type !== undefined) throw new Error(`押し出された漢字クイズの知らせの種類が分かりません: ${String(type)}`)
  if (typeof id !== 'string' || id === '' || (requesterName !== null && typeof requesterName !== 'string')) {
    throw new Error('押し出された漢字クイズの呼び出しが想定した形ではありません')
  }
  return { type: 'call', call: { id, problem: readKanjiQuizProblem(problem, '押し出された漢字クイズの問題'), requesterName } }
}
