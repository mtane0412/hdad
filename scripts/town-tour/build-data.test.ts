/**
 * 市町村紹介の一覧づくり（build-data.ts の buildTowns）のテスト
 *
 * 国土数値情報の行政区域（N03）の属性を、引く対象の市町村の一覧に直す。確かめるのは次の5点である。
 * - 政令市の区を市にまとめ、区のコードから市のコードを引けること
 * - 東京23区（特別区）は市に属さないので、1区ずつ残すこと
 * - 郡が違う同名の村（古宇郡泊村と国後郡泊村）を別々に残すこと
 * - どの市町村にも属さない「所属未定地」を一覧から外すこと
 * - 市のコードを知らない政令市が現れたら、黙って作らずエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { buildTowns, type N03Record } from './build-data'

/** N03 の1件分の属性を作る（郡・区が無いものは空文字にする） */
const record = (
  prefecture: string,
  county: string,
  name: string,
  ward: string,
  code: string,
): N03Record => ({ N03_001: prefecture, N03_003: county, N03_004: name, N03_005: ward, N03_007: code })

describe('buildTowns', () => {
  it('政令市の区を市にまとめ、区のコードから市のコードを引けるようにする', () => {
    const { towns, townCodeByAreaCode } = buildTowns([
      record('北海道', '', '札幌市', '中央区', '01101'),
      record('北海道', '', '札幌市', '清田区', '01110'),
    ])

    expect(towns).toEqual([{ code: '01100', prefecture: '北海道', county: '', name: '札幌市' }])
    expect(townCodeByAreaCode.get('01101')).toBe('01100')
    expect(townCodeByAreaCode.get('01110')).toBe('01100')
  })

  it('東京23区は1区ずつ残す', () => {
    const { towns } = buildTowns([
      record('東京都', '', '千代田区', '', '13101'),
      record('東京都', '', '中央区', '', '13102'),
    ])

    expect(towns.map((town) => town.name)).toEqual(['千代田区', '中央区'])
  })

  it('郡が違う同名の村を別々に残す', () => {
    const { towns } = buildTowns([
      record('北海道', '古宇郡', '泊村', '', '01403'),
      record('北海道', '国後郡', '泊村', '', '01696'),
    ])

    expect(towns).toEqual([
      { code: '01403', prefecture: '北海道', county: '古宇郡', name: '泊村' },
      { code: '01696', prefecture: '北海道', county: '国後郡', name: '泊村' },
    ])
  })

  it('所属未定地を一覧から外す', () => {
    const { towns, townCodeByAreaCode } = buildTowns([
      record('千葉県', '', '所属未定地', '', '12000'),
      record('千葉県', '', '銚子市', '', '12202'),
    ])

    expect(towns.map((town) => town.name)).toEqual(['銚子市'])
    expect(townCodeByAreaCode.has('12000')).toBe(false)
  })

  it('一覧をコードの順に並べる', () => {
    const { towns } = buildTowns([
      record('沖縄県', '', '那覇市', '', '47201'),
      record('北海道', '', '函館市', '', '01202'),
    ])

    expect(towns.map((town) => town.code)).toEqual(['01202', '47201'])
  })

  it('市のコードを知らない政令市が現れたらエラーにする', () => {
    expect(() => buildTowns([record('架空県', '', '架空市', '中央区', '99101')])).toThrow('架空県架空市')
  })
})
