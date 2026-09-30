/**
 * 描かれた線の集まり
 *
 * 合成ページは、届いた1通ずつ（stroke.ts の DrawMessage）をここで積み上げ、毎フレームこの集まりから
 * 描き直す（src/draw/view.ts）。描くときにフレーム間の状態を持たないための置き場である。
 *
 * 注意: 状態の移り変わりだけをここに置き、描画もWebSocketも持たない（src/focus/focused.ts と同じ形）。
 */
import { isPoint, isStrokeId, type DrawMessage, type Point } from './stroke'
import { isColorId, isWidthId } from './tools'

/** 描かれた線1本。点をつないだものが線になる */
export interface Stroke {
  readonly id: string
  readonly points: readonly Point[]
  /** 選ばれた色の名前（src/draw/tools.ts の DRAW_COLORS） */
  readonly color: string
  /** 選ばれた太さの名前（src/draw/tools.ts の DRAW_WIDTHS） */
  readonly width: string
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
 * 1本の線が持てる点の数の上限。
 *
 * 描いている最中は上限を気にせず点を追加していける長さ（毎秒30点なら2分ほどの連続した1本）にしてある。
 * 上限を設けるのは、この集まりをそのままKVへ保存する（worker/draw-config.ts）ためで、
 * 1本が際限なく長いと保存できる大きさに当たる。
 */
export const MAX_POINTS_PER_STROKE = 4000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 保存から読み出した1本ぶんとして読めるか。
 *
 * 保存した線を読み直す経路（Workerでの検証（worker/draw-config.ts）と、画面での応答の確かめ（src/draw/api.ts））が
 * どちらもこれを使う。2か所で書き分けると、片方だけが通す形ができてしまう。
 */
export const isStroke = (value: unknown): value is Stroke =>
  isRecord(value) &&
  isStrokeId(value.id) &&
  Array.isArray(value.points) &&
  value.points.length > 0 &&
  value.points.length <= MAX_POINTS_PER_STROKE &&
  value.points.every(isPoint) &&
  isColorId(value.color) &&
  isWidthId(value.width)

/**
 * 届いた1通を積み上げる。
 *
 * 描き始め（start）を受け取っていない線の続き（extend）と、無い線を消す合図（erase）は捨てる。合成ページを線の途中で開いたときや、
 * 全消しの直後に続きが届いたときに起こることで、描き始めの分からない線は描きようがないためである
 * （異常ではないので知らせない）。
 */
export const applyDrawMessage = (strokes: Strokes, message: DrawMessage): Strokes => {
  if (message.type === 'clear') return NO_STROKES
  if (message.type === 'erase') {
    // 無い線を消そうとしたとき（合成ページを途中で開いた場合など）は、元の集まりをそのまま返す
    if (!strokes.strokes.some(({ id }) => id === message.id)) return strokes
    return { strokes: strokes.strokes.filter(({ id }) => id !== message.id) }
  }
  if (message.type === 'start') {
    // 同じ名前で描き始めが来たら、その線を引き直す（描く画面がつなぎ直して名前を振り直した場合）
    const keep = strokes.strokes.filter(({ id }) => id !== message.id)
    const added = [...keep, { id: message.id, points: [message.point], color: message.color, width: message.width }]
    return { strokes: added.slice(Math.max(0, added.length - MAX_STROKES)) }
  }
  const target = strokes.strokes.find(({ id }) => id === message.id)
  if (target === undefined) return strokes
  return { strokes: strokes.strokes.map((stroke) => (stroke === target ? { ...stroke, points: [...stroke.points, ...message.points] } : stroke)) }
}
