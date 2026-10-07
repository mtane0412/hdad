/**
 * チャットの発言から、ワイプに出す1件への変換
 *
 * ワイプはバラエティ番組のワイプのように、発言した人のアイコンを枠に映し、発言を吹き出しで出す素材（素材の種類 `wipe`）。
 * ここは通信もDOMも持たない変換だけを受け持ち、単体でテストできるようにしている（src/speech/text.ts と同じ分け方）。
 *
 * 注意: ワイプに出す発言は、読み上げる発言と同じにする（読むかどうかの判断は src/speech/text.ts の speechTextOf だけが持つ）。
 * 読み上げない人（bot）・コマンド・エモートだけの発言は、ワイプにも出さない。
 * 注意: 吹き出しには届いたとおりの本文（エモートの絵も含む）を出し、読み上げには整えた文（spoken）を使う。
 */
import type { ChatMessage, Fragment } from '../chat/message'
import { speechTextOf, type SpeechTextOptions } from '../speech/text'

/** ワイプに出す1件 */
export interface WipeComment {
  /** モデレーターに消されたときに引っ込めるための、発言のID */
  readonly messageId: string
  /** アイコンを引くための、発言した人のログイン名 */
  readonly login: string
  readonly displayName: string
  /** 吹き出しに出す本文 */
  readonly fragments: readonly Fragment[]
  /** 読み上げる文 */
  readonly spoken: string
}

/** ミュート中に吹き出しを出しておく最短の時間（ミリ秒）。短い発言でも読み取れるだけ出す */
export const MIN_SILENT_DURATION_MS = 3000
/** ミュート中に吹き出しを出しておく最長の時間（ミリ秒）。長い発言で次の人を待たせすぎない */
export const MAX_SILENT_DURATION_MS = 8000
/** ミュート中、1文字ぶん伸ばす時間（ミリ秒）。読み上げの速さ（1秒におよそ8文字）に合わせる */
const SILENT_DURATION_PER_CHARACTER_MS = 125

/**
 * 発言1件をワイプに出す1件にする。
 *
 * @returns ワイプに出す1件。出さないもの（読み上げないもの）なら null
 */
export const wipeCommentOf = (message: ChatMessage, options: SpeechTextOptions): WipeComment | null => {
  const spoken = speechTextOf(message, options)
  if (spoken === null) return null
  return {
    messageId: message.id,
    login: message.login,
    displayName: message.displayName,
    fragments: message.fragments,
    spoken,
  }
}

/**
 * ミュート中に吹き出しを出しておく時間を、読み上げる文の長さから決める（見た目の文字数で数える）。
 */
export const silentDurationOf = (spoken: string): number =>
  Math.min(MAX_SILENT_DURATION_MS, Math.max(MIN_SILENT_DURATION_MS, [...spoken].length * SILENT_DURATION_PER_CHARACTER_MS))
