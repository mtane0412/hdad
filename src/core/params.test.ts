/**
 * URLクエリパラメータ解析（params.ts）のテスト
 *
 * 配信背景はOBSのブラウザソースにURLを貼って使うため、
 * 「省略時は既定値」「不正な指定は黙って既定値に戻さずエラーにする」ことを確認する。
 */
import { describe, expect, it } from 'vitest'
import { ParamError, parseParams, type ParamSchema } from './params'

const 背景スキーマ = {
  speed: { type: 'number', default: 1, min: 0, max: 5, description: '動きの速さ' },
  count: { type: 'number', integer: true, default: 80, min: 1, max: 500, description: '粒の数' },
  bg: { type: 'color', default: '#101820', allowTransparent: true, description: '背景色' },
  colors: {
    type: 'colors',
    default: ['#ff0080', '#7928ca'],
    minCount: 2,
    maxCount: 4,
    description: '配色',
  },
  seconds: { type: 'boolean', default: true, description: '秒を表示するか' },
} as const satisfies ParamSchema

/** クエリ文字列からスキーマに沿って解析するテスト用ヘルパー */
const 解析する = (query: string) => parseParams(背景スキーマ, new URLSearchParams(query))

/** 解析が失敗したときの問題点一覧を取り出すテスト用ヘルパー */
const 問題点を取得する = (query: string): readonly string[] => {
  try {
    解析する(query)
  } catch (error) {
    if (error instanceof ParamError) return error.problems
    throw error
  }
  throw new Error(`「${query}」はエラーになるはずですが、解析に成功しました`)
}

describe('parseParams', () => {
  it('パラメータを省略すると、すべて既定値になる', () => {
    expect(解析する('')).toEqual({
      speed: 1,
      count: 80,
      bg: '#101820',
      colors: ['#ff0080', '#7928ca'],
      seconds: true,
    })
  })

  it('真偽値パラメータは true / false で指定できる', () => {
    expect(解析する('seconds=false').seconds).toBe(false)
    expect(解析する('seconds=true').seconds).toBe(true)
  })

  it('true / false 以外の真偽値は、1 や yes のような別表記も含めてエラーになる', () => {
    expect(問題点を取得する('seconds=1')).toEqual([
      'seconds: 「1」は真偽値として読めません（true または false）',
    ])
  })

  it('数値パラメータを指定すると、その値が使われる', () => {
    expect(解析する('speed=0.5&count=200')).toMatchObject({ speed: 0.5, count: 200 })
  })

  it('色は「#」なしの16進数で指定し、「#」付きの小文字6桁に正規化される', () => {
    expect(解析する('bg=FFF').bg).toBe('#ffffff')
    expect(解析する('bg=1A2b3C').bg).toBe('#1a2b3c')
  })

  it('透過を許可した色パラメータには transparent を指定できる', () => {
    expect(解析する('bg=transparent').bg).toBe('transparent')
  })

  it('配色はカンマ区切りで複数の色を指定できる', () => {
    expect(解析する('colors=f00,00ff00,00f').colors).toEqual(['#ff0000', '#00ff00', '#0000ff'])
  })

  it('数値として読めない値はエラーになる', () => {
    expect(問題点を取得する('speed=はやい')).toEqual([
      'speed: 「はやい」は数値ではありません',
    ])
  })

  it('空文字の数値はエラーになる（0として扱わない）', () => {
    expect(問題点を取得する('speed=')).toEqual(['speed: 「」は数値ではありません'])
  })

  it('範囲外の数値は、範囲内に丸めずエラーになる', () => {
    expect(問題点を取得する('speed=9')).toEqual(['speed: 9 は範囲外です（0〜5）'])
  })

  it('整数パラメータに小数を指定するとエラーになる', () => {
    expect(問題点を取得する('count=1.5')).toEqual(['count: 1.5 は整数ではありません'])
  })

  it('色として読めない値はエラーになる', () => {
    expect(問題点を取得する('bg=red')).toEqual([
      'bg: 「red」は色として読めません（例: ff0080, f08, transparent）',
    ])
  })

  it('透過を許可していない配色に transparent を指定するとエラーになる', () => {
    expect(問題点を取得する('colors=f00,transparent')).toEqual([
      'colors: 「transparent」は色として読めません（例: ff0080, f08）',
    ])
  })

  it('配色の数が範囲外だとエラーになる', () => {
    expect(問題点を取得する('colors=f00')).toEqual(['colors: 色の数は 2〜4 個で指定してください（1 個でした）'])
  })

  it('スキーマにないパラメータ名は、打ち間違いに気づけるようエラーになる', () => {
    expect(問題点を取得する('sped=2')).toEqual([
      'sped: 未対応のパラメータです（使用可能: speed, count, bg, colors, seconds）',
    ])
  })

  it('同じパラメータを複数回指定するとエラーになる', () => {
    expect(問題点を取得する('speed=1&speed=2')).toEqual(['speed: 複数回指定されています'])
  })

  it('問題が複数あるときは、すべてまとめて報告する', () => {
    expect(問題点を取得する('speed=9&bg=red')).toHaveLength(2)
  })

  describe('文字列パラメータ', () => {
    // 前提: Twitchのチャンネル名は英数字とアンダースコアだけで構成される
    const チャットスキーマ = {
      channel: {
        type: 'string',
        default: '',
        pattern: /^[a-z0-9_]{1,25}$/i,
        example: 'your_channel',
        description: 'チャンネル名',
      },
    } as const satisfies ParamSchema

    it('書式に合う文字列は、そのまま受け取る', () => {
      expect(parseParams(チャットスキーマ, new URLSearchParams('channel=tanenob_ch'))).toEqual({
        channel: 'tanenob_ch',
      })
    })

    it('省略すると既定値になる', () => {
      expect(parseParams(チャットスキーマ, new URLSearchParams(''))).toEqual({ channel: '' })
    })

    it('書式に合わない文字列は、例を添えてエラーにする', () => {
      expect(() => parseParams(チャットスキーマ, new URLSearchParams('channel=だめな名前'))).toThrow(
        'channel: 「だめな名前」は書式に合いません（例: your_channel）',
      )
    })
  })
})
