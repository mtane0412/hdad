/**
 * 素材のパラメータの直列化（url.ts）のテスト
 *
 * 直列化した文字列は合成ページが URLSearchParams として読み戻すので、往復して元の値に戻ることまで確かめる。
 */
import { describe, expect, it } from 'vitest'
import { parseParams, type ParamSchema } from './params'
import { serializeParams } from './url'

const 背景スキーマ = {
  speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ' },
  bg: { type: 'color', default: '#101820', allowTransparent: true, description: '背景色' },
  colors: { type: 'colors', default: ['#ff0080', '#7928ca'], minCount: 2, maxCount: 4, description: '配色' },
} as const satisfies ParamSchema

const 既定値 = { speed: 1, bg: '#101820', colors: ['#ff0080', '#7928ca'] }

describe('serializeParams', () => {
  it('既定値から変えたパラメータだけをクエリ文字列にする（先頭に ? は付けない）', () => {
    expect(serializeParams(背景スキーマ, { ...既定値, speed: 0.5 })).toBe('speed=0.5')
  })

  it('すべて既定値なら空文字にする（合成オーバーレイの構成に何も持たせない）', () => {
    expect(serializeParams(背景スキーマ, 既定値)).toBe('')
  })

  it('複数のパラメータは & でつなぐ', () => {
    expect(serializeParams(背景スキーマ, { ...既定値, speed: 2, colors: ['#ffffff'] })).toBe('speed=2&colors=ffffff')
  })

  it('色は「#」を外して出力する（「#」以降はURLのフラグメント扱いになるため）', () => {
    const 直列化した文字列 = serializeParams(背景スキーマ, {
      ...既定値,
      bg: 'transparent',
      colors: ['#00ff00', '#0000ff', '#ffffff'],
    })

    expect(直列化した文字列).toBe('bg=transparent&colors=00ff00,0000ff,ffffff')
  })

  it('真偽値は true / false の文字で出力し、読み戻すと元の値になる', () => {
    // 前提: 秒の表示は既定で有効。これを無効に変えた場合だけ出力される
    const 時計スキーマ = {
      seconds: { type: 'boolean', default: true, description: '秒を表示するか' },
    } as const satisfies ParamSchema

    const 直列化した文字列 = serializeParams(時計スキーマ, { seconds: false })

    expect(直列化した文字列).toBe('seconds=false')
    expect(parseParams(時計スキーマ, new URLSearchParams(直列化した文字列))).toEqual({ seconds: false })
  })

  it('文字列はURLエンコードして出力し、読み戻すと元の値になる', () => {
    const チャットスキーマ = {
      channel: { type: 'string', default: '', pattern: /^.{1,25}$/, example: 'your_channel', description: 'チャンネル名' },
    } as const satisfies ParamSchema

    const 直列化した文字列 = serializeParams(チャットスキーマ, { channel: 'a&b=c' })

    expect(直列化した文字列).toBe('channel=a%26b%3Dc')
    expect(parseParams(チャットスキーマ, new URLSearchParams(直列化した文字列))).toEqual({ channel: 'a&b=c' })
  })

  it('組み立てたクエリ文字列は、同じスキーマで元の値に読み戻せる', () => {
    const 値 = { speed: 2.5, bg: 'transparent', colors: ['#111111', '#222222'] }

    expect(parseParams(背景スキーマ, new URLSearchParams(serializeParams(背景スキーマ, 値)))).toEqual(値)
  })
})
