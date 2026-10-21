/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの人形の獲得は人形を自動で渡したときだけ流れるので、それ以外のあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、決まった獲得を順にくり返し流す
 * （ペロペロの src/lick/demo.ts と同じ考え方）。プレビューは配信者の素材を読めない（オーバーレイ用キーを持たない）ので、
 * 人形の画像はこのファイルに埋め込んだ図形にする。
 */
import type { DollAwardCall } from './call'

/** プレビューで人形の代わりに出す図形（丸い顔の人形の形） */
const DEMO_DOLL_IMAGE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 160"><circle cx="60" cy="48" r="40" fill="#f2c6a0"/><rect x="24" y="84" width="72" height="68" rx="24" fill="#e0625c"/></svg>',
  )

/** プレビューで流す獲得。ふつうの人形1つと、スーパー人形3つ */
export const DEMO_DOLL_AWARDS: readonly DollAwardCall[] = [
  { id: 'demo-normal', userName: '視聴者', kind: 'normal', count: 1, doll: { name: '人形', imageUrl: DEMO_DOLL_IMAGE } },
  { id: 'demo-super', userName: '視聴者', kind: 'super', count: 3, doll: { name: 'スーパー人形', imageUrl: DEMO_DOLL_IMAGE } },
]

/** プレビューで次の獲得を流す間隔（ミリ秒）。1回の表示（view.ts の SHOW_MS）を流しきるだけの間を置く */
export const DEMO_DOLL_AWARD_INTERVAL_MS = 8_000
