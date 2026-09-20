/**
 * IRCメッセージ（1行）の解析
 *
 * TwitchのチャットはIRCv3形式の行として届く。
 *   @タグ名=値;タグ名=値 :送信元 コマンド 引数 引数 :本文
 * タグと送信元は省略されることがある。本文（" :" 以降）は空白を含む最後の引数として扱う。
 */

/** 分解済みのIRCメッセージ */
export interface IrcMessage {
  readonly tags: Readonly<Record<string, string>>
  /** 送信元（nick!user@host）。ない場合は空文字 */
  readonly prefix: string
  readonly command: string
  readonly params: readonly string[]
}

/** タグの値に使われるエスケープと、元の文字の対応（IRCv3 message-tags） */
const TAG_ESCAPES: Readonly<Record<string, string>> = {
  '\\:': ';',
  '\\s': ' ',
  '\\\\': '\\',
  '\\r': '\r',
  '\\n': '\n',
}

const unescapeTagValue = (value: string): string =>
  value.replace(/\\[:s\\rn]/g, (escaped) => TAG_ESCAPES[escaped] ?? escaped)

const parseTags = (raw: string): Record<string, string> =>
  Object.fromEntries(
    raw.split(';').map((pair) => {
      const separator = pair.indexOf('=')
      return separator === -1
        ? [pair, '']
        : [pair.slice(0, separator), unescapeTagValue(pair.slice(separator + 1))]
    }),
  )

/** 行頭が marker で始まっていれば、次の空白までを取り出して残りと分ける */
const takeSection = (line: string, marker: string): [section: string, rest: string] => {
  if (!line.startsWith(marker)) return ['', line]
  const end = line.indexOf(' ')
  return end === -1 ? [line.slice(1), ''] : [line.slice(1, end), line.slice(end + 1)]
}

/**
 * IRCの1行を分解する。
 *
 * @param line 改行を含まない1行
 * @throws コマンドを含まない行の場合
 */
export const parseIrcLine = (line: string): IrcMessage => {
  const [rawTags, afterTags] = takeSection(line, '@')
  const [prefix, afterPrefix] = takeSection(afterTags, ':')

  const trailingStart = afterPrefix.indexOf(' :')
  const head = trailingStart === -1 ? afterPrefix : afterPrefix.slice(0, trailingStart)
  const [command, ...middle] = head.split(' ').filter((part) => part !== '')
  if (command === undefined) throw new Error(`IRCメッセージとして読めません: ${line}`)

  const params = trailingStart === -1 ? middle : [...middle, afterPrefix.slice(trailingStart + 2)]
  return { tags: rawTags === '' ? {} : parseTags(rawTags), prefix, command, params }
}
