/**
 * 同梱した市町村の一覧（towns.json）と地図（public/town-tour/japan.topo.json）の突き合わせのテスト
 *
 * 2つは scripts/town-tour/build-data.ts が同じ N03 から作るが、片方だけ作り直したり手で直したりすると食い違う。
 * 引いた市町村の形が地図に無いと、レイドの最中に素材が描けない。確かめるのは次の4点である。
 * - 一覧のコードに重複が無いこと
 * - 一覧のすべての市町村に地図の形があり、地図に一覧に無い形が無いこと（1対1）
 * - 政令市は区ではなく市として1件になっていること
 * - 東京23区と北方領土の村が1件ずつ入っていること
 * - 一覧のすべての市町村に Wikipedia の記事名（articles.json。scripts/town-tour/build-articles.ts が作る）があること
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import articles from './articles.json'
import towns from './towns.json'

/** 地図の TopoJSON のうち、突き合わせに使う部分 */
type TownMap = { objects: { towns: { geometries: { properties: { code: string } }[] } } }

const townMap: TownMap = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../public/town-tour/japan.topo.json'), 'utf8'),
)
const mapCodes = townMap.objects.towns.geometries.map((geometry) => geometry.properties.code)
const townCodes = towns.map((town) => town.code)

/** 都道府県名と名前から市町村を探す */
const findTowns = (prefecture: string, name: string) =>
  towns.filter((town) => town.prefecture === prefecture && town.name === name)

describe('市町村の一覧と地図', () => {
  it('一覧のコードに重複が無い', () => {
    expect(new Set(townCodes).size).toBe(townCodes.length)
  })

  it('一覧と地図の市町村が1対1で対応する', () => {
    expect([...mapCodes].sort()).toEqual([...townCodes].sort())
  })

  it('政令市は区ではなく市として1件になっている', () => {
    expect(findTowns('北海道', '札幌市')).toEqual([{ code: '01100', prefecture: '北海道', county: '', name: '札幌市' }])
    expect(towns.some((town) => town.name.startsWith('札幌市') && town.name !== '札幌市')).toBe(false)
  })

  it('東京23区と北方領土の村が1件ずつ入っている', () => {
    expect(findTowns('東京都', '千代田区')).toHaveLength(1)
    expect(findTowns('北海道', '色丹村')).toHaveLength(1)
    // 泊村は古宇郡（積丹半島）と国後郡の2つがある
    expect(findTowns('北海道', '泊村').map((town) => town.county).sort()).toEqual(['古宇郡', '国後郡'])
  })

  it('一覧のすべての市町村に記事名があり、一覧に無いコードの記事名が無い', () => {
    expect(Object.keys(articles).sort()).toEqual([...townCodes].sort())
  })
})
