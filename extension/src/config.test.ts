/**
 * 拡張に同梱する設定（config.json）の読み取りのテスト
 *
 * 設定は、配信者がアプリ（/tab/）から拡張をダウンロードしたときに Worker が書き込む（worker/tab-extension.ts）。
 * 拡張はここで信頼した置き場所の /tab/ にだけストリームIDを渡す。読めない設定を、黙って
 * 「どこでも信頼する」形に倒さずエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { parseExtensionConfig } from './config'

describe('parseExtensionConfig', () => {
  it('信頼する置き場所を読む', () => {
    expect(parseExtensionConfig({ trustedOrigins: ['https://hdad.example.workers.dev'] })).toEqual({
      trustedOrigins: ['https://hdad.example.workers.dev'],
    })
  })

  it('置き場所が1つも無ければエラーにする', () => {
    expect(() => parseExtensionConfig({ trustedOrigins: [] })).toThrow('拡張の設定（config.json）を読み取れません')
  })

  it('置き場所の一覧が無ければエラーにする', () => {
    expect(() => parseExtensionConfig({})).toThrow('拡張の設定（config.json）を読み取れません')
  })

  it('置き場所でないもの（パスまで含む URL）が入っていればエラーにする', () => {
    expect(() => parseExtensionConfig({ trustedOrigins: ['https://hdad.example.workers.dev/tab/'] })).toThrow(
      '拡張の設定（config.json）を読み取れません',
    )
  })
})
