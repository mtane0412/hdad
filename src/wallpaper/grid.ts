/**
 * grid: 地平線へ向かって伸びる床のグリッドが、手前へ流れてくる背景
 *
 * 床を遠近法で描く。奥行き（depth）は「1 = 画面の下端、大きいほど地平線に近い」値で、
 * 画面上の縦位置は「地平線 + 床の高さ / 奥行き」になる。
 * 線は地平線に近いほど薄くして、遠くへ消えていくように見せる。
 */
import { defineBackground, paintBackdrop, withAlpha } from '../core/background'

/** 地平線の縦位置（画面の高さに対する比率） */
const HORIZON_RATIO = 0.42
/** 流れる速さの基準（1秒あたりに進むマス数） */
const SCROLL_RATE = 0.5
/** 横線を描く最大の奥行き。これより奥は線が薄く密になり見えないので描かない */
const MAX_DEPTH = 40
/** 線の太さ（px） */
const LINE_WIDTH = 2
/** 縦線を画面の幅の何倍の範囲まで引くか。画面外から始まる線も、地平線の近くでは画面内に入る */
const SIDE_REACH = 6

/**
 * 奥行きを画面上の縦位置（px）へ変換する。
 *
 * @param depth 奥行き（1以上）
 * @param horizonY 地平線の縦位置（px）
 * @param floorHeight 地平線から画面の下端までの高さ（px）
 */
export const projectDepth = (depth: number, horizonY: number, floorHeight: number): number =>
  horizonY + floorHeight / depth

/**
 * 横線の奥行きの一覧を、手前から奥の順で返す。
 *
 * @param phase 流れの位相（0以上1未満）。1進むとちょうど1マス分手前へ流れる
 * @param depthStep 線と線の奥行きの間隔
 * @param maxDepth 描く最大の奥行き
 */
export const gridDepths = (phase: number, depthStep: number, maxDepth: number): number[] => {
  const depths: number[] = []
  for (let index = 1; ; index++) {
    const depth = 1 + (index - phase) * depthStep
    if (depth > maxDepth) return depths
    depths.push(depth)
  }
}

export const grid = defineBackground({
  id: 'grid',
  title: 'Grid',
  description: '地平線へ伸びる床のグリッドが手前へ流れる。レトロなゲーム配信向け。',
  schema: {
    color: { type: 'color', default: '#ff5fa2', description: '線の色' },
    bg: { type: 'color', default: '#150b2e', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 180, min: 40, max: 600, description: '画面の下端でのマスの幅（px）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, size, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    const horizonY = height * HORIZON_RATIO
    const floorHeight = height - horizonY
    const centerX = width / 2
    ctx.lineWidth = LINE_WIDTH

    // 縦線: 消失点（地平線の中央）から画面の下端へ放射状に引く。濃さは地平線で0、下端で1
    const fade = ctx.createLinearGradient(0, horizonY, 0, height)
    fade.addColorStop(0, withAlpha(color, 0))
    fade.addColorStop(1, withAlpha(color, 1))
    ctx.strokeStyle = fade
    ctx.beginPath()
    const sideCount = Math.ceil((width * SIDE_REACH) / size)
    for (let index = -sideCount; index <= sideCount; index++) {
      ctx.moveTo(centerX, horizonY)
      ctx.lineTo(centerX + index * size, height)
    }
    ctx.stroke()

    // 横線: マスが正方形に見えるよう、奥行きの間隔を「マスの幅 / 床の高さ」にする
    const phase = (time * speed * SCROLL_RATE) % 1
    for (const depth of gridDepths(phase, size / floorHeight, MAX_DEPTH)) {
      const y = projectDepth(depth, horizonY, floorHeight)
      // 縦線のグラデーションと同じく、地平線からの距離に比例した濃さにする
      ctx.strokeStyle = withAlpha(color, 1 / depth)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
  },
})
