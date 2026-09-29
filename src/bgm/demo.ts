/**
 * 再生中の曲のサンプル（合成ページのプレビュー ?demo=true）
 *
 * ふだんの曲は管理画面（/bgm/）で選んだものが押し出されてくるので、曲を止めているあいだは何も映らない。
 * それでは /overlay/ のプレビューで配置や見栄えを決められないため、Worker に接続せずサンプルの曲を順に流す
 * （サイドスーパーの src/side-super/demo.ts と同じ考え方）。
 *
 * 注意: 上限いっぱい（曲名60文字・クレジット表記100文字。worker/bgm-config.ts）のサンプルを必ず1件入れる。
 * いちばん場所を取る場合を見られないと、配信画面の他の要素とどこまで重なるかを決められないためである。
 */
import type { BgmCreditTrack } from './credit-view'

/** サンプルの曲。順に1件ずつ出し、一巡したらまた先頭から流す */
export const demoBgmTracks: readonly BgmCreditTrack[] = [
  { mediaId: 'demo-zatsudan', title: 'ひだまりの午後', credit: '音楽: 甘茶の音楽工房' },
  { mediaId: 'demo-moriagari', title: '全力疾走', credit: '音楽: DOVA-SYNDROME' },
  // 上限いっぱい（曲名60文字・クレジット表記100文字）。表示がいちばん場所を取る場合
  { mediaId: 'demo-nagai', title: 'あ'.repeat(60), credit: 'い'.repeat(100) },
]
