/**
 * hearts: パステルカラーのハートが、ゆらゆら揺れながらふわふわ昇っていく背景
 *
 * ハートの位置と傾きは経過時間から直接求める（状態を持たない）ため、フレーム落ちしても動きが飛ばない。
 */
import {
  createRandom,
  defineBackground,
  loopPosition,
  paintBackdrop,
  pickColor,
} from '../core/background'

/** ハートの配置を決める乱数の種。固定値なので再読み込みしても同じ配置になる */
const LAYOUT_SEED = 214
/** ハートの大きさ（中心から左右の端までのおおよその長さ、px）の範囲 */
const MIN_SIZE = 10
const MAX_SIZE = 46
/** 昇る速さの基準（1秒あたり、画面の高さに対する比率） */
const RISE_RATE = 0.018
/** 左右に傾く最大の角度（ラジアン、およそ20度） */
export const HEART_MAX_TILT = 0.35
/** 傾きが往復する速さ（1秒あたりのラジアン） */
const TILT_RATE = 0.9
/** ツヤ（左上の白い点）の不透明度 */
const SHINE_ALPHA = 0.55

interface Heart {
  /** 横位置（0〜1） */
  readonly x: number
  /** 昇り始めの縦位置（0〜1） */
  readonly y: number
  /** 奥行き（0=奥で小さく遅い、1=手前で大きく速い） */
  readonly depth: number
  /** 揺れの位相 */
  readonly swayPhase: number
  readonly color: string
}

/**
 * ハートの傾き（ラジアン）。左右に HEART_MAX_TILT までゆらゆら往復する。
 *
 * @param time 経過時間（秒、速さを掛けた値）
 * @param phase ハートごとの揺れの位相
 */
export const heartTilt = (time: number, phase: number): number =>
  Math.sin(time * TILT_RATE + phase) * HEART_MAX_TILT

/**
 * 原点を中心にしたハートの輪郭をパスに追加する。
 *
 * @param size 中心から左右の端までのおおよその長さ（px）
 */
const traceHeart = (ctx: CanvasRenderingContext2D, size: number): void => {
  // 下の尖った先から始め、左のふくらみ → 上のくぼみ → 右のふくらみ の順に曲線でなぞる
  ctx.beginPath()
  ctx.moveTo(0, size * 0.9)
  ctx.bezierCurveTo(-size * 1.6, -size * 0.1, -size * 0.75, -size * 1.2, 0, -size * 0.4)
  ctx.bezierCurveTo(size * 0.75, -size * 1.2, size * 1.6, -size * 0.1, 0, size * 0.9)
  ctx.closePath()
}

export const hearts = defineBackground({
  id: 'hearts',
  title: 'Hearts',
  description: 'パステルカラーのハートがゆらゆら揺れながら昇る。かわいく華やかな場面向け。',
  schema: {
    colors: {
      type: 'colors',
      default: ['#ff8fab', '#ffb3c6', '#ffc2d1', '#cdb4db'],
      minCount: 1,
      maxCount: 6,
      description: 'ハートの色',
    },
    bg: { type: 'color', default: '#fff0f3', allowTransparent: true, description: '背景色' },
    count: { type: 'number', integer: true, default: 45, min: 1, max: 300, description: 'ハートの数' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ colors, bg, count, speed }) => {
    const random = createRandom(LAYOUT_SEED)
    const heartList: Heart[] = Array.from({ length: count }, () => ({
      x: random(),
      y: random(),
      // 2乗して奥（小さいハート）を多めにする
      depth: random() ** 2,
      swayPhase: random() * Math.PI * 2,
      color: pickColor(colors, Math.floor(random() * colors.length)),
    }))
    // 奥のハートから描いて、手前のハートが上に重なるようにする
    heartList.sort((a, b) => a.depth - b.depth)

    return (frame) => {
      const { ctx, width, height, time } = frame
      paintBackdrop(frame, bg)

      for (const heart of heartList) {
        const size = MIN_SIZE + (MAX_SIZE - MIN_SIZE) * heart.depth
        const risen = time * speed * RISE_RATE * (0.4 + heart.depth)
        // ハートは傾くと上下にも少しはみ出すため、余白は大きさの2倍を取る
        const y = loopPosition(heart.y - risen, height, size * 2)
        const tilt = heartTilt(time * speed, heart.swayPhase)
        // 傾いた向きへ体ごと流れるように、横揺れにも同じ傾きを使う
        const x = heart.x * width + (tilt / HEART_MAX_TILT) * size * 0.8

        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(tilt)
        ctx.globalAlpha = 0.45 + 0.5 * heart.depth
        traceHeart(ctx, size)
        ctx.fillStyle = heart.color
        ctx.fill()
        // 左上に小さな白いツヤを入れて、ぷっくりした見た目にする
        ctx.globalAlpha *= SHINE_ALPHA
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.ellipse(-size * 0.45, -size * 0.35, size * 0.18, size * 0.11, -0.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
  },
})
