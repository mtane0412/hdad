/**
 * 市町村の大きさを身近なものに置き換える文（scale.ts の scaleLinesOf）のテスト
 *
 * ズームの着地で市町村の名前の下に出す文を、人口・面積・いま見ている人数から組み立てる。確かめるのは次の点である。
 * - 人口は桁区切りで出し、面積は山手線の内側の何個分かで出すこと（大きさに応じて桁を変える）
 * - いま見ている人数（レイドなら同接にレイドの人数を足した数）で挑むと、ひとり何人倒せば制圧できるかを、切り上げて出すこと
 * - 見ている人数が分からない（配信中でない）ときは、挑む文を出さないこと
 * - 人口の記録が無い村（北方領土）では、挑む文を出さず、記録が無いと分かる文にすること
 */
import { describe, expect, it } from 'vitest'
import { scaleLinesOf } from './scale'

describe('scaleLinesOf', () => {
  it('レイドでは、レイドを合わせた人数でひとり何人倒せば制圧できるかを出す', () => {
    // 富山県舟橋村: 人口3,329人・3.47km²。同接20人にレイドの30人が加わった
    const lines = scaleLinesOf({ name: '舟橋村', population: 3329, area: 3.47, audience: { kind: 'raid', count: 50 } })

    expect(lines).toEqual([
      '人口 3,329人 ・ 面積は山手線の内側の約0.06個分',
      'レイドを合わせた50人で挑むと、ひとり67人倒せばこの村を制圧',
    ])
  })

  it('キーワードでは、いまの同接でひとり何人倒せば制圧できるかを出す', () => {
    // 北海道札幌市: 人口1,954,588人・1,121.26km²。いまの同接は12人
    const lines = scaleLinesOf({ name: '札幌市', population: 1954588, area: 1121.26, audience: { kind: 'live', count: 12 } })

    expect(lines).toEqual([
      '人口 1,954,588人 ・ 面積は山手線の内側の約18個分',
      'いまの12人で挑むと、ひとり162,883人倒せばこの市を制圧',
    ])
  })

  it('見ている人数のほうが人口より多ければ、ひとり1人で制圧できる', () => {
    // 東京都青ヶ島村: 人口155人・5.95km²
    const lines = scaleLinesOf({ name: '青ヶ島村', population: 155, area: 5.95, audience: { kind: 'raid', count: 300 } })

    expect(lines[1]).toBe('レイドを合わせた300人で挑むと、ひとり1人倒せばこの村を制圧')
  })

  it('面積が山手線の内側の1個分から10個分のあいだなら、小数1桁で出す', () => {
    const lines = scaleLinesOf({ name: '色丹村', population: null, area: 250.57, audience: null })

    expect(lines[0]).toContain('約4.0個分')
  })

  it('見ている人数が分からないときは、挑む文を出さない', () => {
    const lines = scaleLinesOf({ name: '札幌市', population: 1954588, area: 1121.26, audience: null })

    expect(lines).toEqual(['人口 1,954,588人 ・ 面積は山手線の内側の約18個分'])
  })

  it('人口の記録が無い村（北方領土）では、記録が無いと出し、挑む文を出さない', () => {
    const lines = scaleLinesOf({ name: '色丹村', population: null, area: 250.57, audience: { kind: 'live', count: 12 } })

    expect(lines).toEqual(['人口の記録なし（北方領土） ・ 面積は山手線の内側の約4.0個分'])
  })
})
