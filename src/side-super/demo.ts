/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの文言は cron（worker/collect.ts）が5分おきに作って貯めるものなので、配信していないあいだや
 * 作られる前は何も映らない。それでは OBS での配置や見栄えを決められないため、Worker に接続せず
 * サンプルの文言を順に流す道を用意する（アラートの src/alerts/demo.ts と同じ考え方）。
 *
 * サンプルは実際に出る文言と同じ形（見出しと本文の2行）にする。文字数の上限は worker/side-super.ts が
 * 持っているが、ブラウザ用のコードから worker/ を読み込まない約束なので、ここで同じ値を持ち直す
 * （src/side-super/view.ts が SIDE_SUPER_LINES を持ち直しているのと同じ扱い）。
 *
 * 注意: 上限いっぱいのサンプルを必ず1件入れる。いちばん幅を取る場合を見られないと、
 * 配信画面の他の要素とどこまで重なるかを決められないためである。
 */

/** 見出しの文字数の上限。worker/side-super.ts の MAX_SIDE_SUPER_HEAD_LENGTH と揃える */
export const DEMO_SIDE_SUPER_HEAD_LENGTH = 14

/** 本文の文字数の上限。worker/side-super.ts の MAX_SIDE_SUPER_BODY_LENGTH と揃える */
export const DEMO_SIDE_SUPER_BODY_LENGTH = 20

/** サンプルの文言（見出し・本文）。順に1件ずつ出し、一巡したらまた先頭から流す */
export const demoSideSupers: readonly (readonly [string, string])[] = [
  ['初見プレイ中', 'ボス戦へ向けて装備集め'],
  ['視聴者と雑談', 'おすすめのキーボードの話'],
  ['もくもく作業', 'サイドスーパーのCSSを直す'],
  // 上限いっぱい（見出し14文字・本文20文字）。テロップがいちばん幅を取る場合
  ['はじめての自作キーボード作り', 'キースイッチの打鍵音をみんなで聞き比べ中'],
]
