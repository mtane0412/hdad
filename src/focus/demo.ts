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
 */
import type { FocusedMessage } from './focused'

/** 取り上げる本文の文字数の上限。worker/focus-config.ts の MAX_FOCUS_TEXT_LENGTH と揃える */
export const DEMO_FOCUS_TEXT_LENGTH = 500

/** 上限いっぱいの本文。長い語りをそのまま取り上げたときに、どこまで場所を取るかを見るためのもの */
const 上限いっぱいの本文 = 'これは私が小学生のころに住んでいた家で実際に起きたことなのですが、'.repeat(16).slice(0, DEMO_FOCUS_TEXT_LENGTH)

/** サンプルの1件（順に出し、一巡したらまた先頭から流す） */
export const demoFocused: readonly FocusedMessage[] = [
  {
    messageId: 'demo-1',
    login: 'kowai_hanashi',
    displayName: '怖い話す人',
    fragments: [{ type: 'text', text: '今から怖い話をするね' }],
  },
  {
    messageId: 'demo-2',
    login: 'zatsudan_suki',
    displayName: '雑談好き',
    fragments: [{ type: 'text', text: 'キーボードは結局どれを買ったんですか？' }],
  },
  {
    messageId: 'demo-3',
    login: 'kowai_hanashi',
    displayName: '怖い話す人',
    fragments: [{ type: 'text', text: 上限いっぱいの本文 }],
  },
]
