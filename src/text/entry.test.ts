/**
 * テキストの形と、映すテキストの選び方（entry.ts）のテスト
 *
 * 次の点を確かめる。
 * - Worker の応答（読み出しと押し出しで同じ形）をテキストの一覧として読み、形が違えば投げること
 * - 素材のパラメータ（テキストのID）から映すテキストを引き、選ばれていない・消されたときは黙って空にせず投げること
 */
import { describe, expect, it } from 'vitest'
import { parseTextsMessage, readTextList, textToShow, type TextEntry } from './entry'

const goal: TextEntry = { id: 1, name: '目標', body: 'ログイン画面を作り終える', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:00:00.000Z' }
const doing: TextEntry = { id: 3, name: '今やってること', body: 'テストを書いている', mode: 'manual', instruction: '', writtenBy: 'human', updatedAt: '2026-10-08T12:10:00.000Z' }

describe('readTextList', () => {
  it('応答の texts をテキストの一覧として読む', () => {
    expect(readTextList({ texts: [goal, doing] })).toEqual([goal, doing])
  })

  it('形が違えば投げる', () => {
    expect(() => readTextList({ texts: [{ ...goal, id: '1' }] })).toThrow('texts[0]')
    expect(() => readTextList({})).toThrow('texts')
  })

  it('手動・自動の別や本文を書いた人が想定と違えば投げる', () => {
    expect(() => readTextList({ texts: [{ ...goal, mode: 'semi' }] })).toThrow('texts[0]')
    expect(() => readTextList({ texts: [{ ...goal, writtenBy: 'robot' }] })).toThrow('texts[0]')
    expect(() => readTextList({ texts: [{ ...goal, instruction: null }] })).toThrow('texts[0]')
  })

  it('自動で LLM が書いたテキストも読む', () => {
    const autoDoing: TextEntry = { ...doing, mode: 'auto', instruction: 'いまやっている作業を20字で', writtenBy: 'llm' }
    expect(readTextList({ texts: [autoDoing] })).toEqual([autoDoing])
  })
})

describe('parseTextsMessage', () => {
  it('押し出された文字列をテキストの一覧として読む', () => {
    expect(parseTextsMessage(JSON.stringify({ texts: [goal] }))).toEqual([goal])
  })
})

describe('textToShow', () => {
  it('パラメータのIDのテキストを返す', () => {
    expect(textToShow([goal, doing], '3')).toEqual(doing)
  })

  it('テキストが選ばれていなければ投げる', () => {
    expect(() => textToShow([goal], '')).toThrow('選ばれていません')
  })

  it('選んだテキストが消されていたら、空にせず投げる', () => {
    expect(() => textToShow([goal], '3')).toThrow('見つかりません')
  })
})
