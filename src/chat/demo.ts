/**
 * サンプルの書き込み（?demo=true）
 *
 * Twitchへ接続せずに、配置や配色を確かめるための書き込みを順番に流す。
 * ギャラリーのプレビューもこれを使う（調整のたびにTwitchへ接続し直さないため）。
 * 長文・エモート・バッジ・/me など、見た目が変わる要素をひととおり含める。
 */
import { twitchEmoteUrl, type ChatMessage } from './message'
import type { ChatView } from './view'

/** 次のサンプルを流すまでの間隔（ミリ秒） */
const INTERVAL_MS = 2200
/** 開始時にまとめて表示しておく件数（空の画面では配置を確かめにくいため） */
const INITIAL_COUNT = 3
/** Twitchの全体用エモート「Kappa」のID */
const KAPPA_EMOTE_ID = '25'

/** 付帯情報（/me・初回・継続月数・ビッツ・返信元）は、示したいサンプルだけが指定する */
type Optional = 'action' | 'firstMessage' | 'returningChatter' | 'subscriberMonths' | 'bits' | 'reply'
type Sample = Omit<ChatMessage, 'id' | 'login' | 'sentAt' | Optional> & Partial<Pick<ChatMessage, Optional>>

const SAMPLES: readonly Sample[] = [
  {
    displayName: 'たねのぶ',
    color: '#ff69b4',
    badges: ['broadcaster'],
    fragments: [{ type: 'text', text: 'きてくれてありがとう！ゆっくりしていってね' }],
  },
  {
    displayName: 'mod_no_hito',
    color: '#2e8b57',
    badges: ['moderator', 'subscriber'],
    fragments: [{ type: 'text', text: 'こんばんは〜' }],
  },
  {
    displayName: 'ながぶんさん',
    color: '#1e90ff',
    badges: ['subscriber'],
    subscriberMonths: 24,
    fragments: [
      {
        type: 'text',
        text: '長い書き込みがどこで折り返されるかを確かめるためのサンプルです。ふきだしの幅は画面の幅に合わせて決まります。',
      },
    ],
  },
  {
    displayName: 'henshin_suru_hito',
    color: '#ff4500',
    badges: [],
    reply: { displayName: 'ながぶんさん', body: '長い書き込みがどこで折り返されるかを確かめるための…', messageId: 'demo-reply' },
    fragments: [{ type: 'text', text: 'たしかにそうですね' }],
  },
  {
    displayName: 'cheer_suru_hito',
    color: '#8a2be2',
    badges: ['subscriber'],
    subscriberMonths: 6,
    bits: 500,
    fragments: [{ type: 'text', text: 'cheer500 おうえんしています！' }],
  },
  {
    displayName: 'emote_daisuki',
    color: '#daa520',
    badges: ['vip'],
    fragments: [
      { type: 'text', text: 'ナイス ' },
      { type: 'emote', name: 'Kappa', url: twitchEmoteUrl(KAPPA_EMOTE_ID) },
      { type: 'text', text: ' ' },
      { type: 'emote', name: 'Kappa', url: twitchEmoteUrl(KAPPA_EMOTE_ID) },
    ],
  },
  {
    displayName: 'はじめての人',
    color: '#0000ff',
    badges: [],
    firstMessage: true,
    fragments: [{ type: 'text', text: '初見です！' }],
  },
  {
    displayName: 'odoru_hito',
    color: '#9acd32',
    badges: [],
    fragments: [{ type: 'text', text: 'おどっている' }],
    action: true,
  },
]

/** サンプルの書き込みを流し始める */
export const startDemo = (view: ChatView): void => {
  let count = 0
  const addNext = (): void => {
    const sample = SAMPLES[count % SAMPLES.length]
    if (!sample) throw new Error('サンプルの書き込みが1件もありません')
    view.add({
      ...sample,
      id: `demo-${count}`,
      login: sample.displayName,
      action: sample.action ?? false,
      // サンプルは流した時刻をそのまま書き込み時刻とする
      sentAt: Date.now(),
      firstMessage: sample.firstMessage ?? false,
      returningChatter: sample.returningChatter ?? false,
      subscriberMonths: sample.subscriberMonths ?? 0,
      bits: sample.bits ?? 0,
      reply: sample.reply,
    })
    count += 1
  }
  for (let index = 0; index < INITIAL_COUNT; index += 1) addNext()
  window.setInterval(addNext, INTERVAL_MS)
}
