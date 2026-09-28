/**
 * 配置用の枠でのドラッグの計算（画素 → 割合、四角の移動と大きさの変更）
 *
 * /overlay/ の管理画面では、位置と大きさを数値（％）で打つほかに、配信画面と同じ縦横比の枠へ素材を
 * 四角として描き、ドラッグで動かす・端をつまんで大きさを変えられるようにする（issue #105）。
 * その計算だけをここに切り出す。通信もDOMも持ち込まないので、ここだけを取り出してテストできる
 * （枠の要素とポインタの扱いは overlay-page.tsx が受け持つ）。
 *
 * 注意: 保存の形は割合（％）のまま変えない（配信解像度が変わっても崩れないため。worker/overlay-layout.ts）。
 * ドラッグの結果も ItemDraft.rect の文字列へ書き戻すので、数値欄にも同じ値が出る。
 * 注意: 位置と大きさの範囲（0〜100％・1％以上）をここで押し込めるのは、「検証は Worker だけが持つ」
 * （issue #86）の例外ではない。マウスでは範囲の外を「打ち間違える」ことができず、枠の外へ運べてしまうと
 * ドラッグで置いただけの素材が保存のときに拒まれるためである。数値欄は今までどおり丸めずに送り、
 * 範囲の判定は Worker に任せる。
 */
import type { RectDraft } from './form'

/** つまめる場所。move は四角そのもの、それ以外は端と角（方位で表す） */
export const DRAG_HANDLES = ['move', 'nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const

/** つまめる場所 */
export type DragHandle = (typeof DRAG_HANDLES)[number]

/** 大きさを変えるつまみ（四角そのものを動かす move を除いたもの） */
export const RESIZE_HANDLES = DRAG_HANDLES.filter((handle): handle is Exclude<DragHandle, 'move'> => handle !== 'move')

/** つまみの呼び名（画面の読み上げに出す） */
export const HANDLE_LABELS: Readonly<Record<DragHandle, string>> = {
  move: '位置',
  nw: '左上',
  n: '上端',
  ne: '右上',
  w: '左端',
  e: '右端',
  sw: '左下',
  s: '下端',
  se: '右下',
}

/** 位置と大きさ（オーバーレイの幅・高さに対する割合。％） */
export interface RectNumbers {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 位置（％）の範囲。worker/overlay-layout.ts と合わせる */
const MIN_POSITION = 0
const MAX_POSITION = 100
/** 大きさ（％）の範囲。1％未満は見えないので作らせない。worker/overlay-layout.ts と合わせる */
const MIN_SIZE = 1
const MAX_SIZE = 100

/** 割合の細かさ。0.1％（配信画面の幅1920pxで約2px）まで丸め、入力欄に長い小数を残さない */
const ROUND_UNIT = 10

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/** 割合を0.1％まで丸める（素材を足すときの既定の大きさも同じ細かさにそろえる。src/overlay/form.ts） */
export const roundPercent = (value: number): number => Math.round(value * ROUND_UNIT) / ROUND_UNIT

/**
 * 入力欄の文字（％）を数にする。
 *
 * @returns 4つとも数として読めた場合のみ数の四角。1つでも読めなければ undefined
 *   （その素材はドラッグさせず、数値欄で直してもらう）
 */
export const rectNumbersOf = (rect: RectDraft): RectNumbers | undefined => {
  const numbers = {
    x: Number(rect.x),
    y: Number(rect.y),
    width: Number(rect.width),
    height: Number(rect.height),
  }
  if (Object.values(numbers).some((value) => !Number.isFinite(value))) return undefined
  // 空欄は Number('') が 0 になってしまうので、文字のほうで確かめる
  if (Object.values(rect).some((value) => value.trim() === '')) return undefined
  return numbers
}

/** 計算した四角を入力欄の文字に戻す */
export const toRectDraft = (rect: RectNumbers): RectDraft => ({
  x: String(rect.x),
  y: String(rect.y),
  width: String(rect.width),
  height: String(rect.height),
})

/**
 * 枠の中で動かした画素を、枠の幅・高さに対する割合（％）へ直す。
 *
 * 枠の大きさが取れないとき（描く前など）は動かさない。
 */
export const deltaPercent = (dxPixels: number, dyPixels: number, boxWidth: number, boxHeight: number): { dx: number; dy: number } => ({
  dx: boxWidth > 0 ? (dxPixels / boxWidth) * 100 : 0,
  dy: boxHeight > 0 ? (dyPixels / boxHeight) * 100 : 0,
})

/**
 * ドラッグの結果の四角を返す。
 *
 * つまんだ時点の四角（start）と、そこからの動き（dx・dy。枠に対する割合）だけから決まるので、
 * 動かしているあいだに丸めの誤差が積み上がらない。
 *
 * - move: 大きさを変えず、オーバーレイからはみ出さない範囲で動かす
 * - 端・角: つまんでいない側の端は動かさず、1％未満にもオーバーレイの外にもしない
 */
export const dragRect = (start: RectNumbers, handle: DragHandle, dx: number, dy: number): RectNumbers => {
  if (handle === 'move') {
    return {
      x: clamp(roundPercent(start.x + dx), MIN_POSITION, Math.max(MIN_POSITION, MAX_POSITION - start.width)),
      y: clamp(roundPercent(start.y + dy), MIN_POSITION, Math.max(MIN_POSITION, MAX_POSITION - start.height)),
      width: start.width,
      height: start.height,
    }
  }

  const right = start.x + start.width
  const bottom = start.y + start.height
  let { x, y, width, height } = start

  if (handle.includes('w')) {
    // 右端を動かさずに左端を動かすので、幅は右端との差になる
    x = clamp(roundPercent(start.x + dx), MIN_POSITION, right - MIN_SIZE)
    width = roundPercent(right - x)
  }
  if (handle.includes('e')) {
    width = clamp(roundPercent(start.width + dx), MIN_SIZE, MAX_SIZE - start.x)
  }
  if (handle.includes('n')) {
    y = clamp(roundPercent(start.y + dy), MIN_POSITION, bottom - MIN_SIZE)
    height = roundPercent(bottom - y)
  }
  if (handle.includes('s')) {
    height = clamp(roundPercent(start.height + dy), MIN_SIZE, MAX_SIZE - start.y)
  }
  return { x, y, width, height }
}
