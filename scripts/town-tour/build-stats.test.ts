/**
 * 市町村紹介の人口と面積づくり（build-stats.ts）のテスト
 *
 * 総務省の住民基本台帳人口と国土地理院の面積調の行を、一覧（towns.json）の市町村ごとの人口と面積に直す。確かめるのは次の点である。
 * - 人口は6桁の団体コードの先頭5桁、面積は0埋めした標準地域コードで、一覧のコードに突き合わせること
 * - 人口の表の名前は郡名つき（「古宇郡泊村」）なので、郡名つきでも郡名なしでも同じ市町村と認めること
 * - 北方領土の6村は人口を持たない（null）こと
 * - 突き合わない市町村があれば、黙って作らずエラーにすること
 * - 面積調の CSV から、市区町村の行だけを取り出すこと
 */
import { describe, expect, it } from 'vitest'
import { areaRowsOf, buildStats, type AreaRow, type PopulationRow } from './build-stats'
import type { Town } from './build-data'

const sapporo: Town = { code: '01100', prefecture: '北海道', county: '', name: '札幌市' }
const tomariShakotan: Town = { code: '01403', prefecture: '北海道', county: '古宇郡', name: '泊村' }
const shikotan: Town = { code: '01695', prefecture: '北海道', county: '色丹郡', name: '色丹村' }

const population = (code: string, prefecture: string, name: string, count: number): PopulationRow => ({
  code,
  prefecture,
  name,
  population: count,
})
const area = (code: string, prefecture: string, name: string, squareKilometers: number): AreaRow => ({
  code,
  prefecture,
  name,
  area: squareKilometers,
})

describe('buildStats', () => {
  it('人口は団体コードの先頭5桁、面積は0埋めしたコードで一覧の市町村に突き合わせる', () => {
    const stats = buildStats(
      [sapporo],
      [population('011002', '北海道', '札幌市', 1956928), population('011011', '北海道', '札幌市中央区', 250000)],
      [area('1100', '北海道', '札幌市', 1121.26), area('1101', '北海道', '(札幌市)中央区', 46.42)],
    )

    expect(stats).toEqual({ '01100': { population: 1956928, area: 1121.26 } })
  })

  it('人口の表の郡名つきの名前（古宇郡泊村）も同じ村と認める', () => {
    const stats = buildStats(
      [tomariShakotan],
      [population('014036', '北海道', '古宇郡泊村', 1500)],
      [area('1403', '北海道', '泊村', 82.27)],
    )

    expect(stats['01403']).toEqual({ population: 1500, area: 82.27 })
  })

  it('北方領土の村は、人口の表に0人の行があっても人口を null にする', () => {
    const stats = buildStats(
      [shikotan],
      [population('016951', '北海道', '色丹郡色丹村', 0)],
      [area('1695', '北海道', '色丹村', 250.57)],
    )

    expect(stats['01695']).toEqual({ population: null, area: 250.57 })
  })

  it('人口の表が旧字体で書いている町（須惠町）は、表で認めた名前なら同じ町と認める', () => {
    const sue: Town = { code: '40344', prefecture: '福岡県', county: '糟屋郡', name: '須恵町' }
    const stats = buildStats(
      [sue],
      [population('403440', '福岡県', '糟屋郡須惠町', 27000)],
      [area('40344', '福岡県', '須恵町', 16.31)],
    )

    expect(stats['40344']).toEqual({ population: 27000, area: 16.31 })
  })

  it('人口の表に無い市町村があればエラーにする', () => {
    expect(() => buildStats([sapporo], [], [area('1100', '北海道', '札幌市', 1121.26)])).toThrow('人口')
  })

  it('面積の表に無い市町村があればエラーにする', () => {
    expect(() => buildStats([sapporo], [population('011002', '北海道', '札幌市', 1956928)], [])).toThrow('面積')
  })

  it('コードが同じでも名前が食い違えばエラーにする', () => {
    expect(() =>
      buildStats(
        [sapporo],
        [population('011002', '北海道', '函館市', 240000)],
        [area('1100', '北海道', '札幌市', 1121.26)],
      ),
    ).toThrow('函館市')
  })
})

describe('areaRowsOf', () => {
  it('面積調の CSV から、コードと市区町村名を持つ行だけを取り出す', () => {
    const csv = [
      '\uFEFF全国都道府県市区町村別面積調,,,,R06.01.01_浜松市区再編以降,',
      ',【本データに関する説明事項】,,,,',
      '標準地域コード,都道府県,郡･支庁･振興局等,市区町村,令和8年7月1日(k㎡),令和8年7月1日備考',
      '全国面積,,,,377973.68,',
      '1000,北海道,,,83422.23,',
      ',北海道(市部),,,18532.38,（参考値）',
      '1100,北海道,石狩振興局,札幌市,1121.26,',
      '1696,北海道,根室振興局,泊村,535.35,（参考値）',
      ',北海道,根室振興局,風蓮湖,64.17,',
    ].join('\n')

    expect(areaRowsOf(csv)).toEqual([
      area('1100', '北海道', '札幌市', 1121.26),
      area('1696', '北海道', '泊村', 535.35),
    ])
  })
})
