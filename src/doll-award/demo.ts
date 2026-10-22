/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの人形の獲得は人形を自動で渡したとき（所持数とランキングはコマンドや管理画面から出したとき）だけ流れるので、それ以外のあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、決まった獲得を順にくり返し流す
 * （ペロペロの src/lick/demo.ts と同じ考え方）。プレビューは配信者の素材を読めない（オーバーレイ用キーを持たない）ので、
 * 人形の画像はこのファイルに埋め込んだ図形にする。
 */
import type { DollAwardMessage } from './call'

/** プレビューで人形の代わりに出す図形（丸い顔の人形の形） */
const DEMO_DOLL_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><circle cx="60" cy="48" r="40" fill="#f2c6a0"/><rect x="24" y="84" width="72" height="68" rx="24" fill="#e0625c"/></svg>',
  )

/** プレビューで出す人形の名前と画像 */
const DEMO_NORMAL = { name: '人形', imageUrl: DEMO_DOLL_IMAGE }
const DEMO_SUPER = { name: 'スーパー人形', imageUrl: DEMO_DOLL_IMAGE }

/** プレビューで流すもの。ふつうの人形1つとスーパー人形3つの獲得、1人ぶんの所持数、ランキング */
export const DEMO_DOLL_AWARDS: readonly DollAwardMessage[] = [
  { type: 'award', id: 'demo-normal', userName: '視聴者', kind: 'normal', count: 1, doll: DEMO_NORMAL },
  { type: 'award', id: 'demo-super', userName: '視聴者', kind: 'super', count: 3, doll: DEMO_SUPER },
  { type: 'standing', id: 'demo-standing', userId: 'demo-viewer', userName: '視聴者', normal: { ...DEMO_NORMAL, count: 2 }, super: { ...DEMO_SUPER, count: 1 } },
  {
    type: 'ranking',
    id: 'demo-ranking',
    normal: DEMO_NORMAL,
    super: DEMO_SUPER,
    entries: [
      { rank: 1, userName: '視聴者A', normal: 2, super: 1, points: 5 },
      { rank: 2, userName: '視聴者B', normal: 0, super: 1, points: 3 },
      { rank: 2, userName: '視聴者C', normal: 3, super: 0, points: 3 },
      { rank: 4, userName: '視聴者D', normal: 1, super: 0, points: 1 },
    ],
  },
]

/**
 * プレビューで次を流す間隔（ミリ秒）。獲得と所持数の表示（view.ts の SHOW_MS）を流しきるだけの間を置く。
 * ランキング（RANKING_SHOW_MS）はこれより長いが、届いた順に1件ずつ出すので重ならず、1巡の合計は間隔の合計に収まる
 */
export const DEMO_DOLL_AWARD_INTERVAL_MS = 8_000
