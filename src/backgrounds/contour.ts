/**
 * contour: 地形図の等高線のような線が、ゆっくり形を変えていく背景
 *
 * flowField の値を格子点で求め、マーチングスクエア法で高さごとの等高線を線分として描く。
 */
import { defineBackground, flowField, paintBackdrop } from '../core/background'

/** 格子1マスの大きさ（px）。小さいほど線がなめらかになるが描画が重くなる */
const CELL_SIZE = 20
/** 模様の細かさの基準（px）。scale=1 のとき、この長さが flowField の1単位になる */
const BASE_FEATURE_SIZE = 420
/** この本数ごとに1本、太い線（計曲線）にする */
const INDEX_LINE_INTERVAL = 4
const LINE_WIDTH = 1.5
const INDEX_LINE_WIDTH = 3

/** 辺の両端の値 a, b の間で、値が level になる位置（0〜1）を返す */
const crossing = (a: number, b: number, level: number): number => (level - a) / (b - a)

export const contour = defineBackground({
  id: 'contour',
  title: 'Contour',
  description: '地形図の等高線がゆっくり形を変える。線だけなので透過背景とも相性がよい。',
  schema: {
    color: { type: 'color', default: '#9bc1bc', description: '線の色' },
    bg: { type: 'color', default: '#1b2a2f', allowTransparent: true, description: '背景色' },
    levels: { type: 'number', integer: true, default: 14, min: 2, max: 40, description: '等高線の本数' },
    scale: { type: 'number', default: 1, min: 0.25, max: 4, description: '模様の大きさ' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, levels, scale, speed }) => {
    let field = new Float32Array(0)

    return (frame) => {
      const { ctx, width, height, time } = frame
      paintBackdrop(frame, bg)

      const columns = Math.ceil(width / CELL_SIZE) + 1
      const rows = Math.ceil(height / CELL_SIZE) + 1
      if (field.length !== columns * rows) field = new Float32Array(columns * rows)

      const featureSize = BASE_FEATURE_SIZE * scale
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          field[row * columns + column] = flowField(
            (column * CELL_SIZE) / featureSize,
            (row * CELL_SIZE) / featureSize,
            time * speed,
          )
        }
      }

      ctx.strokeStyle = color
      for (let levelIndex = 0; levelIndex < levels; levelIndex++) {
        // 高さを -1〜1 の内側に等間隔で並べる
        const level = -1 + (2 * (levelIndex + 1)) / (levels + 1)
        ctx.lineWidth = levelIndex % INDEX_LINE_INTERVAL === 0 ? INDEX_LINE_WIDTH : LINE_WIDTH
        ctx.beginPath()

        for (let row = 0; row < rows - 1; row++) {
          for (let column = 0; column < columns - 1; column++) {
            const index = row * columns + column
            // 範囲内の添字だが noUncheckedIndexedAccess のため既定値を添える
            const topLeft = field[index] ?? 0
            const topRight = field[index + 1] ?? 0
            const bottomLeft = field[index + columns] ?? 0
            const bottomRight = field[index + columns + 1] ?? 0

            // マスの4辺のうち、等高線が横切る辺の交点を集める
            const left = column * CELL_SIZE
            const top = row * CELL_SIZE
            const points: number[] = []
            if (topLeft > level !== topRight > level) {
              points.push(left + crossing(topLeft, topRight, level) * CELL_SIZE, top)
            }
            if (topRight > level !== bottomRight > level) {
              points.push(left + CELL_SIZE, top + crossing(topRight, bottomRight, level) * CELL_SIZE)
            }
            if (bottomLeft > level !== bottomRight > level) {
              points.push(left + crossing(bottomLeft, bottomRight, level) * CELL_SIZE, top + CELL_SIZE)
            }
            if (topLeft > level !== bottomLeft > level) {
              points.push(left, top + crossing(topLeft, bottomLeft, level) * CELL_SIZE)
            }

            // 交点は2個（線分1本）か4個（鞍点。線分2本として描く）のどちらかになる
            for (let i = 0; i + 3 < points.length; i += 4) {
              ctx.moveTo(points[i] ?? 0, points[i + 1] ?? 0)
              ctx.lineTo(points[i + 2] ?? 0, points[i + 3] ?? 0)
            }
          }
        }
        ctx.stroke()
      }
    }
  },
})
