/**
 * 設定ページからの頼みの読み取りのテスト
 *
 * 設定ページからの頼みだけを読み、ほかのあて先のもの（offscreen document からの知らせ）は無視できることを確かめる。
 * あて先が合っているのに形が違うものはエラーにする。
 */
import { describe, expect, it } from 'vitest'
import { SETTINGS_REQUEST_TARGET, parseSettingsRequest } from './settings-request'

describe('parseSettingsRequest', () => {
  it('一覧・登録・削除の頼みを読む', () => {
    expect(parseSettingsRequest({ target: SETTINGS_REQUEST_TARGET, type: 'list' })).toEqual({ type: 'list' })
    expect(parseSettingsRequest({ target: SETTINGS_REQUEST_TARGET, type: 'add', host: 'bank.example.jp' })).toEqual({ type: 'add', host: 'bank.example.jp' })
    expect(parseSettingsRequest({ target: SETTINGS_REQUEST_TARGET, type: 'remove', host: 'mail.google.com' })).toEqual({ type: 'remove', host: 'mail.google.com' })
  })

  it('ほかのあて先の連絡は無視する（null を返す）', () => {
    expect(parseSettingsRequest({ target: 'background', type: 'ended' })).toBeNull()
  })

  it('あて先が合っているのに形が違えばエラーにする', () => {
    expect(() => parseSettingsRequest({ target: SETTINGS_REQUEST_TARGET, type: 'add' })).toThrow('設定ページからの頼みの形が想定と違います')
    expect(() => parseSettingsRequest({ target: SETTINGS_REQUEST_TARGET, type: '不明' })).toThrow('設定ページからの頼みの形が想定と違います')
  })
})
