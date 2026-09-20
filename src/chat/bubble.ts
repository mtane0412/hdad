/**
 * チャットボックス「bubble」（ふきだし）
 *
 * 書き込みごとに、ユーザーの名前色で塗った名札と、角の丸いふきだしを表示する。
 * 名前色は人によって明暗がまちまちなので、文字色ではなく名札の地色に使い、名札の文字色を自動で切り替えて読みやすさを保つ。
 * 見た目は bubble.css に書き、ここではパラメータをCSSのカスタムプロパティへ変換する。
 */
import { commonChatSchema, defineChat, panelColor } from './definition'

export const bubble = defineChat({
  id: 'bubble',
  title: 'ふきだし',
  description: '名前色の名札が付いた、角の丸いふきだし。新しい書き込みが下から入り、古いものは上へ流れていく。',
  schema: {
    ...commonChatSchema,
    size: { type: 'number', integer: true, default: 28, min: 12, max: 72, description: '文字の大きさ（px）' },
    panel: { type: 'color', default: '#ffffff', allowTransparent: true, description: 'ふきだしの色' },
    opacity: { type: 'number', default: 0.95, min: 0, max: 1, description: 'ふきだしの不透明度' },
    text: { type: 'color', default: '#2b2433', description: '文字の色' },
  },
  cssVariables: ({ size, panel, opacity, text }) => ({
    '--chat-size': `${size}px`,
    '--chat-panel': panelColor(panel, opacity),
    '--chat-text': text,
  }),
})
