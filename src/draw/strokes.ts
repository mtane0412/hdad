/**
 * 描かれた線の集まり
 *
 * 合成ページは、届いた1通ずつ（stroke.ts の DrawMessage）をここで積み上げ、毎フレームこの集まりから
 * 描き直す（src/draw/view.ts）。描くときにフレーム間の状態を持たないための置き場である。
 *
 * 注意: 状態の移り変わりだけをここに置き、描画もWebSocketも持たない（src/focus/focused.ts と同じ形）。
 */
import type { DrawMessage, Point } from './stroke'

/** 描かれた線1本。点をつないだものが線になる */
export interface Stroke {
  readonly id: string
  readonly points: readonly Point[]
}

/** 画面に出ている線の集まり。描かれた順に並ぶ */
export interface Strokes {
  readonly strokes: readonly Stroke[]
}

/** まだ何も描かれていない状態 */
export const NO_STROKES: Strokes = { strokes: [] }

/**
 * 保つ線の本数の上限。
 *
 * 消すまで線は残るので、長い配信では際限なく増えうる。毎フレーム全部を描き直す作りなので、
 * 増え続けると合成ページが重くなる。上限を超えたぶんは古いものから落とす。
 */
export const MAX_STROKES = 500

/**
 * 届いた1通を積み上げる。
 *
 * 描き始め（start）を受け取っていない線の続き（extend）は捨てる。合成ページを線の途中で開いたときに
 * 起こることで、描き始めの分からない線は描きようがないためである（異常ではないので知らせない）。
 */
export const applyDrawMessage = (strokes: Strokes, message: DrawMessage): Strokes => {
  if (message.type === 'start') {
    // 同じ名前で描き始めが来たら、その線を引き直す（描く画面がつなぎ直して名前を振り直した場合）
    const 残す = strokes.strokes.filter(({ id }) => id !== message.id)
    const 足したもの = [...残す, { id: message.id, points: [message.point] }]
    return { strokes: 足したもの.slice(Math.max(0, 足したもの.length - MAX_STROKES)) }
  }
  const 対象 = strokes.strokes.find(({ id }) => id === message.id)
  if (対象 === undefined) return strokes
  return { strokes: strokes.strokes.map((stroke) => (stroke === 対象 ? { id: stroke.id, points: [...stroke.points, ...message.points] } : stroke)) }
}
