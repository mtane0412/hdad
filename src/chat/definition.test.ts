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

const 解析する = (query: string) => parseParams(bubble.schema, new URLSearchParams(query))

describe('sourceOf', () => {
  it('channel を指定すると、そのチャンネルへ接続する（チャンネル名は小文字にそろえる）', () => {
    expect(sourceOf(解析する('channel=Tanenob_CH'))).toEqual({ type: 'live', channel: 'tanenob_ch' })
  })

  it('demo=true なら、channel の有無によらずサンプル表示にする', () => {
    expect(sourceOf(解析する('demo=true'))).toEqual({ type: 'demo' })
    expect(sourceOf(解析する('demo=true&channel=tanenob_ch'))).toEqual({ type: 'demo' })
  })

  it('channel も demo もなければ、黙ってサンプル表示にはせずエラーにする', () => {
    expect(() => sourceOf(解析する(''))).toThrow(ParamError)
    expect(() => sourceOf(解析する(''))).toThrow('channel: Twitchのチャンネル名を指定してください')
  })

  it('チャンネル名に使えない文字が含まれていたらエラーにする', () => {
    expect(() => 解析する('channel=たねのぶ')).toThrow('書式に合いません')
  })
})

describe('bubble.cssVariables', () => {
  it('既定値のとき、文字の大きさと配色をCSSのカスタムプロパティにする', () => {
    expect(bubble.cssVariables(解析する('demo=true'))).toEqual({
      '--chat-size': '28px',
      '--chat-panel': '#fffffff2',
      '--chat-text': '#2b2433',
    })
  })

  it('ふきだしの色には、不透明度を反映する', () => {
    expect(bubble.cssVariables(解析する('demo=true&panel=000000&opacity=0.5'))['--chat-panel']).toBe('#00000080')
  })

  it('ふきだしを透過にした場合は、不透明度によらず透過のままにする', () => {
    expect(bubble.cssVariables(解析する('demo=true&panel=transparent'))['--chat-panel']).toBe('transparent')
  })
})
