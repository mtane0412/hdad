/**
 * チャットの書き込みから読み上げ文への変換
 *
 * 通信も音声合成も伴わない変換だけをここに置き、単体でテストできるようにしている
 * （src/chat/message.ts と同じ分け方）。読み上げるかどうかの判断もここが持つ。
 *
 * 注意: 読み上げは耳で一度しか聞けないので、文字で見れば分かるもの（エモートの絵・URL・同じ文字の連打）は
 * 読み上げても意味が伝わらない。そのため、読み上げに向く形へ整えてから渡す。
 */
import type { ChatMessage } from '../chat/message'

/** 読み上げ文の組み立て方 */
export interface SpeechTextOptions {
  /** 本文の前に表示名を読むか */
  readonly readName: boolean
  /** 読み上げる本文の長さの上限（文字数）。超えた分は読まない */
  readonly maxLength: number
  /** 読み上げない人のログイン名（botなど）。大文字小文字は区別しない */
  readonly ignoreLogins: readonly string[]
}

/**
 * URLとみなす書き方。worker/chat-moderation.ts の URL_PATTERN と同じ書き方だが、
 * ブラウザ用のコードから worker/ を読み込まない約束なのでここに置く（共有しない）。
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/\S*/gi

/** URLの代わりに読む語。URLそのものを読み上げても聞き取れないため */
const URL_WORD = 'URL'

/** 同じ文字が続くのを、いくつまで残すか（「おもしろいwwwwww」→「おもしろいww」） */
const MAX_REPEAT = 2

/** 表示名と本文のあいだに入れる区切り。読点にすると、合成した音声でも一拍おいて読まれる */
const NAME_SEPARATOR = '、'

/** 本文を読み上げに向く形へ整える。URLの置き換え → 空白の詰め → 連打の圧縮 の順に行う */
const normalize = (body: string): string =>
  body
    .replace(URL_PATTERN, URL_WORD)
    // 全角空白・改行も含めて1つの半角空白に詰める（詰めてから連打を圧縮しないと、空白の並びまで対象になる）
    .replace(/\s+/g, ' ')
    .replace(/(.)\1{2,}/gu, (_matched, character: string) => character.repeat(MAX_REPEAT))
    .trim()

/**
 * 書き込み1件を読み上げ文にする。
 *
 * @returns 読み上げる文。読み上げないもの（コマンド・エモートだけの発言・読み上げない人の発言）なら null
 */
export const speechTextOf = (message: ChatMessage, options: SpeechTextOptions): string | null => {
  const ignored = options.ignoreLogins.some((login) => login.toLowerCase() === message.login.toLowerCase())
  if (ignored) return null

  // 絵は読み上げられないので、文字の断片だけを残す（エモートとCheermoteは捨てる）
  const body = normalize(message.fragments.map((fragment) => (fragment.type === 'text' ? fragment.text : '')).join(''))
  if (body === '') return null
  // コマンドはbotへの指示であって読み上げる文ではない（応答のほうは読み上げない人に挙げて止める）
  if (body.startsWith('!')) return null

  // 上限は本文にだけかける。名前まで数えると、長い本文のときに誰の発言か分からなくなる
  const spoken = body.slice(0, options.maxLength)
  return options.readName ? `${message.displayName}${NAME_SEPARATOR}${spoken}` : spoken
}
