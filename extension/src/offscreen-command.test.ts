/**
 * サービスワーカーから offscreen document への頼みの読み取りのテスト
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、offscreen document あての頼みだけを読み、
 * ほかのあて先のもの（サービスワーカーあての知らせ）は無視できることを確かめる。形の違うものはエラーにする。
 */
import { describe, expect, it } from 'vitest'
import { OFFSCREEN_COMMAND_TARGET, parseOffscreenCommand } from './offscreen-command'

describe('parseOffscreenCommand', () => {
  it('取り込み始める頼みを読む', () => {
    expect(
      parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'start', streamId: 'ストリームID-1', origin: 'https://hdad.example.workers.dev' }),
    ).toEqual({ type: 'start', streamId: 'ストリームID-1', origin: 'https://hdad.example.workers.dev' })
  })

  it('止める頼みを読む', () => {
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'stop' })).toEqual({ type: 'stop' })
  })

  it('ほかのあて先の連絡は無視する（null を返す）', () => {
    expect(parseOffscreenCommand({ target: 'background', type: 'ended' })).toBeNull()
  })

  it('offscreen document あてなのに形が違えばエラーにする', () => {
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'start', streamId: '', origin: 'https://hdad.example.workers.dev' })).toThrow(
      'サービスワーカーからの頼みの形が想定と違います',
    )
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: '不明' })).toThrow('サービスワーカーからの頼みの形が想定と違います')
  })
})
