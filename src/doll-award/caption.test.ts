/**
 * 人形の獲得の文言（caption.ts）のテスト
 *
 * 獲得1件から、画面に出す文言を次のとおり作ることを確かめる。
 * - 1行目は「◯◯さんが」、2行目は人形の名前と「を獲得！」
 * - 2つ以上なら個数を「×3」のように添え、1つなら添えない
 */
import { describe, expect, it } from 'vitest'
import type { DollAwardCall } from './call'
import { dollAwardCaption } from './caption'

const award = (count: number): DollAwardCall => ({
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
