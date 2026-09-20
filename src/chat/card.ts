/**
 * チャットボックス「card」（カード）
 *
 * 書き込みごとに、左端に名前色の縦ラインが入った横長のカードを表示する。
 * 名前色は明暗がまちまちなので文字色には使わず、縦ラインだけに使って読みやすさを保つ。
 * 見た目は card.css に書き、ここではパラメータをCSSのカスタムプロパティへ変換する。
 */
import { commonChatSchema, defineChat, panelColor } from './definition'

export const card = defineChat({
  id: 'card',
  title: 'カード',
  description: '左端に名前色のラインが入った、半透明の落ち着いたカード。名前と本文を上下に並べる。',
  schema: {
    ...commonChatSchema,
    size: { type: 'number', integer: true, default: 26, min: 12, max: 72, description: '文字の大きさ（px）' },
    panel: { type: 'color', default: '#1e1826', allowTransparent: true, description: 'カードの色' },
    opacity: { type: 'number', default: 0.85, min: 0, max: 1, description: 'カードの不透明度' },
    text: { type: 'color', default: '#ffffff', description: '文字の色' },
  },
  cssVariables: ({ size, panel, opacity, text }) => ({
    '--chat-size': `${size}px`,
    '--chat-panel': panelColor(panel, opacity),
    '--chat-text': text,
  }),
})
