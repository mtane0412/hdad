/**
 * チャットボックスの定義に関する共通の型と、全デザイン共通のパラメータ
 *
 * チャットボックスは壁紙や時計と違い、canvas ではなくHTML要素として表示する
 * （文字の折り返し・アニメーションするエモート画像をブラウザに任せるため）。
 * そのためデザイン1種類は「スキーマ」と「専用のCSS（src/chat/<id>.css）」の組で表し、
 * パラメータはCSSのカスタムプロパティとしてCSSへ渡す。メッセージのHTML構造は全デザイン共通（view.ts）。
 */
import { ParamError, type ParamSchema, type ParamValues } from '../core/params'

/** Twitchのログイン名に使える文字（英数字とアンダースコア、25文字まで） */
const CHANNEL_NAME = /^[A-Za-z0-9_]{1,25}$/

/** 全デザイン共通のパラメータ。各デザインのスキーマの先頭に展開して使う */
export const commonChatSchema = {
  channel: {
    type: 'string',
    default: '',
    pattern: CHANNEL_NAME,
    example: 'your_channel',
    description: 'Twitchのチャンネル名（必須。twitch.tv/ の後ろの部分）',
  },
  demo: {
    type: 'boolean',
    default: false,
    description: 'サンプルの書き込みを流す（配置の調整用。Twitchには接続しない）',
  },
  max: { type: 'number', integer: true, default: 15, min: 1, max: 50, description: '同時に表示する件数' },
  lifetime: {
    type: 'number',
    integer: true,
    default: 0,
    min: 0,
    max: 600,
    description: '書き込みを消すまでの秒数（0 で消さない）',
  },
  badges: { type: 'boolean', default: true, description: 'バッジ（配信者・モデレーター・VIP・サブスク）を表示する' },
  thirdparty: { type: 'boolean', default: true, description: '7TV・BTTV・FFZ のエモートを表示する' },
} as const satisfies ParamSchema

export type CommonChatParams = ParamValues<typeof commonChatSchema>

/** 共通パラメータを含むスキーマ */
export type ChatSchema = typeof commonChatSchema & ParamSchema

/** チャットボックスのデザイン1種類の定義 */
export interface ChatDefinition<T extends ChatSchema = ChatSchema> {
  /** URLのパスに使うID（chat/<id>/）。CSSは [data-chat='<id>'] で自分のデザインだけに適用する */
  readonly id: string
  readonly title: string
  readonly description: string
  /** commonChatSchema を含むスキーマ */
  readonly schema: T
  /** 解析済みパラメータを、デザインのCSSが参照するカスタムプロパティに変換する */
  cssVariables(params: ParamValues<T>): Readonly<Record<string, string>>
}

/** スキーマから params の型を推論させつつデザインを定義する */
export const defineChat = <T extends ChatSchema>(
  definition: ChatDefinition<T>,
): ChatDefinition<T> => definition

/** 書き込みの取得元 */
export type ChatSource = { readonly type: 'demo' } | { readonly type: 'live'; readonly channel: string }

/**
 * パラメータから書き込みの取得元を決める。
 *
 * @throws ParamError channel も demo も指定されていない場合（黙ってサンプル表示にはしない）
 */
export const sourceOf = ({ channel, demo }: Pick<CommonChatParams, 'channel' | 'demo'>): ChatSource => {
  if (demo) return { type: 'demo' }
  if (channel === '') {
    throw new ParamError([
      'channel: Twitchのチャンネル名を指定してください（例: ?channel=your_channel）',
      '配置の調整用にサンプルを表示する場合は ?demo=true を指定してください',
    ])
  }
  // IRCのチャンネル名は小文字で指定する必要がある
  return { type: 'live', channel: channel.toLowerCase() }
}
