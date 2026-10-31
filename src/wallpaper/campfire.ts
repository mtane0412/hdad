/**
 * campfire: 夜の地面で薪が燃え、火の粉が舞い上がる背景。雑談の場面でずっと映しておくためのもの
 *
 * 炎は、根元から昇って消える光のかたまりをたくさん加算合成して作る。
 * かたまりと火の粉の姿は「番号」と「何回目の一生か（世代）」から決まる乱数と経過時間だけで求める（状態を持たない）ため、
 * フレーム落ちしても動きが飛ばない。周期の割り切れない波を重ねているので、同じ動きの繰り返しに見えない。
 * 光のぼかしは毎フレーム作ると重いので、温度ごとの画像（スプライト）を最初に用意して使い回す。
 * 焚き火は描画領域の中央下寄りに置き、大きさは領域の短いほうの辺に合わせる。
 */
import { createRandom, defineBackground, paintBackdrop, withAlpha, type Frame } from '../core/background'

/** 炎のかたまりの数 */
const PUFF_COUNT = 150
/** 火の粉の数 */
const SPARK_COUNT = 26
/** 炎のかたまりの一生の長さの基準（秒） */
const PUFF_LIFETIME = 1.25
/** 火の粉が生まれてから次に出直すまでの長さの基準（秒）。長いほど火の粉はまばらになる */
const SPARK_CYCLE = 7
/** 火の粉が見えている時間の、1周に対する割合 */
const SPARK_VISIBLE_RATIO = 0.55
/** 炎の根元の半幅（焚き火の大きさに対する比率） */
const BASE_HALF_WIDTH = 0.3
/** 炎のかたまりを描くときの不透明度の倍率。加算合成なので、高いと中心が白く飛ぶ */
const PUFF_OPACITY = 0.42
/** 火の粉に使う色の温度（0〜1）。橙色にあたる */
const SPARK_HEAT = 0.55
/** 焚き火の大きさの、描画領域の短いほうの辺に対する比率 */
const FIRE_SCALE = 0.56
/** 地面の高さの、描画領域の高さに対する比率 */
const GROUND_RATIO = 0.8
/** 黄金比の小数部。番号順に掛けると一生の始まりが均等にばらける */
const GOLDEN_RATIO = 0.6180339887
/** 火の粉の乱数の番号に足す値。同じ番号の炎のかたまりと同じ乱数列にならないようにする */
const SPARK_SEED_OFFSET = 100_000
/** 全周のラジアン */
const FULL_TURN = Math.PI * 2
/** 温度ごとのスプライトの数と一辺（px） */
const HEAT_STEPS = 16
const SPRITE_SIZE = 96
/** 広い光のスプライトの一辺（px）と色。大きく引き伸ばすので、炎より解像度を上げる */
const HALO_SPRITE_SIZE = 256
const HALO_COLOR = '#c8480e'
/** 広い光のグラデーションの段数。少ないと、暗い背景で輪の形の段差が見える */
const HALO_GRADIENT_STOPS = 24
/** 広い光の中心の高さと半径（焚き火の大きさに対する比率）。半径は照り返しが強いと広がる */
const HALO_CENTER_HEIGHT = 0.42
const HALO_BASE_RADIUS = 1.15
const HALO_RADIUS_SWING = 0.12
/** 広い光の不透明度（照り返しが0のときの値と、1のときに増える量） */
const HALO_BASE_ALPHA = 0.16
const HALO_ALPHA_SWING = 0.1
/** 地面の照り返しの位置（根元から下へ）・つぶし具合・半径（照り返しが強いと広がる） */
const GROUND_GLOW_OFFSET = 0.05
const GROUND_GLOW_SQUASH = 0.26
const GROUND_GLOW_BASE_RADIUS = 1.25
const GROUND_GLOW_RADIUS_SWING = 0.14
/** 手前の薪の上に残る熾火の幅と厚み（焚き火の大きさに対する比率）と不透明度 */
const COAL_WIDTH = 0.62
const COAL_THICKNESS = 0.2
const COAL_BASE_ALPHA = 0.2
const COAL_ALPHA_SWING = 0.3
/** 火の粉を光として描くときの、芯の半径に対する倍率 */
const SPARK_GLOW_RATIO = 2.2
/** 温度の低いほうから高いほうへ並べた炎の色。隣どうしを補間して使う */
const FLAME_RAMP: readonly (readonly [number, number, number])[] = [
  [150, 26, 4],
  [226, 72, 10],
  [255, 138, 30],
  [255, 208, 96],
  [255, 244, 210],
]

/** 炎のかたまり1つのある時刻の姿。長さは焚き火の大きさを1とする比率 */
export interface FlamePuff {
  /** 一生の進み具合（0〜1） */
  readonly life: number
  /** 炎の中心線からの横のずれ */
  readonly x: number
  /** 根元からの高さ（上向き） */
  readonly height: number
  readonly radius: number
  /** 温度（0〜1）。高いほど白く、低いほど赤い */
  readonly heat: number
  /** 不透明度（0〜1） */
  readonly alpha: number
}

/** 火の粉1つのある時刻の姿。長さは焚き火の大きさを1とする比率 */
export interface EmberSpark {
  readonly x: number
  readonly height: number
  readonly radius: number
  readonly alpha: number
}

/** 番号と世代を大きな素数で混ぜた乱数列を作る（近い番号・世代どうしが似ないようにする） */
const seededRandom = (index: number, generation: number): (() => number) =>
  createRandom(Math.imul(index + 1, 73856093) ^ Math.imul(generation + 1, 19349663))

/** 番号だけで決まる0以上1未満の値。一生の長さのように世代で変えない値に使い、毎コマ乱数列を作らずに済ませる */
const indexJitter = (index: number): number => (index * GOLDEN_RATIO) % 1

/**
 * 炎のかたまりの、ある時刻の姿を求める。
 *
 * @param index かたまりの番号
 * @param time 経過時間（秒。速さを掛けた値）
 */
export const flamePuff = (index: number, time: number): FlamePuff => {
  // 一生の長さは番号ごとに固定で少しずらす（世代ごとに変えると、変わる瞬間に動きが飛ぶ）
  const lifetime = PUFF_LIFETIME * (0.75 + 0.5 * indexJitter(index))
  const cycle = time / lifetime + index * GOLDEN_RATIO
  const generation = Math.floor(cycle)
  const life = cycle - generation

  const random = seededRandom(index, generation)
  // 2つの乱数を足して、中央のかたまりを多めにする
  const spread = random() + random() - 1
  const centrality = 1 - Math.abs(spread)
  // 中央のかたまりほど高くまで昇り、端は低いところで消える
  const peak = (0.34 + 0.6 * centrality) * (0.72 + 0.5 * random())
  const phase = random() * FULL_TURN

  const height = peak * life ** 0.8
  // 根元では広く、昇るほど中心線へ寄る
  const converging = spread * BASE_HALF_WIDTH * (1 - life) ** 1.3
  // 速い揺れは炎の舌を、遅い揺れは炎全体が傾く風を表す。どちらも上ほど大きい
  const lick = Math.sin(time * 3.1 + phase + height * 5) * 0.055 * height
  const lean = (Math.sin(time * 0.53) + Math.sin(time * 0.21 + 1.7)) * 0.07 * height

  return {
    life,
    x: converging + lick + lean,
    height,
    radius: (0.085 + 0.11 * centrality) * (1 - life) ** 0.55,
    heat: (1 - life) ** 1.3 * (0.6 + 0.4 * centrality),
    alpha: Math.sin(life * Math.PI) ** 0.75 * (1 - life) ** 0.35,
  }
}

/**
 * 火の粉の、ある時刻の姿を求める。1周のうち最初の一部だけ見えていて、残りは透明のまま待つ。
 *
 * @param index 火の粉の番号
 * @param time 経過時間（秒。速さを掛けた値）
 */
export const emberSpark = (index: number, time: number): EmberSpark => {
  const cycleLength = SPARK_CYCLE * (0.7 + 0.6 * indexJitter(index))
  const cycle = time / cycleLength + index * GOLDEN_RATIO
  const generation = Math.floor(cycle)
  const visible = (cycle - generation) / SPARK_VISIBLE_RATIO
  const random = seededRandom(index + SPARK_SEED_OFFSET, generation)

  const origin = (random() * 2 - 1) * BASE_HALF_WIDTH * 0.8
  // 高さの上限は描画領域の上端（約1.43）に収める。高さは地面の割合と焚き火の大きさの比から決まり、領域の縦横比に寄らない
  const rise = 0.55 + 0.7 * random()
  const drift = (random() * 2 - 1) * 0.35
  const phase = random() * FULL_TURN
  const radius = 0.004 + 0.006 * random()
  if (visible >= 1) return { x: origin, height: 0, radius, alpha: 0 }

  // 昇りはじめが速く、上へ行くほどゆるむ
  const height = 0.15 + rise * (1 - (1 - visible) ** 2)
  const swirl = Math.sin(time * 1.9 + phase) * 0.05 * height
  const twinkle = 0.7 + 0.3 * Math.sin(time * 11 + phase)
  return {
    x: origin + drift * visible + swirl,
    height,
    radius,
    alpha: Math.sin(visible * Math.PI) ** 0.5 * (1 - visible) ** 0.6 * twinkle,
  }
}

/**
 * 焚き火の照り返しの明るさ（0〜1）。周期の割り切れない波を重ねて、ゆっくりしたうねりに細かいちらつきを乗せる。
 *
 * @param time 経過時間（秒。速さを掛けた値）
 */
export const firelight = (time: number): number =>
  0.5 +
  0.2 * Math.sin(time * 0.9) +
  0.14 * Math.sin(time * 2.3 + 1.1) +
  0.1 * Math.sin(time * 5.7 + 2.4) +
  0.06 * Math.sin(time * 11.3 + 0.6)

/** 温度（0〜1）に対応する炎の色を、隣り合う色の補間で「#rrggbb」形式にする */
export const flameColor = (heat: number): string => {
  const position = heat * (FLAME_RAMP.length - 1)
  const lowerIndex = Math.min(Math.floor(position), FLAME_RAMP.length - 2)
  const lower = FLAME_RAMP[lowerIndex]
  const upper = FLAME_RAMP[lowerIndex + 1]
  if (!lower || !upper) throw new Error('炎の色を決められませんでした')
  const blend = position - lowerIndex
  const channels = lower.map((channel, channelIndex) =>
    Math.round(channel + ((upper[channelIndex] ?? channel) - channel) * blend),
  )
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/** 指定した色の、中心が明るく外へ向かって消える円のスプライトを作る */
const createGlowSprite = (color: string): HTMLCanvasElement => {
  const sprite = document.createElement('canvas')
  sprite.width = SPRITE_SIZE
  sprite.height = SPRITE_SIZE
  const ctx = sprite.getContext('2d')
  if (!ctx) throw new Error('炎のスプライト用の2D描画コンテキストを取得できませんでした')

  const center = SPRITE_SIZE / 2
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, withAlpha(color, 0.9))
  gradient.addColorStop(0.4, withAlpha(color, 0.42))
  gradient.addColorStop(1, withAlpha(color, 0))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)
  return sprite
}

/** 大きく引き伸ばす広い光のスプライトを作る。中心から外へなめらかに消えるよう、段を細かく刻む */
const createHaloSprite = (): HTMLCanvasElement => {
  const sprite = document.createElement('canvas')
  sprite.width = HALO_SPRITE_SIZE
  sprite.height = HALO_SPRITE_SIZE
  const ctx = sprite.getContext('2d')
  if (!ctx) throw new Error('広い光のスプライト用の2D描画コンテキストを取得できませんでした')

  const center = HALO_SPRITE_SIZE / 2
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center)
  for (let stop = 0; stop <= HALO_GRADIENT_STOPS; stop++) {
    const position = stop / HALO_GRADIENT_STOPS
    gradient.addColorStop(position, withAlpha(HALO_COLOR, (1 - position) ** 2))
  }
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, HALO_SPRITE_SIZE, HALO_SPRITE_SIZE)
  return sprite
}

/** 薪1本の形。長さは焚き火の大きさを1とする比率で、原点は炎の根元 */
interface Log {
  readonly x: number
  readonly y: number
  readonly length: number
  readonly thickness: number
  /** 傾き（ラジアン） */
  readonly angle: number
}

/** 炎の後ろに組む薪 */
const BACK_LOGS: readonly Log[] = [
  { x: 0.12, y: -0.06, length: 0.72, thickness: 0.085, angle: 0.5 },
  { x: -0.12, y: -0.06, length: 0.72, thickness: 0.085, angle: -0.5 },
]
/** 炎の手前に組む薪 */
const FRONT_LOGS: readonly Log[] = [
  { x: -0.09, y: 0.015, length: 0.78, thickness: 0.1, angle: 0.2 },
  { x: 0.1, y: 0.03, length: 0.74, thickness: 0.105, angle: -0.17 },
]

/** 薪を描く。上の面が炎に照らされ、切り口は明るい */
const drawLog = (
  ctx: CanvasRenderingContext2D,
  log: Log,
  originX: number,
  originY: number,
  size: number,
  light: number,
): void => {
  const halfLength = (log.length * size) / 2
  const halfThickness = (log.thickness * size) / 2
  // 照り返しの明るさに応じて、上の面の赤みを強める
  const litRed = Math.round(70 + 62 * light)
  const litGreen = Math.round(38 + 26 * light)

  ctx.save()
  ctx.translate(originX + log.x * size, originY + log.y * size)
  ctx.rotate(log.angle)
  const bark = ctx.createLinearGradient(0, -halfThickness, 0, halfThickness)
  bark.addColorStop(0, `rgb(${litRed}, ${litGreen}, 22)`)
  bark.addColorStop(0.55, '#2a170e')
  bark.addColorStop(1, '#0f0805')
  ctx.fillStyle = bark
  ctx.beginPath()
  ctx.roundRect(-halfLength, -halfThickness, halfLength * 2, halfThickness * 2, halfThickness)
  ctx.fill()
  // 切り口（年輪の見える端）
  for (const end of [-1, 1]) {
    ctx.fillStyle = `rgb(${litRed + 22}, ${litGreen + 18}, 36)`
    ctx.beginPath()
    ctx.ellipse(end * (halfLength - halfThickness * 0.5), 0, halfThickness * 0.45, halfThickness * 0.9, 0, 0, FULL_TURN)
    ctx.fill()
  }
  ctx.restore()
}

/** 地面に落ちる照り返しを、炎の根元を中心に横長の楕円で描く */
const drawGroundGlow = (frame: Frame, originX: number, originY: number, size: number, light: number): void => {
  const { ctx } = frame
  ctx.save()
  ctx.translate(originX, originY + size * GROUND_GLOW_OFFSET)
  // 円のグラデーションを縦に潰して楕円にする
  ctx.scale(1, GROUND_GLOW_SQUASH)
  const radius = size * (GROUND_GLOW_BASE_RADIUS + GROUND_GLOW_RADIUS_SWING * light)
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius)
  glow.addColorStop(0, withAlpha('#d9641c', 0.4 + 0.2 * light))
  glow.addColorStop(0.45, withAlpha('#7a2c10', 0.22 + 0.1 * light))
  glow.addColorStop(1, withAlpha('#7a2c10', 0))
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(0, 0, radius, 0, FULL_TURN)
  ctx.fill()
  ctx.restore()
}

export const campfire = defineBackground({
  id: 'campfire',
  title: 'Campfire',
  description: '夜の焚き火。薪が燃えて火の粉が舞う。雑談でずっと映しておく場面向け。',
  schema: {
    bg: { type: 'color', default: '#0a0910', allowTransparent: true, description: '背景色' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ bg, speed }) => {
    const sprites = Array.from({ length: HEAT_STEPS }, (_, step) => createGlowSprite(flameColor(step / (HEAT_STEPS - 1))))
    const haloSprite = createHaloSprite()

    return (frame) => {
      const { ctx, width, height, time } = frame
      paintBackdrop(frame, bg)

      const fireTime = time * speed
      const light = firelight(fireTime)
      const size = Math.min(width, height) * FIRE_SCALE
      const originX = width / 2
      const originY = height * GROUND_RATIO

      drawGroundGlow(frame, originX, originY, size, light)

      // 炎のまわりの空気が照らされる広い光
      const haloRadius = size * (HALO_BASE_RADIUS + HALO_RADIUS_SWING * light)
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = HALO_BASE_ALPHA + HALO_ALPHA_SWING * light
      ctx.drawImage(haloSprite, originX - haloRadius, originY - size * HALO_CENTER_HEIGHT - haloRadius, haloRadius * 2, haloRadius * 2)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1

      for (const log of BACK_LOGS) drawLog(ctx, log, originX, originY, size, light)

      // 炎。重なるほど白く明るくなるよう加算合成する
      ctx.globalCompositeOperation = 'lighter'
      for (let index = 0; index < PUFF_COUNT; index++) {
        const puff = flamePuff(index, fireTime)
        const sprite = sprites[Math.round(Math.min(1, puff.heat) * (HEAT_STEPS - 1))]
        if (!sprite) throw new Error('炎のスプライトを選べませんでした')
        const radius = puff.radius * size
        ctx.globalAlpha = puff.alpha * PUFF_OPACITY
        ctx.drawImage(sprite, originX + puff.x * size - radius, originY - puff.height * size - radius, radius * 2, radius * 2)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1

      for (const log of FRONT_LOGS) drawLog(ctx, log, originX, originY, size, light)

      // 火の粉と、手前の薪の上に残る熾火の照り
      ctx.globalCompositeOperation = 'lighter'
      const coalSprite = sprites[Math.round(SPARK_HEAT * (HEAT_STEPS - 1))]
      if (!coalSprite) throw new Error('熾火のスプライトを選べませんでした')
      const coalWidth = size * COAL_WIDTH
      ctx.globalAlpha = COAL_BASE_ALPHA + COAL_ALPHA_SWING * light
      ctx.drawImage(coalSprite, originX - coalWidth / 2, originY - (size * COAL_THICKNESS) / 2, coalWidth, size * COAL_THICKNESS)

      for (let index = 0; index < SPARK_COUNT; index++) {
        const spark = emberSpark(index, fireTime)
        if (spark.alpha <= 0) continue
        // 芯だけでは細すぎて配信の圧縮で消えるので、ぼかした光として大きめに描く
        const radius = Math.max(spark.radius * size, 1) * SPARK_GLOW_RATIO
        ctx.globalAlpha = spark.alpha
        ctx.drawImage(coalSprite, originX + spark.x * size - radius, originY - spark.height * size - radius, radius * 2, radius * 2)
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }
  },
})
