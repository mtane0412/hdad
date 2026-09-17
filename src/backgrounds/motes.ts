/**
 * motes: やわらかく光る粒が、揺れながらゆっくり昇っていく背景
 *
 * 粒の位置は経過時間から直接求める（状態を持たない）ため、フレーム落ちしても動きが飛ばない。
 * 光のぼかしは毎フレーム作ると重いので、最初に1枚の画像（スプライト）として用意して使い回す。
 */
import { createRandom, defineBackground, paintBackdrop, withAlpha } from '../core/background'

/** 粒の配置を決める乱数の種。固定値なので再読み込みしても同じ配置になる */
const LAYOUT_SEED = 412
/** 光のスプライトの一辺（px） */
const SPRITE_SIZE = 128
/** 粒の半径の範囲（px） */
const MIN_RADIUS = 3
const MAX_RADIUS = 38
/** 昇る速さの基準（1秒あたり、画面の高さに対する比率） */
const RISE_RATE = 0.012

interface Mote {
  /** 横位置（0〜1） */
  readonly x: number
  /** 昇り始めの縦位置（0〜1） */
  readonly y: number
  /** 奥行き（0=奥で小さく遅い、1=手前で大きく速い） */
  readonly depth: number
  /** 横揺れの位相 */
  readonly swayPhase: number
}

const createGlowSprite = (color: string): HTMLCanvasElement => {
  const sprite = document.createElement('canvas')
  sprite.width = SPRITE_SIZE
  sprite.height = SPRITE_SIZE
  const ctx = sprite.getContext('2d')
  if (!ctx) throw new Error('光のスプライト用の2D描画コンテキストを取得できませんでした')

  const center = SPRITE_SIZE / 2
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, withAlpha(color, 1))
  gradient.addColorStop(0.25, withAlpha(color, 0.6))
  gradient.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)
  return sprite
}

export const motes = defineBackground({
  id: 'motes',
  title: 'Motes',
  description: 'やわらかい光の粒が揺れながら昇る。奥行きがあり、落ち着いた場面向け。',
  schema: {
    color: { type: 'color', default: '#ffd9a0', description: '粒の色' },
    bg: { type: 'color', default: '#1a1423', allowTransparent: true, description: '背景色' },
    count: { type: 'number', integer: true, default: 70, min: 1, max: 400, description: '粒の数' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, count, speed }) => {
    const random = createRandom(LAYOUT_SEED)
    const particles: Mote[] = Array.from({ length: count }, () => ({
      x: random(),
      y: random(),
      // 2乗して奥（小さい粒）を多めにする
      depth: random() ** 2,
      swayPhase: random() * Math.PI * 2,
    }))
    // 奥の粒から描いて、手前の粒が上に重なるようにする
    particles.sort((a, b) => a.depth - b.depth)
    const sprite = createGlowSprite(color)

    return (frame) => {
      const { ctx, width, height, time } = frame
      paintBackdrop(frame, bg)

      for (const mote of particles) {
        const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * mote.depth
        const risen = time * speed * RISE_RATE * (0.4 + mote.depth)
        // 画面の上へ抜けたら下から戻るよう、粒の直径分の余白を含めて循環させる
        const span = height + radius * 2
        const y = ((((mote.y - risen) % 1) + 1) % 1) * span - radius
        const sway = Math.sin(time * speed * 0.3 + mote.swayPhase) * radius * 1.5
        const x = mote.x * width + sway

        ctx.globalAlpha = 0.25 + 0.6 * mote.depth
        ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2)
      }
      ctx.globalAlpha = 1
    }
  },
})
