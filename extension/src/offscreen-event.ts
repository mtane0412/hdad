/**
 * offscreen document からサービスワーカーへの知らせの形
 *
 * 取り込みと送信は offscreen document（offscreen.ts）が受け持ち、ボタンの表示はサービスワーカー（background.ts）が受け持つ。
 * offscreen document は状態が変わるたびに、表示に要るものをまとめて知らせる（サービスワーカーは眠ると変数を失うので、
 * 差分ではなく全体を送る）。
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、あて先（target）を付けて読み分ける。
 *
 * 注意: サービスワーカーはこのファイルの読み取りを、offscreen document は型だけを使う
 * （両方から実行時に読み込むと、ビルドで共有のファイルができて zip に入らない。extension/vite.config.ts）。
 * offscreen document は送る知らせを OffscreenEventMessage の型で縛り、あて先の値を直接書く。
 */
import { isRecord } from './guards'

/** サービスワーカーあての知らせに付けるあて先 */
export const OFFSCREEN_EVENT_TARGET = 'background'

/** offscreen document から届く知らせ */
export type OffscreenEvent =
  /** 取り込んでいるあいだの状態（つながっている合成ページの数と、待てば直るかもしれない失敗） */
  | { type: 'state'; viewers: number; warning: string | null }
  /** 取り込んだタブが閉じられた（エラーではない） */
  | { type: 'ended' }

/** 送るときの形（あて先を付ける） */
export type OffscreenEventMessage = OffscreenEvent & { target: typeof OFFSCREEN_EVENT_TARGET }

const INVALID = 'offscreen document からの知らせの形が想定と違います'

/**
 * 届いた連絡を読む。
 *
 * @returns サービスワーカーあてでなければ null（offscreen document あての頼みなど）
 * @throws サービスワーカーあてなのに形が違う場合（拡張の版が食い違っている）
 */
export const parseOffscreenEvent = (value: unknown): OffscreenEvent | null => {
  if (!isRecord(value) || value.target !== OFFSCREEN_EVENT_TARGET) return null
  if (value.type === 'ended') return { type: 'ended' }
  if (value.type === 'state') {
    const { viewers, warning } = value
    if (typeof viewers !== 'number' || !Number.isInteger(viewers) || viewers < 0) throw new Error(INVALID)
    if (warning !== null && typeof warning !== 'string') throw new Error(INVALID)
    return { type: 'state', viewers, warning }
  }
  throw new Error(INVALID)
}
