/**
 * 段でひとつにまとめたポーリングの割り当て
 *
 * 合成ページの段には、読みに行く間隔の違うものが同居する（注目コメントは10秒、サイドスーパーは30秒）。
 * 素直に書くとタイマーが読むものの数だけ増えるので、いちばん短い間隔を刻みにした1本のタイマーで回し、
 * 刻みごとに「この回で読むもの」を選ぶ（issue #101 の「ポーリングは段で1つのタイマーにまとめる」）。
 *
 * 時刻もタイマーも持ち込まない計算だけを置くので、ここだけを取り出してテストできる。
 */

/** 読みに行くもの1つ。間隔だけを見るので、実際に読む処理は呼び出し側（stage.ts）が持つ */
export interface PollInterval {
  /** 読みに行く間隔（ミリ秒） */
  readonly intervalMs: number
}

/**
 * 1本のタイマーの刻み（ミリ秒）を決める。
 *
 * いちばん短い間隔に合わせる。長いほうに合わせると、短い間隔で読みたいものが遅れてしまう。
 */
export const pollTickMs = (tasks: readonly PollInterval[]): number => Math.min(...tasks.map((task) => task.intervalMs))

/**
 * その刻みで読むものを選ぶ。
 *
 * @param tasks 読みに行くもの
 * @param tickMs タイマーの刻み（pollTickMs）
 * @param tickIndex 何回目の刻みか（1から数える）
 * @returns この回で読むもの。刻みより短い間隔のものは毎回読む（刻みを下回って読むことはできない）
 */
export const dueTasks = <T extends PollInterval>(tasks: readonly T[], tickMs: number, tickIndex: number): T[] =>
  tasks.filter((task) => tickIndex % Math.max(1, Math.round(task.intervalMs / tickMs)) === 0)
