/**
 * stripes: 斜めの帯が一定の速さで流れていく背景
 *
 * 帯は「周期（size）の半分が色、残り半分が背景」の繰り返し。
 * 描画領域の中心で座標を回転させ、帯に直交する向きへ時間に応じてずらして描く。
 */
import { defineBackground, paintBackdrop } from '../core/background'

/** 流れる速さの基準（1秒あたりに進む量、帯の周期に対する比率） */
const SCROLL_RATE = 0.15
/** 1度あたりのラジアン */
const RADIANS_PER_DEGREE = Math.PI / 180

/**
 * 帯のずれ量（px）を経過時間から求める。0以上 size 未満を循環する。
 *
 * @param time 経過時間（秒）
 * @param speed 動きの速さ（0で静止）
 * @param size 帯の周期（px）
 */
export const stripeShift = (time: number, speed: number, size: number): number =>
  ((time * speed * SCROLL_RATE) % 1) * size

export const stripes = defineBackground({
  id: 'stripes',
  title: 'Stripes',
  description: '斜めの帯がゆっくり流れる。直線だけの模様で、待機画面や枠の後ろ向け。',
  schema: {
    color: { type: 'color', default: '#2a9d8f', description: '帯の色' },
    bg: { type: 'color', default: '#264653', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 96, min: 8, max: 600, description: '帯の周期（px）' },
    angle: { type: 'number', default: 45, min: -90, max: 90, description: '帯の傾き（度）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, size, angle, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    // 回転しても四隅まで覆えるよう、対角線の長さを一辺とする正方形の範囲に帯を描く
    const reach = Math.hypot(width, height) / 2
    const shift = stripeShift(time, speed, size)

    ctx.save()
    ctx.translate(width / 2, height / 2)
    ctx.rotate(angle * RADIANS_PER_DEGREE)
    ctx.fillStyle = color
    // 帯の位置を周期の倍数に揃えてからずらすことで、画面の大きさが変わっても流れが飛ばない
    const first = -Math.ceil(reach / size) * size - size
    for (let x = first + shift; x < reach; x += size) {
      ctx.fillRect(x, -reach, size / 2, reach * 2)
    }
    ctx.restore()
  },
})
