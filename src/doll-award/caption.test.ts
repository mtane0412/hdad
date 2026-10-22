/**
 * 人形の獲得の文言（caption.ts）のテスト
 *
 * 獲得・所持数・ランキングから、画面に出す文言を次のとおり作ることを確かめる。
 * - 獲得: 1行目は「◯◯さんが」、2行目は人形の名前と「を獲得！」。2つ以上なら個数を「×3」のように添え、1つなら添えない
 * - 所持数: 見出しは「◯◯さんの人形」、種類ごとに名前と「×2」（0 つでも「×0」）
 * - ランキング: 見出しは「人形ランキング」、1人ずつ「1位」・名前・「3点」。まだ誰も持っていなければその旨を出す
 */
import { describe, expect, it } from 'vitest'
import type { DollAwardCall, DollRankingCall, DollStandingCall } from './call'
import { dollAwardCaption, dollRankingCaption, dollStandingCaption } from './caption'

const award = (count: number): DollAwardCall => ({
  type: 'award',
  id: 'trigger:m1:dollGrant:0',
  userName: '田中太郎',
  kind: 'normal',
  count,
  doll: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k' },
})

describe('dollAwardCaption', () => {
  it('1つなら個数を添えない', () => {
    expect(dollAwardCaption(award(1))).toEqual({ who: '田中太郎さんが', what: 'クマ人形', count: null, suffix: 'を獲得！' })
  })

  it('2つ以上なら個数を「×3」のように添える', () => {
    expect(dollAwardCaption(award(3))).toEqual({ who: '田中太郎さんが', what: 'クマ人形', count: '×3', suffix: 'を獲得！' })
  })
})

describe('dollStandingCaption', () => {
  it('見出しは「◯◯さんの人形」で、種類ごとに名前と個数を出す（0 つも出す）', () => {
    const standing: DollStandingCall = {
      type: 'standing',
      id: 'standing-1',
      userId: '1001',
      userName: '田中太郎',
      normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k', count: 2 },
      super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k', count: 0 },
    }

    expect(dollStandingCaption(standing)).toEqual({
      title: '田中太郎さんの人形',
      normal: { name: 'クマ人形', count: '×2' },
      super: { name: 'スーパークマ人形', count: '×0' },
    })
  })
})

describe('dollRankingCaption', () => {
  const ranking = (entries: DollRankingCall['entries']): DollRankingCall => ({
    type: 'ranking',
    id: 'ranking-1',
    normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k' },
    super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k' },
    entries,
  })

  it('1人ずつ順位・名前・点数を出し、点数の数え方を添える', () => {
    const caption = dollRankingCaption(
      ranking([
        { rank: 1, userName: '花子', normal: 0, super: 1, points: 3 },
        { rank: 1, userName: '田中太郎', normal: 3, super: 0, points: 3 },
      ]),
    )

    expect(caption).toEqual({
      title: '人形ランキング',
      note: 'クマ人形＝1点・スーパークマ人形＝3点',
      rows: [
        { rank: '1位', name: '花子', points: '3点' },
        { rank: '1位', name: '田中太郎', points: '3点' },
      ],
      empty: null,
    })
  })

  it('まだ誰も持っていなければ、その旨を出す', () => {
    expect(dollRankingCaption(ranking([])).empty).toBe('まだ誰もクマ人形を持っていません')
  })
})
