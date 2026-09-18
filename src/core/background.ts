/**
 * 背景の定義と描画に関する共通の型・補助関数
 *
 * 背景1種類につき BackgroundDefinition を1つ作り、registry.ts に登録する。
 * 描画は経過時間（秒）だけから決まる形にして、フレーム落ちやリサイズの影響を受けないようにする。
 */
import type { ParamSchema, ParamValues } from './params'

/** 1フレーム分の描画に必要な情報 */
export interface Frame {
  readonly ctx: CanvasRenderingContext2D
  /** 描画領域の幅（CSSピクセル） */
  readonly width: number
  /** 描画領域の高さ（CSSピクセル） */
  readonly height: number
  /** 表示開始からの経過時間（秒） */
  readonly time: number
}

/** 1フレームを描画する関数 */
export type Renderer = (frame: Frame) => void

/** 背景1種類の定義 */
export interface BackgroundDefinition<T extends ParamSchema = ParamSchema> {
  /** URLのパスに使うID（wallpaper/<id>/） */
  readonly id: string
  readonly title: string
  readonly description: string
  readonly schema: T
  /** 解析済みパラメータから描画関数を作る */
  create(params: ParamValues<T>): Renderer
}

/** スキーマから params の型を推論させつつ背景を定義する */
export const defineBackground = <T extends ParamSchema>(
  definition: BackgroundDefinition<T>,
): BackgroundDefinition<T> => definition

/**
 * 描画領域全体を背景色で塗る。transparent の場合は前フレームを消去して透過のままにする。
 */
export const paintBackdrop = ({ ctx, width, height }: Frame, color: string): void => {
  if (color === 'transparent') {
    ctx.clearRect(0, 0, width, height)
    return
  }
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
}

/**
 * 「#rrggbb」形式の色に不透明度（0〜1）を付けて「#rrggbbaa」形式にする。
 */
export const withAlpha = (hexColor: string, alpha: number): string => {
  const MAX_BYTE = 255
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * MAX_BYTE)
  return `${hexColor}${byte.toString(16).padStart(2, '0')}`
}

/**
 * 配色から、番号に応じた色を選ぶ。番号が配色の数を超えたら先頭へ戻って繰り返す。
 *
 * 注意: 配色が空の場合はエラーにする（スキーマの minCount を1以上にしていれば起こらない）。
 *
 * @param colors 配色（1色以上）
 * @param index 0以上の整数
 */
export const pickColor = (colors: readonly string[], index: number): string => {
  const color = colors[index % colors.length]
  if (color === undefined) throw new Error('配色が空のため、色を選べませんでした')
  return color
}

/**
 * 種（seed）から決まる擬似乱数列（mulberry32）を返す。
 * 再読み込みしても同じ配置になるよう、Math.random の代わりに使う。
 */
export const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32
  }
}

/**
 * 画面の端から反対の端へ進み、外へ抜けたら元の側から戻ってくるものの位置（px）。
 * 端で突然現れたり消えたりしないよう、画面の両側に余白を足した範囲を循環する。
 *
 * @param progress 進み具合。1進むごとに1周する。負の値（逆向き）も指定できる
 * @param length 画面の長さ（px）
 * @param margin 画面の外に取る余白（px）。進むものの半分の大きさ以上にする
 * @returns -margin 以上 length + margin 未満の位置
 */
export const loopPosition = (progress: number, length: number, margin: number): number => {
  // JavaScript の % は負の数で負の余りを返すため、1を足してからもう一度余りを取る
  const wrapped = ((progress % 1) + 1) % 1
  return wrapped * (length + margin * 2) - margin
}

/**
 * 時間とともにゆっくり形を変える、なめらかな値の場（おおよそ -1〜1）。
 * 向きと周期の異なる正弦波を重ねたもので、contour と halftone が模様の元として共有する。
 *
 * @param x 横位置（模様の大きさで割った値）
 * @param y 縦位置（模様の大きさで割った値）
 * @param time 経過時間（秒、速さを掛けた値）
 */
export const flowField = (x: number, y: number, time: number): number =>
  (Math.sin(x * 1.3 + time * 0.31) +
    Math.sin(y * 1.7 - time * 0.23) +
    Math.sin((x + y) * 0.9 + time * 0.17) +
    Math.sin(Math.hypot(x - 2.5, y - 1.2) * 1.9 - time * 0.29)) /
  4
