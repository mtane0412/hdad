/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの行は配信中に GitHub の Webhook と cron の章づくりから届くので、配信していないあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、
 * サンプルの行が1行ずつ増えていく場面を順に流す（サイドスーパーの src/side-super/demo.ts と同じ考え方）。
 *
 * 注意: 3つの種類（コミット・マージ・AIのまとめ）をすべて入れる。機械が作った行と実際の出来事の見え方の違いを、
 * プレビューで確かめられるようにするためである。長い本文も1件入れ、折り返したときの幅を確かめられるようにする。
 */
import { mergeEntries, WORK_LOG_LIMIT, type WorkLogEntry } from './entry'

/** サンプルの行（古い順）。届いた順に1行ずつ増やす */
const SAMPLE_ENTRIES: readonly WorkLogEntry[] = [
  { id: 'chapter:demo-1', kind: 'chapter', at: '2026-10-03T12:00:00.000Z', text: '今日やることを決める' },
  { id: 'github:demo-1', kind: 'commit', at: '2026-10-03T12:18:00.000Z', text: '作業ログのテストを先に書く' },
  { id: 'github:demo-2', kind: 'commit', at: '2026-10-03T12:26:00.000Z', text: '開発の出来事を D1 に残し、配信中の合成ページへ押し出す' },
  { id: 'chapter:demo-2', kind: 'chapter', at: '2026-10-03T12:30:00.000Z', text: '作業ログの見た目を決める' },
  { id: 'github:demo-3', kind: 'merge', at: '2026-10-03T12:52:00.000Z', text: '#211 開発の出来事と章を、配信画面の「今日の作業ログ」に並べる' },
]

/** プレビューで順に流す場面。1つめは1行、最後はすべての行が新しい順に並ぶ */
export const demoWorkLogScenes: readonly (readonly WorkLogEntry[])[] = SAMPLE_ENTRIES.map((_entry, index) =>
  mergeEntries([], SAMPLE_ENTRIES.slice(0, index + 1), WORK_LOG_LIMIT),
)
