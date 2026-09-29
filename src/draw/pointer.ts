/**
 * 描く画面のポインタの読み取り
 *
 * 描く画面のキャンバスと、合成ページで手書きを置く箱は大きさが違う。送るのは画素ではなくキャンバスの
 * 大きさに対する比なので、ここでその変換を受け持つ（src/draw/stroke.ts の Point）。
 */
import type { Point } from './stroke'

/** キャンバスの画面上の位置と大きさ（DOMRect のうち使うものだけ） */
export interface CanvasRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * ポインタの位置を、キャンバスの大きさに対する比に直す。
 *
 * キャンバスの外へはみ出した位置（0未満・1より大きい）もそのまま返す。ポインタをキャンバスの外まで
 * 動かすことは普通に起こるので、縁で切り詰めると線が縁に張り付いて見える。
 */
export const toRatio = (clientX: number, clientY: number, rect: CanvasRect): Point => ({
  // まだ大きさを測れていない（0）ときは左上として扱う（0で割らない）
  x: rect.width === 0 ? 0 : (clientX - rect.left) / rect.width,
  y: rect.height === 0 ? 0 : (clientY - rect.top) / rect.height,
})

/** 線の名前に使う連番。同じページで引いた線どうしを区別する */
let 連番 = 0

/** 名前の頭に付ける、このページを表すランダムな文字。つなぎ直したあとも前の線と混ざらないようにする */
const 頭 = Math.random().toString(36).slice(2, 10)

/**
 * 新しい線の名前を作る。
 *
 * 長さは stroke.ts の上限（64文字）に収まる。
 */
export const createStrokeId = (): string => {
  連番 += 1
  return `${頭}-${連番}`
}
