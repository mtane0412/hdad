/**
 * 手書きの線の描画
 *
 * 合成ページは、届いた線を積み上げた集まり（src/draw/strokes.ts）から、毎フレームここで描き直す。
 * フレーム間の状態を持たない（前のフレームの続きを足していかない）のは、このリポジトリの描画の約束に従うためである。
 *
 * 座標は箱の大きさに対する比で持っているので、描くときに canvas の画素へ直す。線の太さも箱の幅に対する比で
 * 決めるため、載せる箱の大きさが変わっても見え方が保たれる。
 *
 * 線には縁取りを付ける。配信画面には明るいところも暗いところもあるので、1色で描くとどちらかで沈むためである。
 * 縁取りは「同じ形を少し太い暗色で描いてから、その上に本来の色で描く」ことで作る（2度描き）。
 */
import { colorOf, widthOf } from './tools'
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

/** 縁取りの色。どの線の色とも溶け合わないよう、選べる色には置いていない暗い色にする */
const OUTLINE_COLOR = '#000000'

/** 縁取りのぶんだけ太くする割合。線の太さに対する比で、細い線でも縁が見えるだけの幅を確保する */
const OUTLINE_RATIO = 0.5

/** 点を1つだけ打ったときに置く丸の半径（線の太さに対する比）。線の端と同じ太さに見えるよう半分にする */
const DOT_RADIUS_RATIO = 0.5

const FULL_CIRCLE = Math.PI * 2

/** 線の太さ（画素）。箱の幅に対する比で決める */
export const strokeWidth = (size: CanvasSize, widthId: string): number => size.width * widthOf(widthId).ratio

/**
 * 積み上がっている線を、すべて描き直す。
 *
 * 1本ごとに、縁取り（少し太い暗色）と本来の色で2度描く。点が1つだけの線は丸を置く。
 * 画面を1回つついただけのときに何も残らないと、描いたのに出ないと思われるためである。
 *
 * @throws 選べない色・太さの線が混じっていた場合（tools.ts。黙って既定で描くと、意図しない線が配信画面に出る）
 */
export const drawStrokes = (context: StrokeContext, strokes: Strokes, size: CanvasSize): void => {
  context.clearRect(0, 0, size.width, size.height)
  // 折れ曲がりと端を丸くすると、手で描いた線らしく見える
  context.lineCap = 'round'
  context.lineJoin = 'round'

  for (const { points, color, width } of strokes.strokes) {
    const 太さ = strokeWidth(size, width)
    const 画素の点 = points.map(({ x, y }) => ({ x: x * size.width, y: y * size.height }))
    const 最初 = 画素の点[0]
    if (最初 === undefined) continue

    // 同じ形を2度描く。1度目は外へはみ出す縁取り、2度目がその上に載る線そのものになる。
    // 丸は太さではなく半径で大きさが決まるので、段ごとにパスを引き直す（同じパスを塗り直しても縁は見えない）
    for (const 段 of [
      { 色: OUTLINE_COLOR, 太さ: 太さ * (1 + OUTLINE_RATIO) },
      { 色: colorOf(color).value, 太さ },
    ]) {
      context.lineWidth = 段.太さ
      context.strokeStyle = 段.色
      context.fillStyle = 段.色
      context.beginPath()
      if (画素の点.length === 1) {
        context.arc(最初.x, 最初.y, 段.太さ * DOT_RADIUS_RATIO, 0, FULL_CIRCLE)
        context.fill()
        continue
      }
      context.moveTo(最初.x, 最初.y)
      for (const 点 of 画素の点.slice(1)) context.lineTo(点.x, 点.y)
      context.stroke()
    }
  }
}
