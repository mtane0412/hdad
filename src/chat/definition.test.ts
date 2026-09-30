/**
 * チャットボックスの定義（definition.ts, bubble.ts）のテスト
 *
 * 共通パラメータから「本番の接続先」か「サンプル表示」かを決める部分と、
 * デザインのパラメータがCSSのカスタムプロパティへ正しく変換されることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { ParamError, parseParams } from '../core/params'
import { bubble } from './bubble'
import { sourceOf } from './definition'

const parse = (query: string) => parseParams(bubble.schema, new URLSearchParams(query))

describe('sourceOf', () => {
  it('何も指定しなければ、配信者のチャンネルへ接続する（接続先はWorkerから受け取る）', () => {
    expect(sourceOf(parse(''))).toEqual({ type: 'live' })
  })

  it('demo=true なら、サンプル表示にする', () => {
    expect(sourceOf(parse('demo=true'))).toEqual({ type: 'demo' })
  })

  it('channel は受け付けない（このWorkerが扱う配信者のチャンネルに固定するため）', () => {
    expect(() => parse('channel=tanenob_ch')).toThrow(ParamError)
    expect(() => parse('channel=tanenob_ch')).toThrow('未対応のパラメータです')
  })
})

describe('bubble.cssVariables', () => {
  it('既定値のとき、文字の大きさと配色をCSSのカスタムプロパティにする', () => {
    expect(bubble.cssVariables(parse('demo=true'))).toEqual({
      '--chat-size': '28px',
      '--chat-panel': '#fffffff2',
      '--chat-text': '#2b2433',
    })
  })

  it('ふきだしの色には、不透明度を反映する', () => {
    expect(bubble.cssVariables(parse('demo=true&panel=000000&opacity=0.5'))['--chat-panel']).toBe('#00000080')
  })

  it('ふきだしを透過にした場合は、不透明度によらず透過のままにする', () => {
    expect(bubble.cssVariables(parse('demo=true&panel=transparent'))['--chat-panel']).toBe('transparent')
  })
})
