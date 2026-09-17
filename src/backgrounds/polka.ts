/**
 * polka: パステルカラーの水玉が並び、波が伝わるようにぷにぷに伸び縮みする背景
 *
 * 水玉は1行おきに半個ぶん横へずらして並べる（互い違いの配置）。
 * 大きさは位置と経過時間から直接求める（状態を持たない）。
 */
import { defineBackground, paintBackdrop, pickColor } from '../core/background'

/** 最も大きいときの水玉の半径（水玉の間隔に対する比率）。0.5未満なので隣と重ならない */
const MAX_RADIUS_RATIO = 0.32
/** 最も小さいときの水玉の大きさの比率 */
export const DOT_MIN_SCALE = 0.55
/** 行の間隔（水玉の間隔に対する比率）。正三角形の高さにすると、どの隣とも等距離になる */
const ROW_SPACING_RATIO = Math.sqrt(3) / 2
/** 伸び縮みの速さ（1秒あたりのラジアン） */
const PULSE_RATE = 1.2

/**
 * 水玉の大きさの比率（DOT_MIN_SCALE〜1）。位置によって位相をずらし、波が斜めに伝わるように見せる。
 *
 * @param column 列の位置（水玉の間隔で割った値）
 * @param row 行の位置（行の間隔で割った値）
 * @param time 経過時間（秒、速さを掛けた値）
 */
export const dotScale = (column: number, row: number, time: number): number => {
  const wave = 0.5 + 0.5 * Math.sin(column * 0.6 + row * 0.45 - time * PULSE_RATE)
  return DOT_MIN_SCALE + (1 - DOT_MIN_SCALE) * wave
}

export const polka = defineBackground({
  id: 'polka',
  title: 'Polka',
  description: 'パステルカラーの水玉が、波が伝わるようにぷにぷに伸び縮みする。',
  schema: {
    colors: {
      type: 'colors',
      default: ['#ffafcc', '#a2d2ff', '#b9fbc0'],
      minCount: 1,
      maxCount: 6,
      description: '水玉の色',
    },
    bg: { type: 'color', default: '#fff8e7', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 120, min: 24, max: 400, description: '水玉の間隔（px）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ colors, bg, size, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    const rowSpacing = size * ROW_SPACING_RATIO
    // 画面の端で水玉が欠けて見えるよう、半径ぶん外側の行・列まで描く
    for (let row = 0; (row - 1) * rowSpacing < height; row++) {
      // 奇数行は半個ぶん右へずらす
      const stagger = row % 2 === 0 ? 0 : 0.5
      for (let column = -1; (column - 1) * size < width; column++) {
        const gridX = column + stagger
        const radius = size * MAX_RADIUS_RATIO * dotScale(gridX, row, time * speed)
        // column は -1 から始まるため、1を足して0以上の番号にする
        ctx.fillStyle = pickColor(colors, column + 1 + row)
        ctx.beginPath()
        ctx.arc(gridX * size, row * rowSpacing, radius, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  },
})
