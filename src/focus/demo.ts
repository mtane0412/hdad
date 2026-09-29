/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだん映すものは、配信者が管理画面（/focus/）で取り上げたときに決まる。配信していないあいだや
 * 取り上げる前は何も映らないので、それでは OBS での配置や見栄えを決められない。そのため Worker に
 * 接続せずサンプルを順に流す道を用意する（サイドスーパー・アラートの ?demo=true と同じ考え方）。
 *
 * 注意: 上限いっぱいのサンプルを必ず1件入れる。いちばん場所を取る場合を見られないと、配信画面の
 * 他の要素とどこまで重なるかを決められないためである（src/side-super/demo.ts と同じ扱い）。
 * 上限の値は worker/focus-config.ts が持っているが、ブラウザ用のコードから worker/ を読み込まない
 * 約束なので、ここで同じ値を持ち直す。
 * 注意: アイコンは Twitch の画像を使わず、ページに埋め込んだ単色の画像にする（プレビューは Worker にも
 * Twitch にも接続しないため。丸く切り抜くのは focus.css）。
 */
import type { FocusTarget } from './focused'

/** 取り上げる本文の文字数の上限。worker/focus-config.ts の MAX_FOCUS_TEXT_LENGTH と揃える */
export const DEMO_FOCUS_TEXT_LENGTH = 500

/** 上限いっぱいの本文。長い語りをそのまま取り上げたときに、どこまで場所を取るかを見るためのもの */
const 上限いっぱいの本文 = 'これは私が小学生のころに住んでいた家で実際に起きたことなのですが、'.repeat(16).slice(0, DEMO_FOCUS_TEXT_LENGTH)

/** サンプルのアイコン。指定した色で塗りつぶした正方形を、ページに埋め込める画像（SVGのデータURL）にする */
const 単色のアイコン = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${color}"/></svg>`)}`

/** サンプルの1件（順に出し、一巡したらまた先頭から流す） */
export const demoFocused: readonly FocusTarget[] = [
  {
    messageId: 'demo-1',
    login: 'kowai_hanashi',
    displayName: '怖い話す人',
    text: '今から怖い話をするね',
    profileImageUrl: 単色のアイコン('#7b3ff2'),
  },
  {
    messageId: 'demo-2',
    login: 'zatsudan_suki',
    displayName: '雑談好き',
    text: 'キーボードは結局どれを買ったんですか？',
    profileImageUrl: 単色のアイコン('#1f9d8b'),
  },
  {
    messageId: 'demo-3',
    login: 'kowai_hanashi',
    displayName: '怖い話す人',
    text: 上限いっぱいの本文,
    profileImageUrl: 単色のアイコン('#7b3ff2'),
  },
]
