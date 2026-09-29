/**
 * 消しゴムの当たり判定
 *
 * 描く画面（/draw/）の消しゴムは、なぞった範囲だけを削るのではなく、触れた線を1本まるごと消す。
 * ここではポインタの動き（前の位置から今の位置まで）が、どの線に触れたかだけを決める。消したことの配送は
 * 線の名前を指す合図（stroke.ts の StrokeErase）で行う。
 *
 * 座標は箱の大きさに対する比で持っているが、距離は画素に直してから測る。描く画面のキャンバスは16:9なので、
 * 比のまま測ると縦と横で当たりの広さが変わってしまう。
 *
 * 注意: ポインタの動きは飛び飛びに届くので、点どうしではなく「消しゴムが動いた線分」と「線の各区間」の
 * 距離で判定する。点だけで見ると、素早く動かしたときに細い線をまたいでも当たらない。
 */
import type { Point } from './stroke'
import type { Strokes } from './strokes'
import { strokeWidth, type CanvasSize } from './view'

/**
 * 消しゴムの半径（箱の幅に対する比）。
 *
 * 線の太さのぶん（半分）はこれとは別に当たりへ足すので、ここはポインタの先の遊びの大きさである。
 * 太さの「ふつう」と同じくらいにしてある。
 */
export const ERASER_RADIUS_RATIO = 0.01

/** 画素に直した1点 */
interface Pixel {
  readonly x: number
  readonly y: number
}

const toPixel = ({ x, y }: Point, size: CanvasSize): Pixel => ({ x: x * size.width, y: y * size.height })

/** 点 p から線分 a–b までの距離 */
const pointToSegment = (p: Pixel, a: Pixel, b: Pixel): number => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const 長さの2乗 = dx * dx + dy * dy
  // 線分の長さが0（点）なら、その点までの距離
  const t = 長さの2乗 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / 長さの2乗))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** 3点の向き（外積の符号） */
const cross = (o: Pixel, a: Pixel, b: Pixel): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

/** 線分 a–b と c–d が交わるか（端で接する場合・重なる場合は距離の側で拾えるので、ここでは真に交わるときだけ見る） */
const crosses = (a: Pixel, b: Pixel, c: Pixel, d: Pixel): boolean =>
  cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0

/** 線分 a–b と c–d の距離。交わっていれば0 */
const segmentToSegment = (a: Pixel, b: Pixel, c: Pixel, d: Pixel): number =>
  crosses(a, b, c, d) ? 0 : Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b))

/**
 * 消しゴムが from から to まで動いたときに触れた線の名前を、描かれた順に返す。
 *
 * @param strokes 画面に出ている線
 * @param from 消しゴムの前の位置（押した瞬間は to と同じ位置を渡す）
 * @param to 消しゴムの今の位置
 * @param size 描く場所の画素での大きさ（距離を画素で測るため）
 */
export const touchedStrokeIds = (strokes: Strokes, from: Point, to: Point, size: CanvasSize): string[] => {
  const 始点 = toPixel(from, size)
  const 終点 = toPixel(to, size)
  const 半径 = ERASER_RADIUS_RATIO * size.width
  return strokes.strokes
    .filter((stroke) => {
      const 当たりの幅 = 半径 + strokeWidth(size, stroke.width) / 2
      const 点 = stroke.points.map((point) => toPixel(point, size))
      // 各点を「ひとつ前の点からの区間」として見る。最初の点は長さ0の区間になるので、点が1つだけの線にも当たる
      return 点.some((終わり, i) => segmentToSegment(始点, 終点, 点[i - 1] ?? 終わり, 終わり) <= 当たりの幅)
    })
    .map(({ id }) => id)
}
