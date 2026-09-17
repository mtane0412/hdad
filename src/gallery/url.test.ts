/**
 * OBSに貼る背景URLの組み立て（url.ts）のテスト
 */
import { describe, expect, it } from 'vitest'
import { parseParams, type ParamSchema } from '../core/params'
import { buildBackgroundUrl } from './url'

const ギャラリーのURL = 'https://example.github.io/stream-assets/'

const 背景スキーマ = {
  speed: { type: 'number', default: 1, min: 0, max: 10, description: '動きの速さ' },
  bg: { type: 'color', default: '#101820', allowTransparent: true, description: '背景色' },
  colors: { type: 'colors', default: ['#ff0080', '#7928ca'], minCount: 2, maxCount: 4, description: '配色' },
} as const satisfies ParamSchema

const 既定値 = { speed: 1, bg: '#101820', colors: ['#ff0080', '#7928ca'] }

describe('buildBackgroundUrl', () => {
  it('すべて既定値なら、パラメータなしの短いURLになる', () => {
    expect(buildBackgroundUrl(ギャラリーのURL, 'aurora', 背景スキーマ, 既定値)).toBe(
      'https://example.github.io/stream-assets/backgrounds/aurora/',
    )
  })

  it('既定値から変えたパラメータだけがURLに付く', () => {
    expect(buildBackgroundUrl(ギャラリーのURL, 'aurora', 背景スキーマ, { ...既定値, speed: 0.5 })).toBe(
      'https://example.github.io/stream-assets/backgrounds/aurora/?speed=0.5',
    )
  })

  it('色は「#」を外して出力する（「#」以降はURLのフラグメント扱いになるため）', () => {
    const url = buildBackgroundUrl(ギャラリーのURL, 'aurora', 背景スキーマ, {
      ...既定値,
      bg: 'transparent',
      colors: ['#00ff00', '#0000ff', '#ffffff'],
    })
    expect(url).toBe(
      'https://example.github.io/stream-assets/backgrounds/aurora/?bg=transparent&colors=00ff00,0000ff,ffffff',
    )
  })

  it('ギャラリーが index.html 付きのURLで開かれていても、同じ階層を基準にする', () => {
    expect(
      buildBackgroundUrl('https://example.github.io/stream-assets/index.html', 'motes', 背景スキーマ, 既定値),
    ).toBe('https://example.github.io/stream-assets/backgrounds/motes/')
  })

  it('組み立てたURLのパラメータは、背景側の解析で元の値に戻る', () => {
    const 値 = { speed: 2.5, bg: '#abcdef', colors: ['#111111', '#222222'] }
    const url = new URL(buildBackgroundUrl(ギャラリーのURL, 'aurora', 背景スキーマ, 値))
    expect(parseParams(背景スキーマ, url.searchParams)).toEqual(値)
  })
})
