/**
 * truchet: 四分円を2本描いたタイルを敷き詰め、つながった曲線の模様を作る背景（トルシェタイル）
 *
 * タイルを90度回すと曲線のつながり方が切り替わる。各タイルが別々のタイミングで
 * 90度ずつ回ることで、模様が少しずつ組み変わっていく。
 * 回転量は経過時間から直接求める（状態を持たない）。
 */
import { createRandom, defineBackground, paintBackdrop } from '../core/background'

/** タイルが回る頻度の基準（1秒あたりの回数）。0.08 なら各タイルは約12秒に1回まわる */
const TURN_RATE = 0.08
/** 1周期のうち、回らずに止まっている時間の割合。残りの時間で90度回る */
const HOLD_RATIO = 0.85
/** 線の太さ（タイルの一辺に対する比率） */
const LINE_WIDTH_RATIO = 0.14
/** 4分の1回転（90度）のラジアン */
const QUARTER_TURN = Math.PI / 2

/** なめらかに動き出してなめらかに止まる補間（0〜1 → 0〜1） */
const easeInOut = (progress: number): number => progress * progress * (3 - 2 * progress)

/**
 * タイルの回転量（単位: 4分の1回転）。cycle が1進むごとに、止まる → 90度回る を1回行う。
 *
 * @param cycle 経過時間 × 回転の頻度 + タイルごとのずれ
 */
export const tileQuarterTurns = (cycle: number): number => {
  const completed = Math.floor(cycle)
  const turning = Math.max(0, (cycle - completed - HOLD_RATIO) / (1 - HOLD_RATIO))
  return completed + easeInOut(turning)
}

/**
 * タイルの回転の進み具合（tileQuarterTurns に渡す cycle）を求める。
 *
 * 注意: speed が0（静止）のときはタイルごとのずれを足さない。ずれを足すと、
 * 一部のタイルが回転途中の角度のまま止まり、曲線が切れた状態で静止してしまう。
 *
 * @param time 経過時間（秒）
 * @param speed 動きの速さ（0で静止）
 * @param phase タイルごとの回転タイミングのずれ（0以上1未満）
 */
export const tileCycle = (time: number, speed: number, phase: number): number =>
  speed === 0 ? 0 : time * speed * TURN_RATE + phase

/**
 * タイルごとの擬似乱数列。列と行だけから決まるため、
 * 画面の大きさが変わっても各タイルの動きは変わらない。
 */
const createTileRandom = (column: number, row: number): (() => number) =>
  // 列と行を大きな素数で混ぜて、隣り合うタイルの種が似ないようにする
  createRandom(Math.imul(column + 1, 73856093) ^ Math.imul(row + 1, 19349663))

/** タイルごとの回転タイミングのずれ（0以上1未満）。タイルの乱数列の1つ目の値 */
export const tilePhase = (column: number, row: number): number => createTileRandom(column, row)()

export const truchet = defineBackground({
  id: 'truchet',
  title: 'Truchet',
  description: 'タイルの曲線がつながって迷路のような模様になり、少しずつ組み変わる。',
  schema: {
    color: { type: 'color', default: '#e9c46a', description: '線の色' },
    bg: { type: 'color', default: '#22223b', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 96, min: 24, max: 400, description: 'タイルの一辺（px）' },
    speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ（0で静止）' },
  },
  create: ({ color, bg, size, speed }) => (frame) => {
    const { ctx, width, height, time } = frame
    paintBackdrop(frame, bg)

    const half = size / 2
    ctx.strokeStyle = color
    ctx.lineWidth = size * LINE_WIDTH_RATIO
    // 回っている途中は線の端が隣とつながらないので、端を丸めて切れ目を目立たなくする
    ctx.lineCap = 'round'

    for (let row = 0; row * size < height; row++) {
      for (let column = 0; column * size < width; column++) {
        const random = createTileRandom(column, row)
        const phase = random()
        // 初期の向きは位相とは別の乱数で決める（同じ値から決めると向きが時間とともに偏る）
        const initialTurns = random() < 0.5 ? 0 : 1
        const turns = initialTurns + tileQuarterTurns(tileCycle(time, speed, phase))

        ctx.save()
        ctx.translate(column * size + half, row * size + half)
        ctx.rotate(turns * QUARTER_TURN)
        // 左上の角と右下の角を中心にした四分円。辺の中点どうしを結ぶ
        ctx.beginPath()
        ctx.arc(-half, -half, half, 0, QUARTER_TURN)
        ctx.moveTo(0, half)
        ctx.arc(half, half, half, Math.PI, Math.PI + QUARTER_TURN)
        ctx.stroke()
        ctx.restore()
      }
    }
  },
})
