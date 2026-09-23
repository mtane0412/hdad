/**
 * OBS用のURLの組み立て（url.ts）のテスト
 *
 * 画面（transcript-page.tsx）から分けてテストする。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PORT, relayUrl } from './url'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'
const サイト = 'https://hdad.example.com'

describe('relayUrl', () => {
  it('中継ページのURLに、オーバーレイ用キーを付ける', () => {
    expect(relayUrl(サイト, オーバーレイ用キー, DEFAULT_TRANSCRIPT_PORT)).toBe(
      `${サイト}/transcript/relay/?key=${encodeURIComponent(オーバーレイ用キー)}`,
    )
  })

  it('ポートが既定と違えば、URLに書き足す', () => {
    expect(relayUrl(サイト, オーバーレイ用キー, 20000)).toBe(`${サイト}/transcript/relay/?key=${encodeURIComponent(オーバーレイ用キー)}&port=20000`)
  })

  it('ポートが既定と同じなら書き足さない（URLを短く保つ）', () => {
    expect(relayUrl(サイト, オーバーレイ用キー, DEFAULT_TRANSCRIPT_PORT)).not.toContain('port=')
  })

  it('ポートが数でなければエラーにする（既定へ黙って戻さない）', () => {
    expect(() => relayUrl(サイト, オーバーレイ用キー, Number.NaN)).toThrow(/ポート/)
  })

  it('ポートが範囲の外ならエラーにする', () => {
    expect(() => relayUrl(サイト, オーバーレイ用キー, 0)).toThrow(/ポート/)
    expect(() => relayUrl(サイト, オーバーレイ用キー, 65536)).toThrow(/ポート/)
  })
})
