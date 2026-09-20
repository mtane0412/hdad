/**
 * チャットボックス「terminal」（端末）
 *
 * 画面全体を黒い端末に見立て、等幅の文字で「> 名前 本文」の形に並べる。プログラミング配信向け。
 * 名前は端末の反転表示のように名前色で塗り、文字色を自動で切り替えて読みやすさを保つ。
 * 見た目は terminal.css に書き、ここではパラメータをCSSのカスタムプロパティへ変換する。
 */
import { commonChatSchema, defineChat, panelColor } from './definition'

export const terminal = defineChat({
  id: 'terminal',
  title: '端末',
  description: '等幅の文字が並ぶ、黒い端末風のデザイン。最新の書き込みの末尾でカーソルが点滅する。',
  schema: {
    ...commonChatSchema,
    size: { type: 'number', integer: true, default: 24, min: 12, max: 72, description: '文字の大きさ（px）' },
    panel: { type: 'color', default: '#0c0f12', allowTransparent: true, description: '画面の色' },
    opacity: { type: 'number', default: 0.85, min: 0, max: 1, description: '画面の不透明度' },
    text: { type: 'color', default: '#c8f7c5', description: '文字の色' },
  },
  cssVariables: ({ size, panel, opacity, text }) => ({
    '--chat-size': `${size}px`,
    '--chat-panel': panelColor(panel, opacity),
    '--chat-text': text,
  }),
})
