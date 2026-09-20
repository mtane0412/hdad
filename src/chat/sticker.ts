/**
 * チャットボックス「sticker」（シール）
 *
 * 書き込みごとに、太いフチの付いたシールと、少し傾けて貼った名前色の名札を表示する。
 * 名前色は名札の地色に使い、名札の文字色を自動で切り替えて読みやすさを保つ。
 * 見た目は sticker.css に書き、ここではパラメータをCSSのカスタムプロパティへ変換する。
 */
import { commonChatSchema, defineChat } from './definition'

export const sticker = defineChat({
  id: 'sticker',
  title: 'シール',
  description: '太い白フチのシールに、少し傾いた名札を貼ったかわいいデザイン。新しい書き込みはぺたっと貼られる。',
  schema: {
    ...commonChatSchema,
    size: { type: 'number', integer: true, default: 28, min: 12, max: 72, description: '文字の大きさ（px）' },
    panel: { type: 'color', default: '#fff1f6', description: 'シールの色' },
    border: { type: 'color', default: '#ffffff', description: 'シールのフチの色' },
    text: { type: 'color', default: '#4a3340', description: '文字の色' },
  },
  cssVariables: ({ size, panel, border, text }) => ({
    '--chat-size': `${size}px`,
    '--chat-panel': panel,
    '--chat-border': border,
    '--chat-text': text,
  }),
})
