/**
 * アラートの再生待ちの列
 *
 * アラートは1件ずつ順番に再生する（重ねると素材も音も判別できなくなるため）。
 * 状態は「再生中の1件」と「待っているもの」だけで、どちらの操作も新しい状態を返す。
 */
import type { Alert } from './alert'

export interface AlertQueue {
  /** 再生中のアラート。何も再生していなければ null */
  readonly current: Alert | null
  /** 届いた順に待っているアラート */
  readonly waiting: readonly Alert[]
}

export const EMPTY_QUEUE: AlertQueue = { current: null, waiting: [] }

/** アラートが届いた。何も再生していなければすぐ再生中にし、再生中なら後ろに並べる */
export const enqueue = (queue: AlertQueue, alert: Alert): AlertQueue =>
  queue.current === null ? { current: alert, waiting: [] } : { current: queue.current, waiting: [...queue.waiting, alert] }

/** 再生が終わった。待っている先頭を再生中にする */
export const advance = (queue: AlertQueue): AlertQueue => {
  const [next, ...rest] = queue.waiting
  return next === undefined ? EMPTY_QUEUE : { current: next, waiting: rest }
}
