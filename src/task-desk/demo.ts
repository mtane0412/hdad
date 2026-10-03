/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの行は配信中に視聴者の !task・!done から届くので、配信していないあいだは何も並ばない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、
 * 宣言が増えていき、1人が完了して祝われる場面を順に流す（作業ログの src/work-log/demo.ts と同じ考え方）。
 *
 * 注意: 作業の文言は上限（40文字）ちょうどのものを1件入れ、折り返したときの幅を確かめられるようにする。
 * 並びは Worker（worker/task-desk-store.ts の readTaskDesk）と同じく、未完了を宣言の新しい順、そのあとに完了した行にする。
 */
import type { TaskDeskEntry } from './entry'

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

/** プレビューで順に流す場面。3人が順に宣言し、最初に宣言した人が完了する */
export const demoTaskDeskScenes: readonly (readonly TaskDeskEntry[])[] = [
  [tanaka],
  [suzuki, tanaka],
  [yamada, suzuki, tanaka],
  [yamada, suzuki, tanakaDone],
]
