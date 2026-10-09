/**
 * テキストの素材のパラメータ宣言（映すテキスト・枠の種類・あふれの扱い）
 *
 * 合成ページ（overlay/stage/index.html）がレイヤーのパラメータ（構成が持つクエリ文字列）として読む。
 * 構成の素材（OverlayItem）は素材を見分けるIDを持たないので、どのテキストを映すかは素材のパラメータにテキストのIDとして持つ。
 * 本文はURLにもパラメータにも入れない（配信中に書き換えるものなので。docs/principles.md の3）。
 *
 * 枠は素材の箱いっぱいの固定の大きさで描くので、本文が収まらないときの扱い（固定・縮める・流す）も素材ごとに選ばせる。
 *
 * 注意: 管理画面（/overlay/）では、映すテキストを手で打たせず、テキストの名前の選択欄から選ばせる（方針2。src/overlay/overlay-page.tsx）。
 */
import type { ParamSchema } from '../core/params'

/** 札の枠の種類。見た目は text.css の text-board--<値> が決める */
export const TEXT_FRAMES = [
  { value: 'board', label: '板' },
  { value: 'window', label: 'メッセージウィンドウ' },
  { value: 'telop', label: 'テロップ帯' },
  { value: 'sticky', label: '付箋' },
] as const

/** 本文が枠に収まらないときの扱い */
export const TEXT_OVERFLOWS = [
  { value: 'clip', label: '文字の大きさは固定（あふれた分は隠す）' },
  { value: 'shrink', label: '収まるまで文字を縮める' },
  { value: 'marquee', label: '1行にまとめて横に流す' },
] as const

export type TextFrame = (typeof TEXT_FRAMES)[number]['value']
export type TextOverflow = (typeof TEXT_OVERFLOWS)[number]['value']

/**
 * テキストの素材のパラメータ。
 *
 * text は映すテキストのID。選んでいないあいだは空文字で、合成ページはその素材の箱にエラーを出す。
 * frame・overflow は既定値が #294 のころの見た目（板・あふれは隠す）なので、前から置いてある素材もそのまま読める。
 */
export const textParamSchema = {
  text: {
    type: 'string',
    default: '',
    pattern: /^[1-9][0-9]*$/,
    example: '3',
    description: '映すテキスト',
  },
  frame: { type: 'choice', default: 'board', choices: TEXT_FRAMES, description: '枠' },
  overflow: { type: 'choice', default: 'clip', choices: TEXT_OVERFLOWS, description: '本文が収まらないとき' },
} as const satisfies ParamSchema
