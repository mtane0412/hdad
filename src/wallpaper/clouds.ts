/**
 * clouds: もこもこの雲が、奥行きごとに違う速さで横へ流れていく背景
 *
 * 雲は、底を同じ高さに揃えた円（こぶ）を横に並べて作る。形は最初に乱数で決め、
 * 位置は経過時間から直接求める（状態を持たない）ため、フレーム落ちしても動きが飛ばない。
 */
import { createRandom, defineBackground, loopPosition, paintBackdrop } from '../core/background'

/** 雲の配置と形を決める乱数の種。固定値なので再読み込みしても同じ空になる */
const LAYOUT_SEED = 903
/** こぶの数の範囲 */
const MIN_PUFFS = 3
const MAX_PUFFS = 5
/** 隣り合うこぶの中心の間隔（雲の幅に対する比率）と、そのばらつきの幅 */
const PUFF_SPACING = 0.22
const PUFF_JITTER = 0.04
/** 両端のこぶの半径の範囲（雲の幅に対する比率） */
const END_RADIUS = 0.13
const END_RADIUS_VARIATION = 0.03
/** 内側のこぶの半径の下限と、真ん中へ向かって盛り上がる量（雲の幅に対する比率） */
const INNER_RADIUS = 0.16
const BULGE = 0.12
/** 雲の幅の範囲（px）。奥の雲ほど小さい */
const MIN_CLOUD_WIDTH = 140
const MAX_CLOUD_WIDTH = 520
/** 流れる速さの基準（1秒あたり、画面の幅に対する比率） */
const DRIFT_RATE = 0.01
/** 画面の外に取る余白（雲の幅に対する比率）。こぶ5個の雲の半分の幅（約0.62）より大きくする */
const MARGIN_RATIO = 0.7
/** 上下にふわふわ揺れる幅（雲の幅に対する比率）と速さ（1秒あたりのラジアン） */
const BOB_RATIO = 0.015
const BOB_RATE = 0.5

/** 雲を形作る円（こぶ）。座標は雲の幅をおよそ1とした比率で、y は上が負 */
export interface Puff {
  readonly x: number
  readonly y: number
  readonly radius: number
}

interface Cloud {
  /** 流れ始めの横位置（0〜1） */
  readonly x: number
  /** 縦位置（0〜1） */
  readonly y: number
  /** 奥行き（0=奥で小さく遅い、1=手前で大きく速い） */
  readonly depth: number
  /** 上下の揺れの位相 */
  readonly bobPhase: number
  readonly puffs: readonly Puff[]
}

/**
 * 雲1つ分のこぶの並びを作る。左から右へ並び、すべてのこぶの底が y=0 に揃う。
 * 両端は小さく真ん中ほど大きくして、盛り上がった雲の形にする。
 *
 * @param random 0以上1未満の乱数を返す関数（createRandom で作ったもの）
 */
export const createCloudPuffs = (random: () => number): Puff[] => {
  const count = MIN_PUFFS + Math.floor(random() * (MAX_PUFFS - MIN_PUFFS + 1))
  return Array.from({ length: count }, (_, index) => {
    const isEnd = index === 0 || index === count - 1
    // 両端で0、真ん中で1になる山なりの値
    const bulge = Math.sin((index / (count - 1)) * Math.PI)
    const radius = isEnd
      ? END_RADIUS + END_RADIUS_VARIATION * random()
      : INNER_RADIUS + BULGE * bulge * (0.8 + 0.2 * random())
    const x = (index - (count - 1) / 2) * PUFF_SPACING + (random() - 0.5) * PUFF_JITTER
    // 底を y=0 に揃えるため、中心を半径ぶんだけ上に置く
    return { x, y: -radius, radius }
  })
}

export const clouds = defineBackground({
  id: 'clouds',
  title: 'Clouds',
  description: 'もこもこの雲がゆっくり横へ流れる。のんびりした場面向け。',
  schema: {
    color: { type: 'color', default: '#ffffff', description: '雲の色' },
    bg: { type: 'color', default: '#a2d2ff', allowTransparent: true, description: '背景色' },
    count: { type: 'number', integer: true, default: 12, min: 1, max: 60, description: '雲の数' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, count, speed }) => {
    const random = createRandom(LAYOUT_SEED)
    const cloudList: Cloud[] = Array.from({ length: count }, () => ({
      x: random(),
      y: random(),
      depth: random(),
      bobPhase: random() * Math.PI * 2,
      puffs: createCloudPuffs(random),
    }))
    // 奥の雲から描いて、手前の雲が上に重なるようにする
    cloudList.sort((a, b) => a.depth - b.depth)

    return (frame) => {
      const { ctx, width, height, time } = frame
      paintBackdrop(frame, bg)
      ctx.fillStyle = color

      for (const cloud of cloudList) {
        const cloudWidth = MIN_CLOUD_WIDTH + (MAX_CLOUD_WIDTH - MIN_CLOUD_WIDTH) * cloud.depth
        const drifted = time * speed * DRIFT_RATE * (0.4 + cloud.depth)
        const x = loopPosition(cloud.x + drifted, width, cloudWidth * MARGIN_RATIO)
        const bob = Math.sin(time * speed * BOB_RATE + cloud.bobPhase) * cloudWidth * BOB_RATIO
        // 雲の底が画面の上端・下端に張り付かないよう、縦位置は画面の 15%〜90% に収める
        const y = (0.15 + 0.75 * cloud.y) * height + bob

        const first = cloud.puffs[0]
        const last = cloud.puffs.at(-1)
        if (!first || !last) throw new Error('雲のこぶが1つもないため、雲を描けませんでした')
        const baseHeight = Math.min(first.radius, last.radius)

        // こぶと底の帯を1つのパスにまとめて塗る（別々に塗ると、半透明の重なりが濃く見えてしまう）
        ctx.globalAlpha = 0.55 + 0.45 * cloud.depth
        ctx.beginPath()
        for (const puff of cloud.puffs) {
          const centerX = x + puff.x * cloudWidth
          const centerY = y + puff.y * cloudWidth
          ctx.moveTo(centerX + puff.radius * cloudWidth, centerY)
          ctx.arc(centerX, centerY, puff.radius * cloudWidth, 0, Math.PI * 2)
        }
        // こぶの間の下側のすき間を埋めて、底を平らにする
        ctx.rect(
          x + first.x * cloudWidth,
          y - baseHeight * cloudWidth,
          (last.x - first.x) * cloudWidth,
          baseHeight * cloudWidth,
        )
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
  },
})
