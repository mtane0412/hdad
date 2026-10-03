/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの行は配信中に視聴者の !task・!done から届くので、配信していないあいだは何も並ばない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、
 * 宣言が増えていき、1人が完了して祝われる場面を順に流す（作業ログの src/work-log/demo.ts と同じ考え方）。
 *
 * 注意: 作業の文言は上限（40文字）ちょうどのものを1件入れ、折り返したときの幅を確かめられるようにする。
 * 並びは Worker（worker/task-desk-store.ts の readTaskDesk）と同じく、未完了を宣言の新しい順、そのあとに完了した行にする。
 * みんなの作業時間の合計も場面ごとに持つ。読んだ時刻（measuredAt）は持たず、合成ページが場面を映した時刻を入れる
 * （固定の時刻にすると、プレビューを開いた時刻までの経過時間が足されて合計が大きくなりすぎるため）。
 */
import type { TaskDeskEntry, TaskDeskWorkTime } from './entry'

const tanaka: TaskDeskEntry = { userId: 'demo-1', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:00:00.000Z', doneAt: null }
const suzuki: TaskDeskEntry = { userId: 'demo-2', name: 'すずき', task: '洗濯物をたたむ', declaredAt: '2026-10-03T12:05:00.000Z', doneAt: null }
const yamada: TaskDeskEntry = {
  userId: 'demo-3',
  name: 'やまだ',
  task: '来週の発表の資料を最後まで作り、話す順番と時間配分を決めて一度通して練習しておく',
  declaredAt: '2026-10-03T12:10:00.000Z',
  doneAt: null,
}
const tanakaDone: TaskDeskEntry = { ...tanaka, doneAt: '2026-10-03T12:30:00.000Z' }

/** プレビューの1場面。並べる行と、その場面の作業時間の合計（読んだ時刻は映すときに決める） */
export interface DemoTaskDeskScene {
  readonly entries: TaskDeskEntry[]
  readonly workTime: Omit<TaskDeskWorkTime, 'measuredAt'>
}

const MINUTE = 60 * 1000

/** プレビューで順に流す場面。3人が順に宣言し、最初に宣言した人が完了する */
export const demoTaskDeskScenes: readonly DemoTaskDeskScene[] = [
  { entries: [tanaka], workTime: { people: 1, totalMs: 5 * MINUTE, working: 1 } },
  { entries: [suzuki, tanaka], workTime: { people: 2, totalMs: 15 * MINUTE, working: 2 } },
  { entries: [yamada, suzuki, tanaka], workTime: { people: 3, totalMs: 35 * MINUTE, working: 3 } },
  { entries: [yamada, suzuki, tanakaDone], workTime: { people: 3, totalMs: 75 * MINUTE, working: 2 } },
]
