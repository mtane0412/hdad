/**
 * 手書きの線の描画
 *
 * 合成ページは、届いた線を積み上げた集まり（src/draw/strokes.ts）から、毎フレームここで描き直す。
 * フレーム間の状態を持たない（前のフレームの続きを足していかない）のは、このリポジトリの描画の約束に従うためである。
 *
 * 座標は箱の大きさに対する比で持っているので、描くときに canvas の画素へ直す。線の太さも箱の幅に対する比で
 * 決めるため、載せる箱の大きさが変わっても見え方が保たれる。
 */
import type { Strokes } from './strokes'

/**
 * 描画先。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * ブラウザの CanvasRenderingContext2D はこの形を満たす。
 */
export interface StrokeContext {
  lineWidth: number
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle: string | CanvasGradient | CanvasPattern
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  clearRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  fill(): void
}

/** 描画先の画素での大きさ */
export interface CanvasSize {
  readonly width: number
  readonly height: number
}

/** 線の色。Phase 1 では選べない（色と太さを選べるようにするのは issue #132） */
const STROKE_COLOR = '#ffffff'

/** 線の太さ（箱の幅に対する比）。800画素の箱で8画素になる */
const STROKE_WIDTH_RATIO = 0.01

/** 点を1つだけ打ったときに置く丸の半径（線の太さに対する比）。線の端と同じ太さに見えるよう半分にする */
const DOT_RADIUS_RATIO = 0.5

const FULL_CIRCLE = Math.PI * 2

/** 線の太さ（画素）。箱の幅に対する比で決める */
export const strokeWidth = (size: CanvasSize): number => size.width * STROKE_WIDTH_RATIO

/**
 * 積み上がっている線を、すべて描き直す。
 *
 * 点が1つだけの線は丸を置く。画面を1回つついただけのときに何も残らないと、描いたのに出ないと思われるためである。
 */
export const drawStrokes = (context: StrokeContext, strokes: Strokes, size: CanvasSize): void => {
  context.clearRect(0, 0, size.width, size.height)
  const 太さ = strokeWidth(size)
  context.lineWidth = 太さ
  context.strokeStyle = STROKE_COLOR
  context.fillStyle = STROKE_COLOR
  // 折れ曲がりと端を丸くすると、手で描いた線らしく見える
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const { points } of strokes.strokes) {
    const 画素の点 = points.map(({ x, y }) => ({ x: x * size.width, y: y * size.height }))
    const 最初 = 画素の点[0]
    if (最初 === undefined) continue
    context.beginPath()
    if (画素の点.length === 1) {
      context.arc(最初.x, 最初.y, 太さ * DOT_RADIUS_RATIO, 0, FULL_CIRCLE)
      context.fill()
      continue
    }
    context.moveTo(最初.x, 最初.y)
    for (const 点 of 画素の点.slice(1)) context.lineTo(点.x, 点.y)
    context.stroke()
  }
}
