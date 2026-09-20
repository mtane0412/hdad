/**
 * チャットボックス「plain」（文字だけ）
 *
 * 地を塗らず、フチ取りした文字だけを「名前 本文」の形で並べる。ゲーム画面などの上に直接重ねる用途向け。
 * 名前は名前色で表示し、フチは名前色の明暗に合わせて白か黒に切り替えて読みやすさを保つ（plain.css 参照）。
 * 見た目は plain.css に書き、ここではパラメータをCSSのカスタムプロパティへ変換する。
 */
import { commonChatSchema, defineChat } from './definition'

export const plain = defineChat({
  id: 'plain',
  title: '文字だけ',
  description: '地を塗らず、フチ取りした文字だけを並べる。ゲーム画面の上に直接重ねても邪魔になりにくい。',
  schema: {
    ...commonChatSchema,
    size: { type: 'number', integer: true, default: 28, min: 12, max: 72, description: '文字の大きさ（px）' },
    text: { type: 'color', default: '#ffffff', description: '本文の文字の色' },
    outline: { type: 'color', default: '#1e1826', description: '本文の文字のフチの色' },
  },
  cssVariables: ({ size, text, outline }) => ({
    '--chat-size': `${size}px`,
    '--chat-text': text,
    '--chat-outline': outline,
  }),
})
