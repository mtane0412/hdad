/**
 * sparkles: 四方に光の伸びたきらきらが、あちこちでまたたく背景
 *
 * きらきらは「現れる → 大きくなる → 消える」を繰り返し、消えた瞬間に次の位置へ移る。
 * 位置は「きらきらの番号」と「何回目のまたたきか（世代）」だけから決まる乱数で求めるため、
 * フレーム間の状態を持たずに、毎回違う場所へ現れる動きを作れる。
 */
import { createRandom, defineBackground, paintBackdrop, pickColor } from '../core/background'

/** またたく頻度の基準（1秒あたりの回数）。0.25 なら1回のまたたきは約4秒 */
const TWINKLE_RATE = 0.25
/** きらきらの大きさ（中心から光の先までの長さ、px）の範囲 */
const MIN_RADIUS = 8
const MAX_RADIUS = 44
/** 光のくびれ具合。0に近いほど細く鋭い十字になり、大きいほどひし形に近づく */
const PINCH_RATIO = 0.08
/** 1回のまたたきの間に回る角度（ラジアン、45度） */
const TURN_PER_TWINKLE = Math.PI / 4
/** 4分の1回転（90度）のラジアン */
const QUARTER_TURN = Math.PI / 2

/**
 * きらきらの大きさの比率（0〜1）。cycle が1進むごとに、0 → 1 → 0 と1回またたく。
 * 3乗することで、消えている時間を長く、光る瞬間を短くしている。
 *
 * @param cycle 経過時間 × またたく頻度 + きらきらごとのずれ
 */
export const twinkle = (cycle: number): number => {
  const progress = cycle - Math.floor(cycle)
  return Math.sin(progress * Math.PI) ** 3
}

/**
 * きらきらの位置（x, y）と大きさの比率（scale）。いずれも0以上1未満。
 *
 * @param index きらきらの番号
 * @param generation 世代（何回目のまたたきか）。変わるたびに別の位置へ移る
 */
export const sparklePlacement = (
  index: number,
  generation: number,
): { readonly x: number; readonly y: number; readonly scale: number } => {
  // 番号と世代を大きな素数で混ぜて、近い番号・世代どうしの配置が似ないようにする
  const random = createRandom(Math.imul(index + 1, 73856093) ^ Math.imul(generation + 1, 19349663))
  return { x: random(), y: random(), scale: random() }
}

/**
 * 原点を中心にした、四方へ光の伸びた星形の輪郭をパスに追加する。
 *
 * @param radius 中心から光の先までの長さ（px）
 */
const traceSparkle = (ctx: CanvasRenderingContext2D, radius: number): void => {
  ctx.beginPath()
  ctx.moveTo(0, -radius)
  for (let tip = 1; tip <= 4; tip++) {
    // 光の先どうしを、中心の近くへ引き寄せた曲線で結ぶ（内側へえぐれた形になる）
    const pinchAngle = (tip - 0.5) * QUARTER_TURN - QUARTER_TURN
    const tipAngle = tip * QUARTER_TURN - QUARTER_TURN
    ctx.quadraticCurveTo(
      Math.cos(pinchAngle) * radius * PINCH_RATIO,
      Math.sin(pinchAngle) * radius * PINCH_RATIO,
      Math.cos(tipAngle) * radius,
      Math.sin(tipAngle) * radius,
    )
  }
  ctx.closePath()
}

export const sparkles = defineBackground({
  id: 'sparkles',
  title: 'Sparkles',
  description: 'きらきらがあちこちでまたたく。ゆめかわいい雰囲気の場面向け。',
  schema: {
    colors: {
      type: 'colors',
      default: ['#ffffff', '#fff3b0', '#ffc8dd'],
      minCount: 1,
      maxCount: 6,
      description: 'きらきらの色',
    },
    bg: { type: 'color', default: '#a990dd', allowTransparent: true, description: '背景色' },
    count: { type: 'number', integer: true, default: 40, min: 1, max: 300, description: 'きらきらの数' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ colors, bg, count, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    for (let index = 0; index < count; index++) {
      // きらきらごとのずれ。黄金比の小数部を掛けると、番号順でも均等にばらける
      const phase = (index * 0.618) % 1
      const cycle = time * speed * TWINKLE_RATE + phase
      const size = twinkle(cycle)
      if (size === 0) continue

      const { x, y, scale } = sparklePlacement(index, Math.floor(cycle))
      // 2乗して小さいきらきらを多めにする
      const radius = (MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scale ** 2) * size

      ctx.save()
      ctx.translate(x * width, y * height)
      ctx.rotate((cycle - Math.floor(cycle)) * TURN_PER_TWINKLE)
      traceSparkle(ctx, radius)
      ctx.fillStyle = pickColor(colors, index)
      ctx.fill()
      ctx.restore()
    }
  },
})
