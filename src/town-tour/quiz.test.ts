/**
 * 都道府県当てクイズ（quiz.ts）のテスト
 *
 * - チャットの発言から、答えた都道府県を1つだけ読み取る（表記ゆれ・「東京都」の中の「京都」・2つ以上を挙げた発言）
 * - 市町村のコードの上2桁から都道府県を引く
 * - ヒント（都道府県の市町村の数 → 地方 → 隣り合う都道府県）の文を作る
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { answeredPrefectureOf, prefectureOfCode, quizClueOf, quizHintsOf } from './quiz'
import { decodeTownBorders } from './topo'
import towns from './towns.json'

describe('answeredPrefectureOf', () => {
  it('都道府県の名前をそのまま書いた発言は、その都道府県の回答とみなす', () => {
    expect(answeredPrefectureOf('北海道')).toBe('北海道')
    expect(answeredPrefectureOf('京都府')).toBe('京都府')
    expect(answeredPrefectureOf('青森県かな？')).toBe('青森県')
  })

  it('「都・府・県」を省いた書き方も、その都道府県の回答とみなす', () => {
    expect(answeredPrefectureOf('京都')).toBe('京都府')
    expect(answeredPrefectureOf('たぶん東京')).toBe('東京都')
    expect(answeredPrefectureOf('答えは鹿児島！')).toBe('鹿児島県')
  })

  it('省いた書き方のすぐ後に普通の言葉が続く発言は、回答とみなさない（「大分むずかしい」の「大分」は大分県ではない）', () => {
    expect(answeredPrefectureOf('大分むずかしい')).toBeNull()
    expect(answeredPrefectureOf('山形に見える')).toBeNull()
  })

  it('省いた書き方のあとに「かな」「？」などの答える言い方が続く発言は、回答とみなす', () => {
    expect(answeredPrefectureOf('大分かな？')).toBe('大分県')
    expect(answeredPrefectureOf('山形！')).toBe('山形県')
  })

  it('「東京都」の中の「京都」は京都府と読まない', () => {
    expect(answeredPrefectureOf('東京都だと思う')).toBe('東京都')
  })

  it('2つ以上の都道府県を挙げた発言は、回答とみなさない（数打てば当たるのを防ぐ）', () => {
    expect(answeredPrefectureOf('岩手か宮城')).toBeNull()
  })

  it('同じ都道府県を書き方を変えて2度書いても、1つの回答とみなす', () => {
    expect(answeredPrefectureOf('京都！京都府！')).toBe('京都府')
  })

  it('都道府県の名前が無い発言は、回答とみなさない', () => {
    expect(answeredPrefectureOf('こんばんは、レイドから来ました')).toBeNull()
  })
})

describe('prefectureOfCode', () => {
  it('市町村のコードの上2桁から都道府県を引く', () => {
    expect(prefectureOfCode('01303')).toBe('北海道')
    expect(prefectureOfCode('13101')).toBe('東京都')
    expect(prefectureOfCode('47201')).toBe('沖縄県')
  })

  it('一覧のすべての市町村で、一覧の都道府県と同じ名前を返す（Worker は一覧の名前を正解にし、回答はここの名前で読むため）', () => {
    expect(towns.filter((town) => prefectureOfCode(town.code) !== town.prefecture)).toEqual([])
  })

  it('上2桁が都道府県の番号でなければ投げる', () => {
    expect(() => prefectureOfCode('48001')).toThrow('48001')
  })
})

describe('quizHintsOf', () => {
  it('都道府県の市町村の数 → 地方 → 隣り合う都道府県 の順にヒントを並べる（どれも答えの都道府県についてのヒント）', () => {
    expect(quizHintsOf({ prefecture: '埼玉県', townCount: 63, neighbors: ['群馬県', '東京都'] })).toEqual([
      '市町村の数: 63',
      '関東地方にあります',
      '隣り合う都道府県: 群馬県・東京都',
    ])
  })

  it('沖縄県は九州・沖縄地方、北海道は北海道地方とする', () => {
    expect(quizHintsOf({ prefecture: '沖縄県', townCount: 41, neighbors: [] })[1]).toBe('九州・沖縄地方にあります')
    expect(quizHintsOf({ prefecture: '北海道', townCount: 185, neighbors: [] })[1]).toBe('北海道地方にあります')
  })

  it('陸で接する都道府県が無ければ、その旨を出す', () => {
    expect(quizHintsOf({ prefecture: '沖縄県', townCount: 41, neighbors: [] })[2]).toBe('陸で接する都道府県はありません')
  })
})

describe('quizClueOf', () => {
  /** 同梱の日本地図から求めた、隣り合う市町村 */
  const borders = decodeTownBorders(JSON.parse(readFileSync(new URL('../../public/town-tour/japan.topo.json', import.meta.url), 'utf8')))

  it('埼玉県秩父市なら、埼玉県の市町村の数と、埼玉県と陸で接する7都県をコードの順に挙げる', () => {
    expect(quizClueOf('11207', borders)).toEqual({
      prefecture: '埼玉県',
      townCount: 63,
      neighbors: ['茨城県', '栃木県', '群馬県', '千葉県', '東京都', '山梨県', '長野県'],
    })
  })

  it('宮崎県の内陸の町（高千穂町）でも、町ではなく宮崎県についてのヒントを出す', () => {
    expect(quizClueOf('45441', borders)).toEqual({ prefecture: '宮崎県', townCount: 26, neighbors: ['熊本県', '大分県', '鹿児島県'] })
  })

  it('沖縄県那覇市なら、沖縄県の市町村の数を挙げ、陸で接する都道府県は無い', () => {
    expect(quizClueOf('47201', borders)).toEqual({ prefecture: '沖縄県', townCount: 41, neighbors: [] })
  })
})
