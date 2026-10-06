/**
 * 市町村紹介のナレーションで読み上げる文（narration.ts）のテスト
 *
 * 冒頭の一文と、画面に流す場面（大見出し・各項目・配信者への振り）ごとの読み上げる文を確かめる。
 * 特に重要なのは次の点である。
 * - 読み上げる文が、画面に流す場面と同じ並び・同じ数であること（場面の長さを読み上げに合わせるため）
 * - 大見出しは見出し「この町、実は…」から読み、項目は見出し（「名物」など）を読まないこと
 */
import { describe, expect, it } from 'vitest'
import { narrationTextsOf } from './narration'
import { tourLinesOf, type TownTourIntro } from './tour'

/** 広島県府中市の紹介（大見出し・項目2つ・振り） */
const fuchuTour: TownTourIntro['tour'] = {
  hook: 'お好み焼きにミンチ肉を使う市',
  points: [
    { label: '名物', text: '約400年の歴史を持つ府中味噌が名物です。' },
    { label: 'ご当地の味', text: 'ミンチ肉を使う「府中焼き」というお好み焼きがあります。' },
  ],
  cue: '府中焼き、食べたことありますか？',
}

describe('narrationTextsOf', () => {
  const headline = '山田花子さんのレイドを記念して、本日は広島県府中市をご紹介します'

  it('冒頭の一文はそのまま読み、場面は大見出し・各項目・振りの順に読む', () => {
    expect(narrationTextsOf(headline, tourLinesOf({ tour: fuchuTour, bond: null }, '府中市'))).toEqual({
      opening: headline,
      lines: [
        'この市、実は…お好み焼きにミンチ肉を使う市',
        '約400年の歴史を持つ府中味噌が名物です。',
        'ミンチ肉を使う「府中焼き」というお好み焼きがあります。',
        'ところで…府中焼き、食べたことありますか？',
      ],
    })
  })

  it('共通点のある紹介では、振りの代わりに共通点を見出し「○○さんとこの市、実は…」から読む（issue #275）', () => {
    const bond = {
      raiderName: 'kenta_dev',
      raiderIcon: 'https://static-cdn.jtvnw.net/kenta.png',
      raiderQuote: '味噌汁',
      townQuote: '府中味噌',
      text: '府中味噌と味噌汁配信。どちらも味噌で人を温める仲間なのです。',
      certificateReason: '本市の府中味噌と同じく味噌で視聴者を温められた功績につき',
    }

    expect(narrationTextsOf(headline, tourLinesOf({ tour: fuchuTour, bond }, '府中市')).lines.at(-1)).toBe(
      'kenta_devさんとこの市、実は…府中味噌と味噌汁配信。どちらも味噌で人を温める仲間なのです。',
    )
  })

  it('大見出しの無い紹介では、大見出しの場面と同じく読む文も持たない（場面と同じ並びにする）', () => {
    const lines = tourLinesOf({ tour: { ...fuchuTour, hook: '' }, bond: null }, '府中市')

    expect(narrationTextsOf(headline, lines).lines).toHaveLength(lines.length)
    expect(narrationTextsOf(headline, lines).lines[0]).toBe('約400年の歴史を持つ府中味噌が名物です。')
  })
})
