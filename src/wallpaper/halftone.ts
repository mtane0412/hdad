/**
 * halftone: 印刷の網点のように並んだ点が、波に合わせて膨らんだり縮んだりする背景
 *
 * 点は1行おきに半マスずらして並べ、flowField の値を点の半径に対応させる。
 */
import { defineBackground, flowField, paintBackdrop } from '../core/background'

/** 模様の細かさの基準（px）。flowField の1単位に相当する長さ */
const FEATURE_SIZE = 520
/** 点の最大半径（点の間隔に対する比率）。斜め隣の点までの距離は間隔の約0.71倍なので、0.35 を超えると重なる */
const MAX_RADIUS_RATIO = 0.34
/** これより小さい点は描かない（px） */
const MIN_VISIBLE_RADIUS = 0.3

export const halftone = defineBackground({
  id: 'halftone',
  title: 'Halftone',
  description: '印刷の網点が波打つ。明るい配色が既定で、雑談や待機画面向け。',
  schema: {
    color: { type: 'color', default: '#bc4749', description: '点の色' },
    bg: { type: 'color', default: '#f2e8cf', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 28, min: 8, max: 120, description: '点の間隔（px）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, size, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    const rowHeight = size * 0.5
    ctx.fillStyle = color
    ctx.beginPath()
    for (let row = 0; row * rowHeight < height + size; row++) {
      const offset = row % 2 === 0 ? 0 : size / 2
      const y = row * rowHeight
      for (let x = offset; x < width + size; x += size) {
        const value = flowField(x / FEATURE_SIZE, y / FEATURE_SIZE, time * speed)
        const radius = ((value + 1) / 2) * size * MAX_RADIUS_RATIO
        if (radius < MIN_VISIBLE_RADIUS) continue
        ctx.moveTo(x + radius, y)
        ctx.arc(x, y, radius, 0, Math.PI * 2)
      }
    }
    ctx.fill()
  },
})
