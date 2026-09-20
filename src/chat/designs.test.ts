/**
 * チャットボックスの各デザイン（card.ts, plain.ts, sticker.ts, terminal.ts）と、共通の色変換（panelColor）のテスト
 *
 * デザインのパラメータがCSSのカスタムプロパティへ正しく変換されることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { card } from './card'
import { panelColor } from './definition'
import { plain } from './plain'
import { sticker } from './sticker'
import { terminal } from './terminal'

describe('panelColor', () => {
  it('地の色に不透明度を反映する', () => {
    expect(panelColor('#000000', 0.5)).toBe('#00000080')
  })

  it('透過にした場合は、不透明度によらず透過のままにする', () => {
    expect(panelColor('transparent', 0.5)).toBe('transparent')
  })
})

describe('plain.cssVariables', () => {
  const 解析する = (query: string) => parseParams(plain.schema, new URLSearchParams(query))

  it('既定値のとき、白い文字と暗いフチにする', () => {
    expect(plain.cssVariables(解析する('demo=true'))).toEqual({
      '--chat-size': '28px',
      '--chat-text': '#ffffff',
      '--chat-outline': '#1e1826',
    })
  })

  it('文字の色とフチの色を変えられる', () => {
    expect(plain.cssVariables(解析する('demo=true&text=ffe066&outline=000000'))).toMatchObject({
      '--chat-text': '#ffe066',
      '--chat-outline': '#000000',
    })
  })
})

describe('card.cssVariables', () => {
  const 解析する = (query: string) => parseParams(card.schema, new URLSearchParams(query))

  it('既定値のとき、半透明の暗いカードと白い文字にする', () => {
    expect(card.cssVariables(解析する('demo=true'))).toEqual({
      '--chat-size': '26px',
      '--chat-panel': '#1e1826d9',
      '--chat-text': '#ffffff',
    })
  })

  it('カードの色には、不透明度を反映する', () => {
    expect(card.cssVariables(解析する('demo=true&panel=ffffff&opacity=0.5'))['--chat-panel']).toBe('#ffffff80')
  })
})

describe('sticker.cssVariables', () => {
  const 解析する = (query: string) => parseParams(sticker.schema, new URLSearchParams(query))

  it('既定値のとき、淡いピンクのシールに白いフチを付ける', () => {
    expect(sticker.cssVariables(解析する('demo=true'))).toEqual({
      '--chat-size': '28px',
      '--chat-panel': '#fff1f6',
      '--chat-border': '#ffffff',
      '--chat-text': '#4a3340',
    })
  })

  it('シールの色とフチの色を変えられる', () => {
    expect(sticker.cssVariables(解析する('demo=true&panel=e8f7ff&border=2b2433'))).toMatchObject({
      '--chat-panel': '#e8f7ff',
      '--chat-border': '#2b2433',
    })
  })
})

describe('terminal.cssVariables', () => {
  const 解析する = (query: string) => parseParams(terminal.schema, new URLSearchParams(query))

  it('既定値のとき、半透明の黒い画面と緑がかった文字にする', () => {
    expect(terminal.cssVariables(解析する('demo=true'))).toEqual({
      '--chat-size': '24px',
      '--chat-panel': '#0c0f12d9',
      '--chat-text': '#c8f7c5',
    })
  })

  it('画面を透過にした場合は、不透明度によらず透過のままにする', () => {
    expect(terminal.cssVariables(解析する('demo=true&panel=transparent'))['--chat-panel']).toBe('transparent')
  })
})
