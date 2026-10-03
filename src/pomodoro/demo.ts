/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんのタイマーはアプリのページ（/pomodoro/）で始めたときだけ届くので、始めていないあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、
 * 作業中・休憩中・一時停止中の札を順に流す（作業机の src/task-desk/demo.ts と同じ考え方）。
 *
 * 場面は「始めてから何分たったところか」で持ち、映し始めた時刻からタイマーを作る。描画は現在時刻だけから決まるので、
 * 映しているあいだも残り時間が進む。
 */
import type { PomodoroTimer } from './phase'

const MINUTE = 60 * 1000

/** プレビューの場面。始めてからの経過時間と、一時停止しているか */
export interface DemoPomodoroScene {
  readonly elapsedMs: number
  readonly paused: boolean
}

/** プレビューで順に流す場面。1本目の作業の途中・1本目の休憩の途中・2本目の作業を一時停止したところ */
export const demoPomodoroScenes: readonly DemoPomodoroScene[] = [
  { elapsedMs: 12 * MINUTE, paused: false },
  { elapsedMs: 27 * MINUTE, paused: false },
  { elapsedMs: 40 * MINUTE, paused: true },
]

/** 場面を、映し始めた時刻から作ったタイマーにする */
export const demoTimerOf = (scene: DemoPomodoroScene, shownAt: number): PomodoroTimer => {
  const startedAt = shownAt - scene.elapsedMs
  return { startedAt, anchorAt: startedAt, pausedAt: scene.paused ? shownAt : null }
}
