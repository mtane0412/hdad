/**
 * 人形の組と所持数の形（ブラウザ側）
 *
 * 視聴者が所持する人形（issue #418）の、Worker から受け取る形と、受け取るたびに形を確かめる型ガードを置く。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、形は worker/doll.ts と合わせてここにも書く。
 */
import { isRecord } from '@/core/api'

/** 人形の種類。normal はふつうの人形、super はスーパー人形 */
export type DollKind = 'normal' | 'super'

/** 人形の種類の画面の言い方 */
export const DOLL_KIND_LABELS: Readonly<Record<DollKind, string>> = { normal: 'ふつうの人形', super: 'スーパー人形' }

/** 正解者に人形を渡せるゲーム（worker/doll.ts の DOLL_PRIZE_GAMES と合わせる）。chatDeduction はチャットで推理、kanjiQuiz は漢字クイズ */
export type DollPrizeGame = 'chatDeduction' | 'kanjiQuiz'

/** スーパー人形1つが、ふつうの人形いくつ分の価値を持つか（画面に出すだけ。worker/doll.ts の説明と合わせる） */
export const SUPER_DOLL_VALUE = 3

/** 人形1種類ぶんの名前と画像 */
export interface DollFigure {
  readonly name: string
  /** 画像の素材（R2）の ID */
  readonly mediaId: string
}

/** 保存済みの人形の組 */
export interface DollSet {
  readonly id: number
  readonly normal: DollFigure
  readonly super: DollFigure
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

const isDollFigure = (value: unknown): value is DollFigure => isRecord(value) && typeof value.name === 'string' && typeof value.mediaId === 'string'

export const isDollSet = (value: unknown): value is DollSet =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  isDollFigure(value.normal) &&
  isDollFigure(value.super) &&
  typeof value.current === 'boolean' &&
  typeof value.updatedAt === 'string'

/** 人形の種類か（正解者に渡す人形の応答を確かめるのに使う） */
export const isDollKind = (value: unknown): value is DollKind => value === 'normal' || value === 'super'

export const isDollHolding = (value: unknown): value is DollHolding =>
  isRecord(value) && typeof value.userId === 'string' && typeof value.setId === 'number' && typeof value.normal === 'number' && typeof value.super === 'number'
