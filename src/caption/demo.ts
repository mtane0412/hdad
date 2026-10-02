/**
 * 字幕のサンプル（合成ページのプレビュー ?demo=true）
 *
 * ふだんの字幕はアプリの枠の音声認識から届くので、話していなければ何も映らない。それでは /overlay/ のプレビューで
 * 配置や見栄えを決められないため、中継先へつながずサンプルの発話を順に流す（再生中の曲の src/bgm/demo.ts と同じ考え方）。
 *
 * 注意: 長い発話のサンプルを必ず1件入れる。折り返して何行になるかを見られないと、配信画面の他の要素と
 * どこまで重なるかを決められないためである。
 */
import type { CaptionMessage } from './message'

/** サンプルの発話。話している途中の文が伸びていき、確定し、少し遅れて訳文が届く流れを順に流す */
export const demoCaptionMessages: readonly CaptionMessage[] = [
  { type: 'interim', text: 'こんばんは' },
  { type: 'interim', text: 'こんばんは今日は' },
  { type: 'final', id: 'demo-1', text: 'こんばんは、今日はゲームをやっていきます' },
  { type: 'translation', id: 'demo-1', text: "Good evening, I'm going to play a game today" },
  { type: 'interim', text: 'まずは' },
  { type: 'final', id: 'demo-2', text: 'まずは前回の続きから' },
  { type: 'translation', id: 'demo-2', text: "First, let's pick up where we left off" },
  { type: 'interim', text: '前回はボスの手前で' },
  {
    type: 'final',
    id: 'demo-3',
    text: '前回はボスの手前でセーブしたところで終わったので、今日はそこから装備を整えて、なんとか倒すところまで行けたらいいなと思っています',
  },
  {
    type: 'translation',
    id: 'demo-3',
    text: "Last time we stopped after saving right before the boss, so today I'd like to gear up from there and hopefully manage to beat it",
  },
]
