/**
 * サービスワーカーから offscreen document への頼みの形
 *
 * ボタンが押されたら、サービスワーカー（background.ts）が取ったストリームIDで offscreen document（offscreen.ts）に
 * 取り込ませる。映しているタブでもう一度押されたら止めさせる。
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、あて先（target）を付けて読み分ける。
 *
 * 注意: offscreen document はこのファイルの読み取りを、サービスワーカーは型と定数だけを使う
 * （両方から実行時に読み込むと、ビルドで共有のファイルができて zip に入らない。extension/vite.config.ts）。
 * サービスワーカーは送る連絡を OffscreenCommandMessage の型で縛り、あて先の値を直接書く。
 */
import { isRecord } from '../../src/core/api'

/** offscreen document あての頼みに付けるあて先 */
export const OFFSCREEN_COMMAND_TARGET = 'offscreen'

/** サービスワーカーから届く頼み */
export type OffscreenCommand =
  /** このIDのタブを取り込んで、origin の HDAD の中継先へ送る（映していたものは置き換える） */
  | { type: 'start'; streamId: string; origin: string }
  /** 映すのをやめる */
  | { type: 'stop' }

/** 送るときの形（あて先を付ける） */
export type OffscreenCommandMessage = OffscreenCommand & { target: typeof OFFSCREEN_COMMAND_TARGET }

/** 頼みへの返事。取り込めなかったときは理由を返す */
export type OffscreenReply = { ok: true } | { ok: false; message: string }

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

const INVALID = 'サービスワーカーからの頼みの形が想定と違います'

/**
 * 届いた連絡を読む。
 *
 * @returns offscreen document あてでなければ null（サービスワーカーあての知らせなど）
 * @throws offscreen document あてなのに形が違う場合（拡張の版が食い違っている）
 */
export const parseOffscreenCommand = (value: unknown): OffscreenCommand | null => {
  if (!isRecord(value) || value.target !== OFFSCREEN_COMMAND_TARGET) return null
  if (value.type === 'stop') return { type: 'stop' }
  if (value.type === 'start') {
    if (!isText(value.streamId) || !isText(value.origin)) throw new Error(INVALID)
    return { type: 'start', streamId: value.streamId, origin: value.origin }
  }
  throw new Error(INVALID)
}
