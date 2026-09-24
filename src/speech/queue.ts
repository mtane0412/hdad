/**
 * 読み上げ待ちの列
 *
 * 読み上げは1件ずつ順番に行う（同時に鳴らすとどちらも聞き取れないため）。状態は「読み上げ中の1件」と
 * 「待っているもの」だけで、どちらの操作も新しい状態を返す（src/alerts/queue.ts と同じ作り）。
 *
 * 注意: 読み上げには発言よりも時間がかかるので、チャットが速いと待ちがいくらでも伸びる。数分前の発言を
 * 読み続けても配信の役に立たないため、待ちに上限を設けて古いほうから捨てる。
 */

/** 待たせておく件数の上限。超えたら古いほうから捨てる */
export const MAX_WAITING_SPEECH = 10

export interface SpeechQueue {
  /** 読み上げ中の文。何も読んでいなければ null */
  readonly current: string | null
  /** 届いた順に待っている文 */
  readonly waiting: readonly string[]
}

export const EMPTY_SPEECH_QUEUE: SpeechQueue = { current: null, waiting: [] }

/** 読み上げ文が届いた。何も読んでいなければすぐ読み上げ中にし、読み上げ中なら後ろに並べる */
export const enqueueSpeech = (queue: SpeechQueue, text: string): SpeechQueue => {
  if (queue.current === null) return { current: text, waiting: [] }
  const waiting = [...queue.waiting, text]
  return { current: queue.current, waiting: waiting.slice(-MAX_WAITING_SPEECH) }
}

/** 読み終わった。待っている先頭を読み上げ中にする */
export const advanceSpeech = (queue: SpeechQueue): SpeechQueue => {
  const [next, ...rest] = queue.waiting
  return next === undefined ? EMPTY_SPEECH_QUEUE : { current: next, waiting: rest }
}
