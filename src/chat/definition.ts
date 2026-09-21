/**
 * チャットボックスの定義に関する共通の型と、全デザイン共通のパラメータ
 *
 * チャットボックスは壁紙や時計と違い、canvas ではなくHTML要素として表示する
 * （文字の折り返し・アニメーションするエモート画像をブラウザに任せるため）。
 * そのためデザイン1種類は「スキーマ」と「専用のCSS（src/chat/<id>.css）」の組で表し、
 * パラメータはCSSのカスタムプロパティとしてCSSへ渡す。メッセージのHTML構造は全デザイン共通（view.ts）。
 */
import { withAlpha } from '../core/background'
import type { ParamSchema, ParamValues } from '../core/params'

/** 全デザイン共通のパラメータ。各デザインのスキーマの先頭に展開して使う */
export const commonChatSchema = {
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
  timestamps: { type: 'boolean', default: false, description: '書き込まれた時刻（時分）を表示する' },
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

/**
 * 書き込みの地の色（ふきだし・カードなど）に不透明度を反映する。
 * 透過（transparent）が指定された場合は、不透明度によらず透過のままにする。
 *
 * @param panel 地の色（#rrggbb または transparent）
 * @param opacity 不透明度（0〜1）
 */
export const panelColor = (panel: string, opacity: number): string =>
  panel === 'transparent' ? panel : withAlpha(panel, opacity)

/**
 * 書き込みの取得元。
 * 本番（live）の接続先はこのWorkerが扱う配信者のチャンネルに固定なので、ここでは持たない
 * （チャンネル名は stage.ts が /api/chat/channel から受け取る）。
 */
export type ChatSource = { readonly type: 'demo' } | { readonly type: 'live' }

/** パラメータから書き込みの取得元を決める */
export const sourceOf = ({ demo }: Pick<CommonChatParams, 'demo'>): ChatSource =>
  demo ? { type: 'demo' } : { type: 'live' }
