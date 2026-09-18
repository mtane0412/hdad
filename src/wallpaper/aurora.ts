/**
 * aurora: 大きくぼけた色の霧が、画面の中をゆっくり漂う背景
 *
 * 配色の各色を1つの円形グラデーションとして描き、それぞれ周期の異なる楕円軌道で動かす。
 */
import { defineBackground, paintBackdrop, withAlpha } from '../core/background'

/** 霧1つの半径（画面の短辺に対する比率） */
const BLOB_RADIUS_RATIO = 0.75
/** 霧の中心の不透明度 */
const BLOB_ALPHA = 0.55
/** 軌道を一周する基準の速さ（ラジアン/秒） */
const ORBIT_RATE = 0.05

export const aurora = defineBackground({
  id: 'aurora',
  title: 'Aurora',
  description: 'ぼけた色の霧がゆっくり漂う。ゲーム画面や枠の後ろに置いても邪魔になりにくい。',
  schema: {
    colors: {
      type: 'colors',
      default: ['#1d7874', '#7b2d5b', '#f4a259'],
      minCount: 2,
      maxCount: 6,
      description: '霧の色（カンマ区切り）',
    },
    bg: { type: 'color', default: '#0d1321', allowTransparent: true, description: '背景色' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ colors, bg, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    const radius = Math.min(width, height) * BLOB_RADIUS_RATIO
    colors.forEach((color, index) => {
      // 色ごとに位相と周期をずらし、霧どうしが同じ動きにならないようにする
      const phase = (index / colors.length) * Math.PI * 2
      const angle = time * speed * ORBIT_RATE * (1 + index * 0.37) + phase
      const x = width * (0.5 + 0.38 * Math.cos(angle))
      const y = height * (0.5 + 0.34 * Math.sin(angle * 1.31 + phase))

      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
      gradient.addColorStop(0, withAlpha(color, BLOB_ALPHA))
      gradient.addColorStop(1, withAlpha(color, 0))
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)
    })
  },
})
