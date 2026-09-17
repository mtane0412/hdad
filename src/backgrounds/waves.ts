/**
 * waves: 半透明の波の層が重なり、それぞれ違う調子でゆらぐ背景
 *
 * 奥の層から順に「波形の線から画面の下端まで」を半透明で塗る。
 * 層が重なるほど色が濃くなるため、1色の指定だけで奥行きのある濃淡になる。
 */
import { defineBackground, paintBackdrop, withAlpha } from '../core/background'

/** 波の横方向の大きさの基準（px）。waveOffset の1単位に相当する長さ */
const FEATURE_SIZE = 420
/** 波の上下の振れ幅（画面の高さに対する比率） */
const AMPLITUDE_RATIO = 0.045
/** 最も奥の層・最も手前の層の基準の高さ（画面の高さに対する比率） */
const TOP_BASELINE = 0.45
const BOTTOM_BASELINE = 0.88
/** 1層あたりの不透明度 */
const LAYER_ALPHA = 0.35
/** 波形をなぞる横方向の刻み（px） */
const SAMPLE_STEP = 8

/**
 * 波の上下のずれ（-1〜1）。周期と速さの異なる2つの正弦波を重ね、層ごとに調子を変える。
 *
 * @param x 横位置（FEATURE_SIZE で割った値）
 * @param layer 層の番号（0が最も奥）
 * @param time 経過時間（秒、速さを掛けた値）
 */
export const waveOffset = (x: number, layer: number, time: number): number => {
  // 層ごとに位相をずらし、手前の層ほど少し速く動かす
  const phase = layer * 1.9
  const pace = 1 + layer * 0.15
  return (
    Math.sin(x * 1.1 + phase + time * 0.35 * pace) * 0.65 +
    Math.sin(x * 2.3 - phase * 1.7 - time * 0.22 * pace) * 0.35
  )
}

/**
 * 層の基準の高さ（画面の高さに対する比率）。層を上から下へ等間隔に並べる。
 *
 * @param layer 層の番号（0が最も奥）
 * @param layerCount 層の数（1以上）
 */
export const layerBaseline = (layer: number, layerCount: number): number => {
  // 1層だけの場合は0で割ることになるため、中間の高さに置く
  const position = layerCount === 1 ? 0.5 : layer / (layerCount - 1)
  return TOP_BASELINE + (BOTTOM_BASELINE - TOP_BASELINE) * position
}

export const waves = defineBackground({
  id: 'waves',
  title: 'Waves',
  description: '半透明の波が重なってゆらぐ。画面の下側に寄った、落ち着いた模様。',
  schema: {
    color: { type: 'color', default: '#5bc0be', description: '波の色' },
    bg: { type: 'color', default: '#0b132b', allowTransparent: true, description: '背景色' },
    layers: { type: 'number', integer: true, default: 5, min: 1, max: 8, description: '波の層の数' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, layers, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    ctx.fillStyle = withAlpha(color, LAYER_ALPHA)
    for (let layer = 0; layer < layers; layer++) {
      const baselineY = layerBaseline(layer, layers) * height
      ctx.beginPath()
      ctx.moveTo(0, height)
      // 右端を必ず含めるため、刻みの分だけ画面の外まで波形をなぞる
      for (let x = 0; x < width + SAMPLE_STEP; x += SAMPLE_STEP) {
        const offset = waveOffset(x / FEATURE_SIZE, layer, time * speed)
        ctx.lineTo(x, baselineY + offset * height * AMPLITUDE_RATIO)
      }
      ctx.lineTo(width + SAMPLE_STEP, height)
      ctx.closePath()
      ctx.fill()
    }
  },
})
