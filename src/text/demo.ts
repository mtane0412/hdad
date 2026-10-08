/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんのテキストは Worker から届くが、管理画面のプレビューでは Worker に接続しない。それでは OBS での配置や見栄えを
 * 決められないため、プレビューでは選んだテキストに関わらず、本文が書き換わっていく場面を順に流す（作業机の src/task-desk/demo.ts と同じ考え方）。
 *
 * 注意: 本文は上限（worker/text.ts の MAX_TEXT_BODY_LINES）ちょうどの4行のものを1件入れ、箱に収まる高さを確かめられるようにする。
 */
import type { TextEntry } from './entry'

/** プレビューで順に流すテキスト。同じテキストの本文を書き換えていく */
export const demoTexts: readonly TextEntry[] = [
  { id: 1, name: '今やってること', body: 'ログイン画面を作っています', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:00:00.000Z' },
  { id: 1, name: '今やってること', body: 'ログイン画面のテストを書いています', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:10:00.000Z' },
  {
    id: 1,
    name: '今やってること',
    body: '今日のゴール\n・ログイン画面を作り終える\n・テストを通す\n・デプロイして動かしてみる',
    mode: 'manual',
    instruction: '',
    writtenBy: 'human',
    updatedAt: '2026-10-08T12:20:00.000Z',
  },
]
