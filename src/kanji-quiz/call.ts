/**
 * 漢字クイズの呼び出し（Worker が押し出す、1回ぶんの出題）と知らせ
 *
 * Worker（worker/kanji-quiz-issue.ts）が、チャンネルポイントの交換と管理画面の試し再生で、合成ページの素材「漢字クイズ」へ
 * WebSocket で押し出す。どの問題を出すかは Worker が問題集（problems.json）から選ぶので、呼び出しは選ばれた1問と、
 * 交換して出題させた人の名前（試し再生は null）と、演出で鳴らす音の設定（Worker が素材のIDを音声のURLに置き換えたもの）を持つ。
 * 同じ経路で、最初の正解者（type: answer。Webhook がチャットの正解を受けたとき）と、出題できなかった理由
 * （type: failure）も届く（issue #301。いまの Worker は failure を押し出していない）。呼び出しは type を持たない。
 * 時間切れで配信を止めるまでの猶予（type: stopping）と、下部バーでの停止の取り消し（type: stopCancelled）も届く（issue #302）。
 * 下部バー（stop-bar.tsx）も同じ経路につなぎ、同じ読み取りを通す。
 * 裏方のページの「配信の停止」へ届く命令（parseStreamStopOrder）の読み取りもここに置く（形を worker/kanji-quiz-call.ts と合わせる）。
 *
 * 注意: 形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。
 */
import { readKanjiQuizProblem, type KanjiQuizProblem } from './problems'
import { readKanjiQuizPlaybackSound, type KanjiQuizSound } from './sound'

/** 1回ぶんの出題 */
export interface KanjiQuizCall {
  /** 呼び出しごとの識別子 */
  readonly id: string
  readonly problem: KanjiQuizProblem
  /** チャンネルポイントを交換して出題させた人の表示名。試し再生は null */
  readonly requesterName: string | null
  /** 演出で鳴らす音（枠ごとの音声のURLと音量）。鳴らさない枠は null */
  readonly sound: KanjiQuizSound
}

/** 押し出されたもの1件 */
export type KanjiQuizMessage =
  | { readonly type: 'call'; readonly call: KanjiQuizCall }
  | { readonly type: 'answer'; readonly quizId: string; readonly userName: string }
  | { readonly type: 'failure'; readonly message: string }
  /** graceMs ののちに配信を止める。rehearsal は試し再生（止めない）。時計のずれを避けるため、時刻ではなく長さで届く */
  | { readonly type: 'stopping'; readonly quizId: string; readonly graceMs: number; readonly rehearsal: boolean }
  | { readonly type: 'stopCancelled'; readonly quizId: string }

/** 裏方のページへ届く、配信を止める命令 */
export interface StreamStopOrder {
  readonly quizId: string
}

/** JSON として読む。読めなければ subject を添えて投げる */
const parseJson = (payload: string, subject: string): Record<string, unknown> => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error(`押し出された${subject}をJSONとして読めません`)
  }
  return typeof body === 'object' && body !== null ? { ...body } : {}
}

/** 出題の識別子として読めるか */
const isQuizId = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * WebSocket で押し出された文字列を、漢字クイズの呼び出しか知らせとして読む。
 *
 * @throws JSONとして読めない・想定した形でない・知らない type の場合
 */
export const parseKanjiQuizMessage = (payload: string): KanjiQuizMessage => {
  const { type, id, problem, requesterName, sound, quizId, userName, message, graceMs, rehearsal } = parseJson(payload, '漢字クイズの呼び出し')
  if (type === 'stopping') {
    if (!isQuizId(quizId) || typeof graceMs !== 'number' || !Number.isFinite(graceMs) || typeof rehearsal !== 'boolean') {
      throw new Error('押し出された配信の停止の猶予が想定した形ではありません')
    }
    return { type: 'stopping', quizId, graceMs, rehearsal }
  }
  if (type === 'stopCancelled') {
    if (!isQuizId(quizId)) throw new Error('押し出された配信の停止の取り消しが想定した形ではありません')
    return { type: 'stopCancelled', quizId }
  }
  if (type === 'answer') {
    if (!isQuizId(quizId) || typeof userName !== 'string' || userName === '') {
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
  return {
    type: 'call',
    call: { id, problem: readKanjiQuizProblem(problem, '押し出された漢字クイズの問題'), requesterName, sound: readKanjiQuizPlaybackSound(sound) },
  }
}

/**
 * WebSocket で押し出された文字列を、配信を止める命令として読む（裏方のページの「配信の停止」が使う）。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseStreamStopOrder = (payload: string): StreamStopOrder => {
  const { quizId } = parseJson(payload, '配信を止める命令')
  if (!isQuizId(quizId)) throw new Error('押し出された配信を止める命令が想定した形ではありません')
  return { quizId }
}
