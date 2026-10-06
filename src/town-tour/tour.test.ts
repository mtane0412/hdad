/**
 * 市町村紹介の呼び出し（押し出し）と紹介（API の応答）の読み取りのテスト
 *
 * どちらも Worker から届くものなので、想定した形でなければ補わずに投げることを確かめる（Fail-Fast）。
 */
import { describe, expect, it } from 'vitest'
import { parseTownTourMessage, readTownTourIntro, tourLinesOf } from './tour'

/** レイドで引いた北海道当別町の呼び出し */
const tobetsuCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  quizId: 'quiz-tobetsu',
  quizHeadline: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
  // 音は BGM だけを選んである
  sound: {
    slots: { bgm: '/api/media/media-cookie?key=overlay-key', opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
  // 当別町の人口と面積。同接20人にレイドの30人が加わった
  population: 14974,
  area: 422.86,
  audience: { kind: 'raid', count: 50 },
  // これまでに札幌市を紹介済みで、流しきったらレイドとして記録する
  visited: ['01100'],
  visit: { occasion: 'raid', userName: '山田花子' },
  // 締めの認定証で、レイド元を名誉町民にする
  honoraryCitizen: '山田花子',
  // 締めの共通点は、レイド元のログイン名と連れてきた人数から作らせる
  raider: { login: 'yamada_hanako', viewers: 30 },
  narration: true,
}

/** 当別町の紹介 */
const tobetsuIntro = {
  ...tobetsuCall,
  article: { title: '当別町', url: 'https://ja.wikipedia.org/wiki/%E5%BD%93%E5%88%A5%E7%94%BA' },
  tour: {
    hook: '北欧の街並みがある米どころ',
    points: [
      { label: '名物', text: '当別米とブロッコリーが名物です。' },
      { label: '北欧の街', text: '町内に北欧風の街並みがあります。' },
    ],
    cue: '北欧、行ってみたいですか？',
  },
  image: null,
  bond: null,
  bondFailure: null,
}

/** 当別町と、レイド元の山田花子さんの共通点 */
const tobetsuBond = {
  raiderName: '山田花子',
  raiderIcon: 'https://static-cdn.jtvnw.net/yamada.png',
  raiderQuote: '花子',
  townQuote: 'ブロッコリー',
  text: '花子さんとブロッコリー。どちらも「花」を食べさせる側の存在なのです。',
  certificateReason: '本町のブロッコリーと同じく花を背負われた功績につき',
}

/** 当別町の代表画像（作者とライセンス付き） */
const tobetsuImage = {
  url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tobetsu_Sweden_Hills.jpg/1280px-Tobetsu_Sweden_Hills.jpg',
  artist: '当別の写真家',
  license: 'CC BY-SA 4.0',
  caption: 'スウェーデンヒルズの家並み',
}

describe('parseTownTourMessage', () => {
  it('押し出された文字列を、市町村と冒頭の一文と鳴らす音として読む', () => {
    expect(parseTownTourMessage(JSON.stringify(tobetsuCall))).toEqual({ type: 'call', call: tobetsuCall })
  })

  it('type: answer を持つ文字列は、クイズの最初の正解者として読む', () => {
    expect(parseTownTourMessage(JSON.stringify({ type: 'answer', quizId: 'quiz-tobetsu', userName: 'たなか' }))).toEqual({
      type: 'answer',
      quizId: 'quiz-tobetsu',
      userName: 'たなか',
    })
  })

  it('正解者の名前が欠けていれば、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ type: 'answer', quizId: 'quiz-tobetsu' }))).toThrow('正解者')
  })

  it('クイズの出題の識別子か、都道府県を伏せた一文が欠けた呼び出しは、補わずに投げる', () => {
    const withoutQuizHeadline = { ...tobetsuCall, quizHeadline: undefined }

    expect(() => parseTownTourMessage(JSON.stringify(withoutQuizHeadline))).toThrow('市町村紹介')
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseTownTourMessage('当別町')).toThrow('JSON')
  })

  it('冒頭の一文が欠けていれば、補わずに投げる', () => {
    const withoutHeadline = { code: tobetsuCall.code, prefecture: tobetsuCall.prefecture, county: tobetsuCall.county, name: tobetsuCall.name }

    expect(() => parseTownTourMessage(JSON.stringify(withoutHeadline))).toThrow('市町村紹介')
  })

  it('鳴らす音の設定が欠けていれば、無音で流さずに投げる', () => {
    const withoutSound = { ...tobetsuCall, sound: undefined }

    expect(() => parseTownTourMessage(JSON.stringify(withoutSound))).toThrow('音の設定')
  })

  it('人口の記録が無い村（北方領土）と、見ている人数が分からない（配信中でない）呼び出しも読む', () => {
    const shikotanCall = { ...tobetsuCall, code: '01695', county: '色丹郡', name: '色丹村', population: null, area: 250.57, audience: null }

    expect(parseTownTourMessage(JSON.stringify(shikotanCall))).toEqual({ type: 'call', call: shikotanCall })
  })

  it('面積が欠けていれば、補わずに投げる', () => {
    const withoutArea = { ...tobetsuCall, area: undefined }

    expect(() => parseTownTourMessage(JSON.stringify(withoutArea))).toThrow('人口と面積')
  })

  it('人口が数でも null でもなければ、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, population: '14974人' }))).toThrow('人口と面積')
  })

  it('見ている人数の形が違えば、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, audience: { kind: 'raid' } }))).toThrow('見ている人数')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, audience: { kind: 'host', count: 50 } }))).toThrow('見ている人数')
  })

  it('試し再生の呼び出し（記録するきっかけが null）も読む', () => {
    const demoCall = { ...tobetsuCall, visit: null }

    expect(parseTownTourMessage(JSON.stringify(demoCall))).toEqual({ type: 'call', call: demoCall })
  })

  it('これまでに紹介した市町村が欠けているか、コードの並びでなければ、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, visited: undefined }))).toThrow('紹介した市町村')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, visited: [1100] }))).toThrow('紹介した市町村')
  })

  it('記録するきっかけの形が違えば、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, visit: undefined }))).toThrow('記録するきっかけ')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, visit: { occasion: 'demo', userName: '山田花子' } }))).toThrow('記録するきっかけ')
  })
})

describe('parseTownTourMessage（名誉町民にする相手）', () => {
  it('認定証を出さない呼び出し（名誉町民にする相手が null）も読む', () => {
    const keywordCall = { ...tobetsuCall, honoraryCitizen: null }

    expect(parseTownTourMessage(JSON.stringify(keywordCall))).toEqual({ type: 'call', call: keywordCall })
  })

  it('名誉町民にする相手が欠けているか、文字列でなければ、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, honoraryCitizen: undefined }))).toThrow('名誉町民')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, honoraryCitizen: 1 }))).toThrow('名誉町民')
  })

  it('共通点を作らせない呼び出し（レイド元が null）も読む（issue #275）', () => {
    const demoCall = { ...tobetsuCall, raider: null }

    expect(parseTownTourMessage(JSON.stringify(demoCall))).toEqual({ type: 'call', call: demoCall })
  })

  it('レイド元が欠けているか、ログイン名か人数の形が違えば、補わずに投げる', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, raider: undefined }))).toThrow('レイド元')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, raider: { login: 'yamada_hanako', viewers: '30' } }))).toThrow('レイド元')
  })

  it('ナレーションを読み上げるかが欠けているか、真偽値でなければ、補わずに投げる（issue #255）', () => {
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, narration: undefined }))).toThrow('ナレーション')
    expect(() => parseTownTourMessage(JSON.stringify({ ...tobetsuCall, narration: 'はい' }))).toThrow('ナレーション')
  })
})

describe('readTownTourIntro', () => {
  it('Worker の応答を、記事名・出典の URL と、大見出し・項目・振りの紹介として読む', () => {
    expect(readTownTourIntro(tobetsuIntro)).toEqual({
      article: tobetsuIntro.article,
      tour: tobetsuIntro.tour,
      image: null,
      bond: null,
      bondFailure: null,
    })
  })

  it('共通点があれば、レイド元の名前・アイコン・両側の語句・共通点・任命理由も読む（issue #275）', () => {
    expect(readTownTourIntro({ ...tobetsuIntro, bond: tobetsuBond }).bond).toEqual(tobetsuBond)
  })

  it('共通点を作れなかった理由があれば読む（合成ページが素材の箱に出す）', () => {
    expect(readTownTourIntro({ ...tobetsuIntro, bondFailure: '共通点を作れませんでした: 材料に無い語句です' }).bondFailure).toBe(
      '共通点を作れませんでした: 材料に無い語句です',
    )
  })

  it('共通点の欄が無い・任命理由が欠けていれば、補わずに投げる', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, bond: undefined })).toThrow('共通点')
    expect(() => readTownTourIntro({ ...tobetsuIntro, bond: { ...tobetsuBond, certificateReason: undefined } })).toThrow('共通点')
    expect(() => readTownTourIntro({ ...tobetsuIntro, bondFailure: undefined })).toThrow('共通点')
  })

  it('代表画像があれば、画像の URL・作者・ライセンス・写真の説明も読む（issue #254）', () => {
    expect(readTownTourIntro({ ...tobetsuIntro, image: tobetsuImage }).image).toEqual(tobetsuImage)
  })

  it('代表画像の欄が無い・ライセンスが欠けていれば、補わずに投げる（作者とライセンスを出さずに画像を出さないため）', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, image: undefined })).toThrow('画像')
    expect(() => readTownTourIntro({ ...tobetsuIntro, image: { ...tobetsuImage, license: undefined } })).toThrow('画像')
  })

  it('写真の説明の欄が無ければ投げる。空文字は説明なしとして読む', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, image: { ...tobetsuImage, caption: undefined } })).toThrow('画像')
    expect(readTownTourIntro({ ...tobetsuIntro, image: { ...tobetsuImage, caption: '' } }).image?.caption).toBe('')
  })

  it('大見出しが空の紹介（材料が薄い町）も読む', () => {
    expect(readTownTourIntro({ ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }).tour.hook).toBe('')
  })

  it('振りが欠けていれば、補わずに投げる', () => {
    const { hook, points } = tobetsuIntro.tour

    expect(() => readTownTourIntro({ ...tobetsuIntro, tour: { hook, points } })).toThrow('紹介')
  })

  it('項目が無い・項目の見出しか文が欠けていれば、補わずに投げる', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, tour: { ...tobetsuIntro.tour, points: [] } })).toThrow('紹介')
    expect(() => readTownTourIntro({ ...tobetsuIntro, tour: { ...tobetsuIntro.tour, points: [{ label: '名物' }] } })).toThrow('紹介')
  })

  it('出典の記事名が無ければ、補わずに投げる（出典を出さずに Wikipedia の文を流さないため）', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, article: { url: tobetsuIntro.article.url } })).toThrow('出典')
  })
})

describe('tourLinesOf', () => {
  it('大見出し・項目・振りの順に、場面の種類と見出しを付けて並べる（大見出しの見出しは市町村の種類に合わせる）', () => {
    expect(tourLinesOf(tobetsuIntro, '当別町')).toEqual([
      { kind: 'hook', label: 'この町、実は…', text: '北欧の街並みがある米どころ' },
      { kind: 'point', label: '名物', text: '当別米とブロッコリーが名物です。' },
      { kind: 'point', label: '北欧の街', text: '町内に北欧風の街並みがあります。' },
      { kind: 'cue', label: 'ところで…', text: '北欧、行ってみたいですか？' },
    ])
    expect(tourLinesOf(tobetsuIntro, '府中市')[0]?.label).toBe('この市、実は…')
  })

  it('大見出しが空なら、大見出しの場面を飛ばす', () => {
    expect(tourLinesOf({ ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }, '当別町').map((line) => line.kind)).toEqual(['point', 'point', 'cue'])
  })

  it('共通点があれば、振りの場面を「○○さんとこの町、実は…」の共通点の場面に置き換える（issue #275）', () => {
    expect(tourLinesOf({ ...tobetsuIntro, bond: tobetsuBond }, '当別町').at(-1)).toEqual({
      kind: 'bond',
      label: '山田花子さんとこの町、実は…',
      text: '花子さんとブロッコリー。どちらも「花」を食べさせる側の存在なのです。',
      raiderQuote: '花子',
      townQuote: 'ブロッコリー',
    })
    expect(tourLinesOf({ ...tobetsuIntro, bond: tobetsuBond }, '当別町').map((line) => line.kind)).toEqual(['hook', 'point', 'point', 'bond'])
  })
})
