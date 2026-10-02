/**
 * タブの映像の切り出し範囲（issue #166）
 *
 * 配信者は拡張で、映しているタブの上をドラッグして映す範囲を選ぶ（extension/src/area-picker.ts）。範囲は送り手
 * （拡張の offscreen document）が持ち、つなぐための連絡（signal.ts の crop）で合成ページへ送る。合成ページ（素材 `tab`）は
 * 箱の中で、その範囲だけが縦横比を保ったまま収まるように <video> を置く（余白は透明）。
 *
 * 範囲はピクセルではなくタブの大きさに対する割合（0〜1）で持つ。タブの大きさや取り込みの解像度が変わっても、範囲がずれないようにするため。
 *
 * 注意: 合成ページは canvas に描き直さず、<video> を拡大してずらし、はみ出した分を外枠で隠す。毎フレームの描き直しが要らず、
 * 音も同じ <video> から鳴らし続けられるため。
 */
import { isRecord } from '../core/api'

/** タブの大きさに対する割合で表した、映す範囲（左上の位置と大きさ） */
export interface TabCrop {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 縦横の大きさ（ピクセル） */
export interface Size {
  readonly width: number
  readonly height: number
}

/** 箱の左上を原点にした矩形（ピクセル） */
export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** 合成ページでの置き方。外枠（clip）の中で映像（video）をずらして、外枠からはみ出した分を隠す */
export interface CropLayout {
  /** 箱の中で、切り出した範囲が映る場所（外にはみ出した映像を隠す） */
  readonly clip: Rect
  /** 外枠の左上を原点にした、映像全体の置き場所 */
  readonly video: Rect
}

/** 範囲を指定しないとき（タブ全体） */
const WHOLE_TAB: TabCrop = { x: 0, y: 0, width: 1, height: 1 }

/** ドラッグした位置を表示領域の大きさで割った誤差で、端がわずかにはみ出すのは受け入れる */
const ROUNDING_TOLERANCE = 1e-9

const isRatio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * 届いた範囲を読む。
 *
 * @throws 数でない・大きさが無い・タブの外にはみ出す場合（送り手と合成ページの版が食い違っている）
 */
export const parseTabCrop = (value: unknown): TabCrop => {
  if (!isRecord(value)) throw new Error('映す範囲の形が想定と違います')
  const { x, y, width, height } = value
  if (
    !isRatio(x) ||
    !isRatio(y) ||
    !isRatio(width) ||
    !isRatio(height) ||
    width === 0 ||
    height === 0 ||
    x + width > 1 + ROUNDING_TOLERANCE ||
    y + height > 1 + ROUNDING_TOLERANCE
  ) {
    throw new Error('映す範囲の形が想定と違います')
  }
  return { x, y, width, height }
}

/**
 * 切り出した範囲を、縦横比を保ったまま箱に収める置き方を決める（object-fit: contain と同じ収め方。余白は透明）。
 *
 * @param box 箱の大きさ
 * @param video 届いている映像の大きさ（<video> の videoWidth・videoHeight）
 * @param crop 映す範囲（null はタブ全体）
 * @returns どちらかの大きさがまだ分からない（0）なら null
 */
export const layoutCrop = (box: Size, video: Size, crop: TabCrop | null): CropLayout | null => {
  if (box.width <= 0 || box.height <= 0 || video.width <= 0 || video.height <= 0) return null
  const area = crop ?? WHOLE_TAB
  // 切り出す範囲の、映像の中でのピクセルの大きさ
  const areaWidth = area.width * video.width
  const areaHeight = area.height * video.height
  // 範囲が箱からはみ出さない、いちばん大きい倍率
  const scale = Math.min(box.width / areaWidth, box.height / areaHeight)
  const clipWidth = areaWidth * scale
  const clipHeight = areaHeight * scale
  return {
    clip: { left: (box.width - clipWidth) / 2, top: (box.height - clipHeight) / 2, width: clipWidth, height: clipHeight },
    // 範囲の左上が外枠の左上に来るよう、映像を左上へずらす（0 から引くのは、ずらさないときに -0 を作らないため）
    video: { left: 0 - area.x * video.width * scale, top: 0 - area.y * video.height * scale, width: video.width * scale, height: video.height * scale },
  }
}
