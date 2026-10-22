/**
 * 人形の獲得の素材の文言
 *
 * 獲得・1人ぶんの所持数・ランキングから、合成ページに出す文言の部品を作る。
 * 部品に分けるのは、見た目（view.ts・doll-award.css）で人形の名前・個数・点数だけを目立たせるため。
 */
import { SUPER_DOLL_VALUE } from '../dolls/doll'
import type { DollAwardCall, DollRankingCall, DollStandingCall } from './call'

/** 獲得の文言の部品 */
export interface DollAwardCaption {
  /** 1行目（「◯◯さんが」） */
  readonly who: string
  /** 2行目の人形の名前 */
  readonly what: string
  /** 2つ以上のときの個数（「×3」）。1つなら null */
  readonly count: string | null
  /** 2行目の締め */
  readonly suffix: string
}

/** 人形1種類ぶんの名前と個数（「×2」。0 つも出す） */
export interface DollCountCaption {
  readonly name: string
  readonly count: string
}

/** 1人ぶんの所持数の文言の部品 */
export interface DollStandingCaption {
  /** 見出し（「◯◯さんの人形」） */
  readonly title: string
  readonly normal: DollCountCaption
  readonly super: DollCountCaption
}

/** ランキングの文言の部品 */
export interface DollRankingCaption {
  readonly title: string
  /** 点数の数え方（「クマ人形＝1点・スーパークマ人形＝3点」） */
  readonly note: string
  /** 1人ずつの順位（「1位」）・名前・点数（「3点」） */
  readonly rows: readonly { readonly rank: string; readonly name: string; readonly points: string }[]
  /** まだ誰も持っていないときの文言。1人でもいれば null */
  readonly empty: string | null
}

export const dollAwardCaption = ({ userName, count, doll }: DollAwardCall): DollAwardCaption => ({
  who: `${userName}さんが`,
  what: doll.name,
  count: count > 1 ? `×${String(count)}` : null,
  suffix: 'を獲得！',
})

const countCaption = ({ name, count }: DollStandingCall['normal']): DollCountCaption => ({ name, count: `×${String(count)}` })

export const dollStandingCaption = ({ userName, normal, super: superFigure }: DollStandingCall): DollStandingCaption => ({
  title: `${userName}さんの人形`,
  normal: countCaption(normal),
  super: countCaption(superFigure),
})

export const dollRankingCaption = ({ normal, super: superFigure, entries }: DollRankingCall): DollRankingCaption => ({
  title: '人形ランキング',
  note: `${normal.name}＝1点・${superFigure.name}＝${String(SUPER_DOLL_VALUE)}点`,
  rows: entries.map(({ rank, userName, points }) => ({ rank: `${String(rank)}位`, name: userName, points: `${String(points)}点` })),
  empty: entries.length === 0 ? `まだ誰も${normal.name}を持っていません` : null,
})
