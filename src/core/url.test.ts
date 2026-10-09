/**
 * 素材のパラメータの直列化（url.ts）のテスト
 *
 * 直列化した文字列は合成ページが URLSearchParams として読み戻すので、往復して元の値に戻ることまで確かめる。
 */
import { describe, expect, it } from 'vitest'
import { parseParams, type ParamSchema } from './params'
import { serializeParams } from './url'

const backgroundSchema = {
  speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ' },
  bg: { type: 'color', default: '#101820', allowTransparent: true, description: '背景色' },
  colors: { type: 'colors', default: ['#ff0080', '#7928ca'], minCount: 2, maxCount: 4, description: '配色' },
} as const satisfies ParamSchema

const defaults = { speed: 1, bg: '#101820', colors: ['#ff0080', '#7928ca'] }

describe('serializeParams', () => {
  it('既定値から変えたパラメータだけをクエリ文字列にする（先頭に ? は付けない）', () => {
    expect(serializeParams(backgroundSchema, { ...defaults, speed: 0.5 })).toBe('speed=0.5')
  })

  it('すべて既定値なら空文字にする（合成オーバーレイの構成に何も持たせない）', () => {
    expect(serializeParams(backgroundSchema, defaults)).toBe('')
  })

  it('複数のパラメータは & でつなぐ', () => {
    expect(serializeParams(backgroundSchema, { ...defaults, speed: 2, colors: ['#ffffff'] })).toBe('speed=2&colors=ffffff')
  })

  it('色は「#」を外して出力する（「#」以降はURLのフラグメント扱いになるため）', () => {
    const serialized = serializeParams(backgroundSchema, {
      ...defaults,
      bg: 'transparent',
      colors: ['#00ff00', '#0000ff', '#ffffff'],
    })

    expect(serialized).toBe('bg=transparent&colors=00ff00,0000ff,ffffff')
  })

  it('真偽値は true / false の文字で出力し、読み戻すと元の値になる', () => {
    // 前提: 秒の表示は既定で有効。これを無効に変えた場合だけ出力される
    const clockSchema = {
      seconds: { type: 'boolean', default: true, description: '秒を表示するか' },
    } as const satisfies ParamSchema

    const serialized = serializeParams(clockSchema, { seconds: false })

    expect(serialized).toBe('seconds=false')
    expect(parseParams(clockSchema, new URLSearchParams(serialized))).toEqual({ seconds: false })
  })

  it('文字列はURLエンコードして出力し、読み戻すと元の値になる', () => {
    const chatSchema = {
      channel: { type: 'string', default: '', pattern: /^.{1,25}$/, example: 'your_channel', description: 'チャンネル名' },
    } as const satisfies ParamSchema

    const serialized = serializeParams(chatSchema, { channel: 'a&b=c' })

    expect(serialized).toBe('channel=a%26b%3Dc')
    expect(parseParams(chatSchema, new URLSearchParams(serialized))).toEqual({ channel: 'a&b=c' })
  })

  it('選択肢は値をそのまま出力し、読み戻すと元の値になる', () => {
    const frameSchema = {
      frame: { type: 'choice', default: 'board', choices: [{ value: 'board', label: '板' }, { value: 'sticky', label: '付箋' }], description: '枠' },
    } as const satisfies ParamSchema

    const serialized = serializeParams(frameSchema, { frame: 'sticky' })

    expect(serialized).toBe('frame=sticky')
    expect(parseParams(frameSchema, new URLSearchParams(serialized))).toEqual({ frame: 'sticky' })
  })

  it('組み立てたクエリ文字列は、同じスキーマで元の値に読み戻せる', () => {
    const value = { speed: 2.5, bg: 'transparent', colors: ['#111111', '#222222'] }

    expect(parseParams(backgroundSchema, new URLSearchParams(serializeParams(backgroundSchema, value)))).toEqual(value)
  })
})
