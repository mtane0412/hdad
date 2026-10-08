/**
 * テキストの素材のパラメータ宣言（映すテキスト）
 *
 * 合成ページ（overlay/stage/index.html）がレイヤーのパラメータ（構成が持つクエリ文字列）として読む。
 * 構成の素材（OverlayItem）は素材を見分けるIDを持たないので、どのテキストを映すかは素材のパラメータにテキストのIDとして持つ。
 * 本文はURLにもパラメータにも入れない（配信中に書き換えるものなので。docs/principles.md の3）。
 *
 * 注意: 管理画面（/overlay/）では、この値を手で打たせず、テキストの名前の選択欄から選ばせる（方針2。src/overlay/overlay-page.tsx）。
 */
import type { ParamSchema } from '../core/params'

/** 映すテキストのID。選んでいないあいだは空文字で、合成ページはその素材の箱にエラーを出す */
export const textParamSchema = {
  text: {
    type: 'string',
    default: '',
    pattern: /^[1-9][0-9]*$/,
    example: '3',
    description: '映すテキスト',
  },
} as const satisfies ParamSchema
