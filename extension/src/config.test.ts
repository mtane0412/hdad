/**
 * 拡張に同梱する設定（config.json）の読み取りのテスト
 *
 * 設定は、配信者がアプリ（/tab/）から拡張をダウンロードしたときに Worker が書き込む（worker/tab-extension.ts）。
 * 拡張はここに書かれた HDAD の置き場所の中継先へ、配信者のセッションでつなぐ。読めない設定を、黙って
 * 別の置き場所に倒さずエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { parseExtensionConfig } from './config'

describe('parseExtensionConfig', () => {
  it('HDAD の置き場所を読む', () => {
    expect(parseExtensionConfig({ origin: 'https://hdad.example.workers.dev' })).toEqual({ origin: 'https://hdad.example.workers.dev' })
  })

  it('置き場所が無ければエラーにする', () => {
    expect(() => parseExtensionConfig({})).toThrow('拡張の設定（config.json）を読み取れません')
  })

  it('置き場所でないもの（パスまで含む URL）はエラーにする', () => {
    expect(() => parseExtensionConfig({ origin: 'https://hdad.example.workers.dev/tab/' })).toThrow('拡張の設定（config.json）を読み取れません')
  })

  it('前の版の設定（信頼する置き場所の一覧）はエラーにする', () => {
    // 前の版の拡張の config.json を残したまま読み込んだときに起こる
    expect(() => parseExtensionConfig({ trustedOrigins: ['https://hdad.example.workers.dev'] })).toThrow('拡張の設定（config.json）を読み取れません')
  })
})
