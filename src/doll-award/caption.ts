/**
 * 人形の獲得の文言
 *
 * 獲得1件から、合成ページに出す文言（「田中太郎さんが」「クマ人形 ×3 を獲得！」）の部品を作る。
 * 部品に分けるのは、見た目（view.ts・doll-award.css）で人形の名前と個数だけを目立たせるため。
 */
import type { DollAwardCall } from './call'

/** 画面に出す文言の部品 */
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

export const dollAwardCaption = ({ userName, count, doll }: DollAwardCall): DollAwardCaption => ({
  who: `${userName}さんが`,
  what: doll.name,
  count: count > 1 ? `×${String(count)}` : null,
  suffix: 'を獲得！',
})
