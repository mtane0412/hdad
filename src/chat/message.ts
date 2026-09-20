/**
 * チャットメッセージの型と、IRCの PRIVMSG からの変換
 *
 * 表示側（view.ts）が扱いやすいよう、本文を「文字」と「エモート」の断片の並びにして渡す。
 * 注意: Twitchが emotes タグで知らせる位置は UTF-16 の単位ではなく文字数（コードポイント）なので、
 * 絵文字が混ざってもずれないよう、本文をコードポイントの配列にしてから切り出す。
 */
import type { IrcMessage } from './irc'

/** 本文の断片 */
export type Fragment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'emote'; readonly name: string; readonly url: string }

/** 表示対象のバッジ。この並びが名札に表示する順になる */
export const BADGES = ['broadcaster', 'moderator', 'vip', 'subscriber'] as const
export type Badge = (typeof BADGES)[number]

/** チャット1件 */
export interface ChatMessage {
  /** メッセージID（モデレーターによる削除の対象を特定するのに使う） */
  readonly id: string
  /** 書き込んだユーザーのログイン名（BAN・タイムアウト時の一括削除に使う） */
  readonly login: string
  readonly displayName: string
  /** 名前の色（#rrggbb） */
  readonly color: string
  readonly badges: readonly Badge[]
  readonly fragments: readonly Fragment[]
  /** /me による書き込みかどうか */
  readonly action: boolean
}

/** 名前の色を設定していないユーザーに割り当てる色（Twitchの既定の15色） */
const DEFAULT_NAME_COLORS = [
  '#ff0000', '#0000ff', '#008000', '#b22222', '#ff7f50',
  '#9acd32', '#ff4500', '#2e8b57', '#daa520', '#d2691e',
  '#5f9ea0', '#1e90ff', '#ff69b4', '#8a2be2', '#00ff7f',
] as const

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const EMOTE_ID = /^[A-Za-z0-9_]+$/
const EMOTE_RANGE = /^(\d+)-(\d+)$/
/** /me の書き込みは、本文がこの2つの制御文字列で囲まれて届く（CTCP ACTION） */
const ACTION_START = '\u0001ACTION '
const ACTION_END = '\u0001'

/** Twitch公式エモートの画像URL（ダークテーマ用・2倍サイズ） */
export const twitchEmoteUrl = (emoteId: string): string =>
  `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/dark/2.0`

/** ログイン名から、いつも同じ既定色を選ぶ */
const defaultColorOf = (login: string): string => {
  const sum = [...login].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0)
  const color = DEFAULT_NAME_COLORS[sum % DEFAULT_NAME_COLORS.length]
  if (color === undefined) throw new Error('既定の名前色を選べませんでした')
  return color
}

/**
 * 背景色の上で読みやすい文字色（白か、黒に近い色）を返す。
 * ユーザーが選ぶ名前の色は明暗がまちまちなので、名札の地色にしたうえで文字色をこれで決める。
 *
 * @param background 背景色（#rrggbb）
 */
export const readableTextColor = (background: string): string => {
  const channel = (start: number): number => Number.parseInt(background.slice(start, start + 2), 16)
  // 人の目の感度に合わせた明るさ（ITU-R BT.601）。中間より明るければ暗い文字にする
  const BRIGHTNESS_THRESHOLD = 150
  const brightness = channel(1) * 0.299 + channel(3) * 0.587 + channel(5) * 0.114
  return brightness > BRIGHTNESS_THRESHOLD ? '#1a1a1a' : '#ffffff'
}

interface EmoteRange {
  readonly emoteId: string
  readonly start: number
  readonly end: number
}

/** emotes タグ（例: 25:0-4,12-16/1902:6-10）を、位置順の範囲一覧にする */
const parseEmoteRanges = (tag: string): EmoteRange[] => {
  if (tag === '') return []
  const invalid = (): Error => new Error(`emotes タグを読めません: ${tag}`)
  return tag
    .split('/')
    .flatMap((entry) => {
      const [emoteId, positions] = entry.split(':')
      if (emoteId === undefined || positions === undefined || !EMOTE_ID.test(emoteId)) throw invalid()
      return positions.split(',').map((position) => {
        const matched = EMOTE_RANGE.exec(position)
        if (!matched) throw invalid()
        return { emoteId, start: Number(matched[1]), end: Number(matched[2]) }
      })
    })
    .sort((a, b) => a.start - b.start)
}

const toFragments = (text: string, ranges: readonly EmoteRange[]): Fragment[] => {
  const characters = [...text]
  const fragments: Fragment[] = []
  let cursor = 0
  const pushText = (end: number): void => {
    if (end > cursor) fragments.push({ type: 'text', text: characters.slice(cursor, end).join('') })
  }
  for (const { emoteId, start, end } of ranges) {
    pushText(start)
    fragments.push({
      type: 'emote',
      name: characters.slice(start, end + 1).join(''),
      url: twitchEmoteUrl(emoteId),
    })
    cursor = end + 1
  }
  pushText(characters.length)
  return fragments
}

/**
 * PRIVMSG をチャットメッセージに変換する。
 *
 * @param irc コマンドが PRIVMSG のIRCメッセージ
 * @throws 本文がない場合、emotes タグが読めない場合
 */
export const toChatMessage = (irc: IrcMessage): ChatMessage => {
  const body = irc.params[1]
  if (body === undefined) throw new Error('PRIVMSG に本文がありません')
  const login = irc.prefix.split('!')[0] ?? ''
  const { tags } = irc

  const action = body.startsWith(ACTION_START) && body.endsWith(ACTION_END)
  const text = action ? body.slice(ACTION_START.length, -ACTION_END.length) : body
  const color = tags.color ?? ''
  const badgeNames = (tags.badges ?? '').split(',').map((badge) => badge.split('/')[0])

  return {
    id: tags.id ?? '',
    login,
    // 表示名を設定していないユーザーは display-name が空で届く（Twitchの仕様）。その場合はログイン名が表示名になる
    displayName: tags['display-name'] || login,
    color: HEX_COLOR.test(color) ? color.toLowerCase() : defaultColorOf(login),
    badges: BADGES.filter((badge) => badgeNames.includes(badge)),
    fragments: toFragments(text, parseEmoteRanges(tags.emotes ?? '')),
    action,
  }
}
