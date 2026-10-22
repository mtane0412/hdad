/**
 * 人形（視聴者が所持する人形）の形と検証
 *
 * 視聴者に人形を渡したり使わせたりする仕組みの土台（issue #418）。人形は「ふつうの人形」と「スーパー人形」の2種類を
 * 1組として登録し、1配信で使う組は「いまの人形」として1組だけ選ぶ。スーパー人形はふつうの人形3つ分の価値を持つ
 * （比は設定項目にしない。docs/principles.md の1。ランキングの点数に使う SUPER_DOLL_VALUE。画面の説明は src/dolls/doll.ts）。
 *
 * 通信も時刻も持たない純粋な関数だけを置き、読み書きは worker/doll-store.ts、経路は worker/doll-routes.ts が持つ。
 *
 * 注意: 画像は R2 の素材（種類 image）の ID で指す。指した素材が無い・画像でないなら受け付けない（配信中に画像が出ないことに
 *   後から気付かないため。方針4）。
 */
import { ConfigError, type MediaKind } from './alert-config'
import type { TriggerKind } from './trigger-menu'

/** 人形の種類。normal はふつうの人形、super はスーパー人形 */
export const DOLL_KINDS = ['normal', 'super'] as const
export type DollKind = (typeof DOLL_KINDS)[number]

/** スーパー人形1つが、ふつうの人形いくつ分の価値を持つか。ランキングの点数（ふつう＝1）に使う */
export const SUPER_DOLL_VALUE = 3

/** 合成ページに出すランキングの人数の上限 */
export const DOLL_RANKING_LIMIT = 5

/** 人形の名前の上限（見た目の文字数）。管理画面の一覧に収まる長さにする */
export const MAX_DOLL_NAME_LENGTH = 20

/**
 * 一度に増減させられる数の上限。打ち間違いで桁違いの数を渡さないための歯止めで、手での増減とトリガーの動作
 * 「人形を渡す」（worker/alert-config.ts の dollGrant）の個数の両方に使う
 */
export const MAX_DOLL_CHANGE = 10

/**
 * 何で増減したか（台帳の reason と、理由ごとに控える項目）。
 * - manual: 配信者が管理画面から手で増減させたもの
 * - trigger: トリガーの動作「人形を渡す」で渡したもの（issue #419）。どのトリガーの項目で渡したかを控える
 * - chatDeduction・kanjiQuiz: そのゲームの正解者に渡したもの（issue #420。DOLL_PRIZE_GAMES）
 */
export type DollOrigin =
  | { readonly reason: 'manual' }
  | { readonly reason: 'trigger'; readonly triggerKind: TriggerKind }
  | { readonly reason: DollPrizeGame }

export type DollReason = DollOrigin['reason']

/** 正解者に人形を渡せるゲーム。chatDeduction はチャットで推理、kanjiQuiz は漢字クイズ。台帳の理由（reason）にもこの名前を書く */
export const DOLL_PRIZE_GAMES = ['chatDeduction', 'kanjiQuiz'] as const
export type DollPrizeGame = (typeof DOLL_PRIZE_GAMES)[number]

/** ゲームの正解者に渡す人形。kind が null なら渡さない。個数は1で固定する（issue #420） */
export interface DollPrize {
  readonly kind: DollKind | null
}

/** 人形1種類ぶんの名前と画像 */
export interface DollFigure {
  readonly name: string
  /** 画像の素材（R2）の ID */
  readonly mediaId: string
}

/** 管理画面から受け取る、人形の組1組の中身 */
export interface DollSetInput {
  readonly normal: DollFigure
  readonly super: DollFigure
}

/** 保存済みの人形の組 */
export interface DollSet extends DollSetInput {
  /** 組を見分ける ID（消した ID は使い回さない） */
  readonly id: number
  /** いまの人形か。true になるのは多くても1組だけ */
  readonly current: boolean
  /** 最後に書き換えた時刻（ISO 8601） */
  readonly updatedAt: string
}

/** ある視聴者が、ある組の人形をいくつ持っているか */
export interface DollHolding {
  /** Twitch のユーザー ID */
  readonly userId: string
  readonly setId: number
  readonly normal: number
  readonly super: number
}

/** ある視聴者の、いまの人形の所持数（持っていなければ 0） */
export interface DollStanding {
  /** いまの人形の組 */
  readonly set: DollSet
  readonly normal: number
  readonly super: number
}

/** ランキングの1人ぶん */
export interface DollRankingEntry {
  /** 順位（1 から。同点は同じ順位で、次の順位は人数ぶん飛ぶ） */
  readonly rank: number
  readonly userId: string
  readonly userName: string
  readonly normal: number
  readonly super: number
  /** 点数（ふつう＝1・スーパー＝SUPER_DOLL_VALUE） */
  readonly points: number
}

/** いまの人形のランキング */
export interface DollRanking {
  /** いまの人形の組 */
  readonly set: DollSet
  /** 点数の高い順。0 点の人は並べない */
  readonly entries: readonly DollRankingEntry[]
}

/** 管理画面から受け取る、手での増減 */
export interface DollChangeInput {
  readonly kind: DollKind
  /** 増やすなら正、減らすなら負の整数（0 は受け付けない） */
  readonly delta: number
}

/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '人形'

/** 見た目の1文字（書記素クラスタ）ごとに分ける（テキストと同じ数え方） */
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

const lengthOf = (text: string): number => [...graphemes.segment(text)].length

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isDollKind = (value: unknown): value is DollKind => DOLL_KINDS.some((kind) => kind === value)

/**
 * 人形1種類ぶんを検証する。名前は前後の空白を落として受け取る。
 *
 * @param at 問題点の先頭に付ける項目の名前（normal・super）
 * @param problems 見つけた問題点の記録先（最初の1件で止めず、すべて集めるため呼び出し側と共有する）
 */
const parseFigure = (value: unknown, at: DollKind, kindOf: (mediaId: string) => MediaKind | null, problems: string[]): DollFigure | null => {
  if (!isRecord(value)) {
    problems.push(`${at}: { name, mediaId } の形で指定してください`)
    return null
  }

  const name = typeof value.name === 'string' ? value.name.trim() : undefined
  if (name === undefined) problems.push(`${at}.name: 名前を文字列で指定してください`)
  else if (name === '') problems.push(`${at}.name: 名前を入れてください`)
  else if (lengthOf(name) > MAX_DOLL_NAME_LENGTH) problems.push(`${at}.name: 名前は${MAX_DOLL_NAME_LENGTH}文字以内にしてください（いまは${lengthOf(name)}文字です）`)

  const { mediaId } = value
  const kind = typeof mediaId === 'string' ? kindOf(mediaId) : null
  if (kind === null) problems.push(`${at}.mediaId: 素材「${String(mediaId)}」が存在しません`)
  else if (kind !== 'image') problems.push(`${at}.mediaId: 素材「${String(mediaId)}」は画像ではありません`)

  if (name === undefined || typeof mediaId !== 'string') return null
  return { name, mediaId }
}

/**
 * 管理画面から送られてきた人形の組1組を検証する。
 *
 * @param input `{ normal: { name, mediaId }, super: { name, mediaId } }`
 * @param kindOf 素材の ID からその種類を引く。無い素材なら null
 * @throws ConfigError 問題がある場合。問題点は最初の1件で止めずにすべて集める
 */
export const parseDollSetInput = (input: unknown, kindOf: (mediaId: string) => MediaKind | null): DollSetInput => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['人形の組は { normal, super } の形で指定してください'])

  const problems: string[] = []
  const normal = parseFigure(input.normal, 'normal', kindOf, problems)
  const superFigure = parseFigure(input.super, 'super', kindOf, problems)
  if (problems.length > 0 || normal === null || superFigure === null) throw new ConfigError(SUBJECT, problems)
  return { normal, super: superFigure }
}

/**
 * 管理画面から送られてきた手での増減を検証する。
 *
 * @param input `{ kind: 'normal' | 'super', delta: number }`
 * @throws ConfigError 問題がある場合
 */
export const parseDollChangeInput = (input: unknown): DollChangeInput => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['増減は { kind, delta } の形で指定してください'])

  const problems: string[] = []
  const { kind, delta } = input
  if (!isDollKind(kind)) problems.push(`kind: ${DOLL_KINDS.join(' / ')} のいずれかを指定してください`)
  const deltaOk = typeof delta === 'number' && Number.isInteger(delta) && delta !== 0 && Math.abs(delta) <= MAX_DOLL_CHANGE
  if (!deltaOk) problems.push(`delta: -${MAX_DOLL_CHANGE}〜${MAX_DOLL_CHANGE} の0でない整数で指定してください`)

  if (problems.length > 0 || !isDollKind(kind) || typeof delta !== 'number') throw new ConfigError(SUBJECT, problems)
  return { kind, delta }
}

/**
 * 管理画面から送られてきた、ゲームの正解者に渡す人形を検証する。
 *
 * @param input `{ kind: 'normal' | 'super' | null }`（null は渡さない）
 * @throws ConfigError 問題がある場合。kind の書き忘れを「渡さない」と読み替えない
 */
export const parseDollPrize = (input: unknown): DollPrize => {
  const kind = isRecord(input) ? input.kind : undefined
  if (kind !== null && !isDollKind(kind)) {
    throw new ConfigError(SUBJECT, [`kind: ${DOLL_KINDS.join(' / ')} のいずれか、渡さないなら null を指定してください`])
  }
  return { kind }
}
