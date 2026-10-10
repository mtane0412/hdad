/**
 * 漢字クイズの時間切れで配信を止める流れ（issue #302）
 *
 * 1. 受付の締め切りに、時間切れ（正解者なし）を確かめて停止を始め、合成ページと下部バーへ猶予を知らせる（judgeKanjiQuizTimeout）
 * 2. 猶予のあいだに下部バーで取り消されたら、取り消したことを知らせる（cancelKanjiQuizStopsAndNotify）
 * 3. 猶予が尽きたら、鍵を確保してから裏方へ配信を止める命令を送る（sendKanjiQuizStop）
 *
 * 1 と 3 の時刻は Durable Object のアラームが受け持ち（kanji-quiz-timer.ts）、ここは時刻が来たときにすることだけを持つ。
 * 状態（停止を始めたか・取り消したか・命令を送ったか）は D1 の kanji_quizzes に持つ（kanji-quiz-store.ts）。
 *
 * 注意: 猶予を知らせられなかったら止めない（止める時刻を仕掛けない）。配信者が猶予を見られず取り消せないまま配信が止まるより、
 *   止まらないほうに倒す。失敗は投げ、呼び出し側（kanji-quiz-timer.ts）が kanji-quiz-stop-failed として記録する。
 * 注意: 試し再生（rehearsal）の出題は、猶予を知らせるだけで止める時刻を仕掛けない（演出の最後に「止めません」と出すのは合成ページ）。
 */
import { pushKanjiQuizNotice, pushStreamStop, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import { beginKanjiQuizStop, cancelKanjiQuizStops, claimKanjiQuizStop } from './kanji-quiz-store'

/** 時間切れから配信を止めるまでの猶予（ミリ秒）。このあいだ下部バーから取り消せる。設定にはしない */
export const KANJI_QUIZ_STOP_GRACE_MS = 10_000

/** 停止の流れに使うもの */
export interface KanjiQuizStopDeps {
  readonly db: Database
  readonly alerts: AlertChannelNamespace
  readonly now: number
}

/**
 * 受付の締め切りに呼ぶ。正解者がいなければ停止を始め、猶予を知らせて、猶予が尽きる時刻に停止を仕掛ける。
 *
 * @param scheduleStop 猶予が尽きる時刻に sendKanjiQuizStop を呼ぶよう仕掛ける（Durable Object のアラーム）
 * @throws 猶予を知らせられなかった・停止を仕掛けられなかった場合
 */
export const judgeKanjiQuizTimeout = async (
  { db, alerts, now }: KanjiQuizStopDeps,
  quizId: string,
  scheduleStop: (stop: { readonly quizId: string; readonly at: number }) => Promise<void>,
): Promise<void> => {
  const started = await beginKanjiQuizStop(db, quizId, now, KANJI_QUIZ_STOP_GRACE_MS)
  // 正解者がいた・もう始めたなどで始めなかったら、何もしない
  if (started === null) return
  // 先に知らせる。知らせられなければ投げて、止める時刻を仕掛けない（取り消せないまま止めない）
  await pushKanjiQuizNotice(alerts, { type: 'stopping', quizId, graceMs: KANJI_QUIZ_STOP_GRACE_MS, rehearsal: started.rehearsal })
  if (started.rehearsal) return
  await scheduleStop({ quizId, at: now + KANJI_QUIZ_STOP_GRACE_MS })
}

/**
 * 猶予が尽きたときに呼ぶ。取り消されていなければ鍵を確保して、裏方へ配信を止める命令を送る。
 *
 * @returns 命令を送ったか（取り消された・試し再生・もう送った出題なら false）
 * @throws 命令を送れなかった場合（裏方がつながっていない場合を含む）。鍵は確保したままにして、2回止めない
 */
export const sendKanjiQuizStop = async ({ db, alerts, now }: KanjiQuizStopDeps, quizId: string): Promise<boolean> => {
  if (!(await claimKanjiQuizStop(db, quizId, now))) return false
  await pushStreamStop(alerts, { quizId })
  return true
}

/**
 * 猶予のあいだの停止をすべて取り消し、合成ページと下部バーへ取り消したことを知らせる（下部バーの取り消しボタン）。
 *
 * @returns 取り消した出題の識別子
 * @throws 取り消したことを知らせられなかった場合（取り消しそのものは済んでいる）
 */
export const cancelKanjiQuizStopsAndNotify = async ({ db, alerts, now }: KanjiQuizStopDeps): Promise<string[]> => {
  const quizIds = await cancelKanjiQuizStops(db, now)
  for (const quizId of quizIds) await pushKanjiQuizNotice(alerts, { type: 'stopCancelled', quizId })
  return quizIds
}
