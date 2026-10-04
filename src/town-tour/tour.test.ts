/**
 * 市町村紹介の呼び出し（押し出し）と紹介（API の応答）の読み取りのテスト
 *
 * どちらも Worker から届くものなので、想定した形でなければ補わずに投げることを確かめる（Fail-Fast）。
 */
import { describe, expect, it } from 'vitest'
import { parseTownTourCall, readTownTourIntro, tourItemsOf } from './tour'

/** レイドで引いた北海道当別町の呼び出し */
const tobetsuCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  // 音は BGM だけを選んである
  sound: {
    slots: { bgm: '/api/media/media-cookie?key=overlay-key', opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
}

/** 当別町の紹介（歴史は材料に無かったので空） */
const tobetsuIntro = {
  ...tobetsuCall,
  article: { title: '当別町', url: 'https://ja.wikipedia.org/wiki/%E5%BD%93%E5%88%A5%E7%94%BA' },
  tour: {
    location: '石狩平野の北東部にある町です。',
    nameOrigin: 'アイヌ語の「トペッ」に由来するとされます。',
    history: '',
    specialty: '当別米とブロッコリーが名物です。',
    surprise: '町内に北欧風の街並みがあります。',
  },
}

describe('parseTownTourCall', () => {
  it('押し出された文字列を、市町村と冒頭の一文と鳴らす音として読む', () => {
    expect(parseTownTourCall(JSON.stringify(tobetsuCall))).toEqual(tobetsuCall)
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseTownTourCall('当別町')).toThrow('JSON')
  })

  it('冒頭の一文が欠けていれば、補わずに投げる', () => {
    const withoutHeadline = { code: tobetsuCall.code, prefecture: tobetsuCall.prefecture, county: tobetsuCall.county, name: tobetsuCall.name }

    expect(() => parseTownTourCall(JSON.stringify(withoutHeadline))).toThrow('市町村紹介')
  })

  it('鳴らす音の設定が欠けていれば、無音で流さずに投げる', () => {
    const { code, prefecture, county, name, headline } = tobetsuCall
    const withoutSound = { code, prefecture, county, name, headline }

    expect(() => parseTownTourCall(JSON.stringify(withoutSound))).toThrow('音の設定')
  })
})

describe('readTownTourIntro', () => {
  it('Worker の応答を、記事名・出典の URL・5項目の紹介として読む', () => {
    expect(readTownTourIntro(tobetsuIntro)).toEqual({
      article: tobetsuIntro.article,
      tour: tobetsuIntro.tour,
    })
  })

  it('紹介の項目が欠けていれば、補わずに投げる', () => {
    const { location, nameOrigin, history, specialty } = tobetsuIntro.tour
    const fourItems = { location, nameOrigin, history, specialty }

    expect(() => readTownTourIntro({ ...tobetsuIntro, tour: fourItems })).toThrow('紹介')
  })

  it('出典の記事名が無ければ、補わずに投げる（出典を出さずに Wikipedia の文を流さないため）', () => {
    expect(() => readTownTourIntro({ ...tobetsuIntro, article: { url: tobetsuIntro.article.url } })).toThrow('出典')
  })
})

describe('tourItemsOf', () => {
  it('空でない項目だけを、決まった順に見出しを付けて並べる', () => {
    expect(tourItemsOf(tobetsuIntro.tour)).toEqual([
      { label: 'どこにある？', text: '石狩平野の北東部にある町です。' },
      { label: '名前の由来', text: 'アイヌ語の「トペッ」に由来するとされます。' },
      { label: '名物', text: '当別米とブロッコリーが名物です。' },
      { label: '意外な一面', text: '町内に北欧風の街並みがあります。' },
    ])
  })
})
