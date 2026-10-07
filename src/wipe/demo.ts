/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんのワイプはチャットが届いたときにしか出ないので、それでは OBS での配置や見栄えを決められない。そのため
 * 管理画面のプレビューでは Worker にも Twitch にも接続せず、サンプルを順に出す（注目コメントの ?demo=true と同じ考え方）。
 * プレビューでは読み上げもしない（管理画面で音が鳴り出さないため）。
 *
 * 注意: 長い発言のサンプルを必ず1件入れる。吹き出しがいちばん場所を取る場合（wipe.css が行数で打ち切る）を見られないと、
 * 配信画面のほかの要素とどこまで重なるかを決められないためである。
 * 注意: アイコンは Twitch の画像を使わず、ページに埋め込んだ単色の画像にする（src/focus/demo.ts と同じ扱い）。
 */
import type { ShownComment } from './runner'

/** サンプルのアイコン。指定した色で塗りつぶした正方形を、ページに埋め込める画像（SVGのデータURL）にする */
const solidIcon = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="${color}"/></svg>`)}`

/** サンプル1件を組み立てる（読み上げないので、読み上げ文は本文と同じにしておく） */
const sample = (messageId: string, login: string, displayName: string, text: string, color: string): ShownComment => ({
  comment: { messageId, login, displayName, fragments: [{ type: 'text', text }], spoken: text },
  profileImageUrl: solidIcon(color),
})

/** サンプルの並び（順に出し、一巡したらまた先頭から流す） */
export const demoWipeComments: readonly ShownComment[] = [
  sample('demo-1', 'hajimemashite', 'はじめまして', 'こんばんは！初見です', '#7b3ff2'),
  sample('demo-2', 'zatsudan_suki', '雑談好き', 'キーボードは結局どれを買ったんですか？', '#2e8b57'),
  sample(
    'demo-3',
    'nagabanashi',
    '長話の人',
    '昨日の配信のあと、言っていたゲームを買って朝まで遊んでしまいました。最初のボスで三回やられたんですが、教えてもらった避け方を試したら一発で倒せて感動しました。ありがとうございます！',
    '#d2691e',
  ),
]
