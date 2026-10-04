/**
 * 市町村紹介の呼び出し（合成ページへ押し出す中身）の組み立てのテスト
 */
import { describe, expect, it } from 'vitest'
import towns from '../src/town-tour/towns.json'
import { pickTown, townTourCallOf } from './town-tour-call'

describe('pickTown', () => {
  it('乱数が0なら一覧の先頭の市町村を引く', () => {
    expect(pickTown(() => 0)).toEqual(towns[0])
  })

  it('乱数が1に近ければ一覧の末尾の市町村を引く（範囲の外へはみ出さない）', () => {
    expect(pickTown(() => 0.9999999)).toEqual(towns[towns.length - 1])
  })
})

describe('townTourCallOf', () => {
  const town = { code: '13101', prefecture: '東京都', county: '', name: '千代田区' }
  const countyTown = { code: '01303', prefecture: '北海道', county: '石狩郡', name: '当別町' }

  it('レイドなら「○○さんのレイドを記念して」で始まる一文を添える', () => {
    expect(townTourCallOf(town, { occasion: 'raid', userName: '山田花子' })).toEqual({
      code: '13101',
      prefecture: '東京都',
      county: '',
      name: '千代田区',
      headline: '山田花子さんのレイドを記念して、本日は東京都千代田区をご紹介します',
    })
  })

  it('キーワード（!darts など）なら、発言した人の投げたダーツに見立てた一文を添える', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }).headline).toBe(
      '田中太郎さんのダーツが刺さったのは、北海道石狩郡当別町でした',
    )
  })

  it('管理画面の試し再生なら、試しであることが分かる一文を添える', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }).headline).toBe('試し再生: 本日は東京都千代田区をご紹介します')
  })
})
