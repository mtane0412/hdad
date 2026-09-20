/**
 * analog: 現在時刻を針で表示するアナログ時計
 *
 * 丸い文字盤に、目盛り・数字・短針・長針・秒針を描く。時刻は配信PCのローカル時刻を使う。
 * 文字盤の大きさはピクセル指定ではなく、OBSのブラウザソースの幅・高さに収まる最大の円から決めるため、
 * ソースの大きさを変えても文字盤がはみ出さない。
 * 表示内容は frame.now だけから決まり、フレーム間の状態は持たない。
 */
import { defineBackground, paintBackdrop } from '../core/background'

/** 1周（360度）のラジアン */
const FULL_TURN = Math.PI * 2
const HOURS_ON_DIAL = 12
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60
const MILLISECONDS_PER_SECOND = 1000
/** 文字盤の目盛りの数（1分ごと） */
const TICK_COUNT = 60
/** 何目盛りごとに「時」の太い目盛りにするか */
const TICKS_PER_HOUR = TICK_COUNT / HOURS_ON_DIAL

// 以下の比率は、すべて文字盤の半径に対するもの
/** 文字盤の縁の太さ */
const RIM_WIDTH_RATIO = 0.04
/** 目盛りの外側の端の位置 */
const TICK_OUTER_RATIO = 0.9
/** 「時」の目盛りの長さと太さ */
const HOUR_TICK = { length: 0.1, width: 0.03 } as const
/** 「分」の目盛りの長さと太さ */
const MINUTE_TICK = { length: 0.05, width: 0.012 } as const
/** 数字の中心の位置と文字サイズ。数字を表示するときは、目盛りの内側に置く */
const NUMBER_POSITION_RATIO = 0.68
const NUMBER_FONT_RATIO = 0.17
/** 針の長さ・中心より後ろに伸びる尻尾の長さ・太さ */
const HOUR_HAND = { length: 0.5, tail: 0.08, width: 0.055 } as const
const MINUTE_HAND = { length: 0.76, tail: 0.1, width: 0.035 } as const
const SECOND_HAND = { length: 0.82, tail: 0.18, width: 0.014 } as const
/** 針の付け根を隠す中心の丸の半径 */
const CENTER_CAP_RATIO = 0.045

const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif"

/** 針の角度の組。いずれも12時の向きを0として、時計回りに回ったラジアン（0以上1周未満） */
export interface HandAngles {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/**
 * 時刻から、短針・長針・秒針の角度を求める。
 *
 * 短針は分の経過に、長針は秒の経過に合わせて少しずつ進む（本物の時計と同じく、次の目盛りへ突然飛ばない）。
 *
 * @param now 表示する時刻（ローカル時刻として読む）
 * @param options smooth: 秒針をミリ秒まで使ってなめらかに進めるか。無効なら1秒ごとに刻む
 * @returns 各針の角度（ラジアン）
 */
export const handAngles = (now: Date, options: { readonly smooth: boolean }): HandAngles => {
  const milliseconds = options.smooth ? now.getMilliseconds() : 0
  const seconds = now.getSeconds() + milliseconds / MILLISECONDS_PER_SECOND
  const minutes = now.getMinutes() + seconds / SECONDS_PER_MINUTE
  const hours = (now.getHours() % HOURS_ON_DIAL) + minutes / MINUTES_PER_HOUR
  return {
    hour: (hours / HOURS_ON_DIAL) * FULL_TURN,
    minute: (minutes / MINUTES_PER_HOUR) * FULL_TURN,
    second: (seconds / SECONDS_PER_MINUTE) * FULL_TURN,
  }
}

/** 画面上の位置（px） */
interface Point {
  readonly x: number
  readonly y: number
}

/**
 * 文字盤の中心から、指定した角度の向きへ指定した距離だけ離れた位置を求める。
 *
 * @param center 文字盤の中心
 * @param distance 中心からの距離（px）。負の値を渡すと、中心をはさんだ反対側になる
 * @param angle 12時の向きを0として、時計回りに回ったラジアン
 * @returns 画面上の位置。canvas の座標は下向きが正なので、12時の向きは y が小さくなる側
 */
export const pointOnDial = (center: Point, distance: number, angle: number): Point => ({
  x: center.x + Math.sin(angle) * distance,
  y: center.y - Math.cos(angle) * distance,
})

export const analog = defineBackground({
  id: 'analog',
  title: 'Analog',
  description: '現在時刻を針で表示する。秒針・数字の表示と、秒針のなめらかな動きを切り替えられる',
  schema: {
    color: { type: 'color', default: '#ffffff', description: '針・目盛り・数字・縁の色' },
    accent: { type: 'color', default: '#ff5d73', description: '秒針の色' },
    face: {
      type: 'color',
      default: '#101820',
      allowTransparent: true,
      description: '文字盤の色',
    },
    bg: { type: 'color', default: 'transparent', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 0.9, min: 0.1, max: 1, description: '文字盤の大きさ（収まる最大に対する倍率）' },
    seconds: { type: 'boolean', default: true, description: '秒針を表示する' },
    smooth: { type: 'boolean', default: true, description: '秒針をなめらかに動かす（無効なら1秒ごとに刻む）' },
    numbers: { type: 'boolean', default: true, description: '1〜12の数字を表示する' },
  },
  create: ({ color, accent, face, bg, size, seconds, smooth, numbers }) => (frame) => {
    const { ctx, width, height, now } = frame
    paintBackdrop(frame, bg)

    const center = { x: width / 2, y: height / 2 }
    const radius = (Math.min(width, height) / 2) * size

    /** 中心をはさんで from から to まで（中心からの距離、px）、指定した角度の向きに線を引く */
    const drawRadialLine = (angle: number, from: number, to: number, lineWidth: number, style: string): void => {
      const start = pointOnDial(center, from, angle)
      const end = pointOnDial(center, to, angle)
      ctx.strokeStyle = style
      ctx.lineWidth = lineWidth
      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.lineTo(end.x, end.y)
      ctx.stroke()
    }

    // 文字盤と縁。縁の線は太さの半分だけ外側にはみ出すので、その分だけ内側に描いて半径に収める
    const rimWidth = radius * RIM_WIDTH_RATIO
    ctx.beginPath()
    ctx.arc(center.x, center.y, radius - rimWidth / 2, 0, FULL_TURN)
    if (face !== 'transparent') {
      ctx.fillStyle = face
      ctx.fill()
    }
    ctx.strokeStyle = color
    ctx.lineWidth = rimWidth
    ctx.stroke()

    // 目盛り
    ctx.lineCap = 'butt'
    for (let tick = 0; tick < TICK_COUNT; tick++) {
      const { length, width: tickWidth } = tick % TICKS_PER_HOUR === 0 ? HOUR_TICK : MINUTE_TICK
      const outer = radius * TICK_OUTER_RATIO
      drawRadialLine((tick / TICK_COUNT) * FULL_TURN, outer - radius * length, outer, radius * tickWidth, color)
    }

    if (numbers) {
      ctx.fillStyle = color
      ctx.font = `bold ${radius * NUMBER_FONT_RATIO}px ${FONT_FAMILY}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let hour = 1; hour <= HOURS_ON_DIAL; hour++) {
        const position = pointOnDial(center, radius * NUMBER_POSITION_RATIO, (hour / HOURS_ON_DIAL) * FULL_TURN)
        ctx.fillText(String(hour), position.x, position.y)
      }
    }

    // 針。後から描いたものが上に重なるので、短針・長針・秒針の順に描く
    const angles = handAngles(now, { smooth })
    const drawHand = (
      angle: number,
      hand: { readonly length: number; readonly tail: number; readonly width: number },
      style: string,
    ): void => drawRadialLine(angle, -radius * hand.tail, radius * hand.length, radius * hand.width, style)

    ctx.lineCap = 'round'
    drawHand(angles.hour, HOUR_HAND, color)
    drawHand(angles.minute, MINUTE_HAND, color)
    if (seconds) drawHand(angles.second, SECOND_HAND, accent)

    ctx.fillStyle = seconds ? accent : color
    ctx.beginPath()
    ctx.arc(center.x, center.y, radius * CENTER_CAP_RATIO, 0, FULL_TURN)
    ctx.fill()
  },
})
