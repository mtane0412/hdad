/**
 * offscreen document からサービスワーカーへの知らせの読み取りのテスト
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、サービスワーカーあての知らせだけを読み、
 * ほかのあて先のもの（offscreen document あての頼み）は無視できることを確かめる。形の違うものはエラーにする。
 */
import { describe, expect, it } from 'vitest'
import { OFFSCREEN_EVENT_TARGET, parseOffscreenEvent } from './offscreen-event'

describe('parseOffscreenEvent', () => {
  it('取り込みの状態を読む', () => {
    expect(parseOffscreenEvent({ target: OFFSCREEN_EVENT_TARGET, type: 'state', viewers: 1, warning: null })).toEqual({ type: 'state', viewers: 1, warning: null })
    expect(parseOffscreenEvent({ target: OFFSCREEN_EVENT_TARGET, type: 'state', viewers: 0, warning: '中継先との接続が切れました' })).toEqual({
      type: 'state',
      viewers: 0,
      warning: '中継先との接続が切れました',
    })
  })

  it('取り込みが終わった知らせを読む', () => {
    expect(parseOffscreenEvent({ target: OFFSCREEN_EVENT_TARGET, type: 'ended' })).toEqual({ type: 'ended' })
  })

  it('ほかのあて先の連絡は無視する（null を返す）', () => {
    expect(parseOffscreenEvent({ target: 'offscreen', type: 'stop' })).toBeNull()
  })

  it('サービスワーカーあてなのに形が違えばエラーにする', () => {
    expect(() => parseOffscreenEvent({ target: OFFSCREEN_EVENT_TARGET, type: 'state', viewers: '1', warning: null })).toThrow(
      'offscreen document からの知らせの形が想定と違います',
    )
    expect(() => parseOffscreenEvent({ target: OFFSCREEN_EVENT_TARGET, type: '不明' })).toThrow('offscreen document からの知らせの形が想定と違います')
  })
})
