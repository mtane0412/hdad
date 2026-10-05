/**
 * 全国制覇マップの数と節目（conquest.ts）のテスト（issue #252）
 *
 * 決めたことは次のとおり。
 * - 制覇数は、これまでに紹介した市町村の数。流しきったら記録する紹介（レイドとキーワード）で、まだ紹介していない市町村なら1つ増える
 * - 試し再生（記録しない）と、紹介済みの市町村（全国制覇の後の2周目）では増えず、節目の一文も出さない
 * - 節目は、初めての都道府県・10件ごと・都道府県の全制覇・離島（地図の上で隣り合う市町村が無い市町村）の4つ
 */
import { describe, expect, it } from 'vitest'
import { conquestLabelOf, conquestOf, type ConquestTown } from './conquest'
import type { TownBorders } from './topo'

/** 東京都の区（13101 千代田区 〜 13112 世田谷区）。互いに隣り合っているものとして扱う */
const TOKYO_WARDS = ['13101', '13102', '13103', '13104', '13105', '13106', '13107', '13108', '13109', '13110', '13111', '13112']

/**
 * テスト用の小さな地図の境界。東京都の12区と、北海道の札幌市・当別町（隣り合う）と、隣り合う市町村が無い色丹村だけを持つ
 */
const borders: TownBorders = {
  coastal: new Set(),
  adjacent: new Map<string, ReadonlySet<string>>([
    ...TOKYO_WARDS.map((code): [string, ReadonlySet<string>] => [code, new Set(TOKYO_WARDS.filter((other) => other !== code))]),
    ['01100', new Set(['01303'])],
    ['01303', new Set(['01100'])],
    ['01695', new Set()],
  ]),
}

/** レイドで引いた千代田区。これまでに札幌市だけを紹介している */
const chiyodaByRaid: ConquestTown = {
  code: '13101',
  prefecture: '東京都',
  name: '千代田区',
  visited: ['01100'],
  visit: { occasion: 'raid', userName: '山田花子' },
}

describe('conquestOf', () => {
  it('記録する紹介で、まだ紹介していない市町村なら、制覇数が1つ増える', () => {
    expect(conquestOf(chiyodaByRaid, borders)).toMatchObject({ before: 1, after: 2, total: 15 })
  })

  it('試し再生（記録しない）では制覇数は増えず、節目の一文も出さない', () => {
    expect(conquestOf({ ...chiyodaByRaid, visit: null }, borders)).toMatchObject({ before: 1, after: 1, milestones: [] })
  })

  it('紹介済みの市町村（全国制覇の後の2周目）では制覇数は増えず、節目の一文も出さない', () => {
    expect(conquestOf({ ...chiyodaByRaid, visited: ['01100', '13101'] }, borders)).toMatchObject({ before: 2, after: 2, milestones: [] })
  })

  it('これまでに紹介した市町村のコードを、地図に塗る材料として持つ', () => {
    expect([...conquestOf(chiyodaByRaid, borders).visited]).toEqual(['01100'])
  })

  it('その都道府県で初めての紹介なら、初上陸の一文を出す', () => {
    expect(conquestOf(chiyodaByRaid, borders).milestones).toEqual(['東京都に初上陸！'])
  })

  it('同じ都道府県をもう紹介していれば、初上陸の一文は出さない', () => {
    expect(conquestOf({ ...chiyodaByRaid, visited: ['01100', '13102'] }, borders).milestones).toEqual([])
  })

  it('制覇数が10の倍数になったら、節目の一文を出す', () => {
    // 東京都の区を9つ紹介済みで、10件目に千代田区を引いた
    const visited = TOKYO_WARDS.slice(1, 10)

    expect(conquestOf({ ...chiyodaByRaid, visited }, borders).milestones).toEqual(['祝・10市町村制覇！'])
  })

  it('その都道府県の市町村をすべて紹介したら、完全制覇の一文を出す', () => {
    // 千代田区のほかの東京都の区（11区）と札幌市を紹介済み
    const visited = ['01100', ...TOKYO_WARDS.slice(1)]

    expect(conquestOf({ ...chiyodaByRaid, visited }, borders).milestones).toEqual(['東京都を完全制覇！'])
  })

  it('隣り合う市町村が無い市町村（離島）なら、上陸の一文を出す', () => {
    const shikotan: ConquestTown = { ...chiyodaByRaid, code: '01695', prefecture: '北海道', name: '色丹村' }

    expect(conquestOf(shikotan, borders).milestones).toEqual(['離島の色丹村に上陸！'])
  })

  it('節目が重なったら、初上陸・離島・完全制覇・件数の順にすべて出す', () => {
    // 東京都の区を9つ紹介済みで、10件目に北海道で初めての色丹村を引いた
    const shikotan: ConquestTown = { ...chiyodaByRaid, code: '01695', prefecture: '北海道', name: '色丹村', visited: TOKYO_WARDS.slice(0, 9) }

    expect(conquestOf(shikotan, borders).milestones).toEqual(['北海道に初上陸！', '離島の色丹村に上陸！', '祝・10市町村制覇！'])
  })

  it('地図に無いコードの市町村なら、黙って数えずに投げる', () => {
    expect(() => conquestOf({ ...chiyodaByRaid, code: '99999' }, borders)).toThrow('99999')
  })
})

describe('conquestLabelOf', () => {
  it('制覇数と全体の数を3桁区切りにし、割合を小数第1位まで添える', () => {
    expect(conquestLabelOf(35, 1747)).toBe('制覇 35 / 1,747（2.0%）')
  })

  it('まだ1つも紹介していなければ 0% にする', () => {
    expect(conquestLabelOf(0, 1747)).toBe('制覇 0 / 1,747（0.0%）')
  })
})
