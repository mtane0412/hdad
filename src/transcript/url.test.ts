/**
 * OBS用のURLの組み立て（url.ts）のテスト
 *
 * 画面（transcript-page.tsx）から分けてテストする。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PORT, relayUrl } from './url'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'
const SITE = 'https://hdad.example.com'

describe('relayUrl', () => {
  it('中継ページのURLに、オーバーレイ用キーを付ける', () => {
    expect(relayUrl(SITE, OVERLAY_KEY, DEFAULT_TRANSCRIPT_PORT)).toBe(
      `${SITE}/transcript/relay/?key=${encodeURIComponent(OVERLAY_KEY)}`,
    )
  })

  it('ポートが既定と違えば、URLに書き足す', () => {
    expect(relayUrl(SITE, OVERLAY_KEY, 20000)).toBe(`${SITE}/transcript/relay/?key=${encodeURIComponent(OVERLAY_KEY)}&port=20000`)
  })

  it('ポートが既定と同じなら書き足さない（URLを短く保つ）', () => {
    expect(relayUrl(SITE, OVERLAY_KEY, DEFAULT_TRANSCRIPT_PORT)).not.toContain('port=')
  })

  it('ポートが数でなければエラーにする（既定へ黙って戻さない）', () => {
    expect(() => relayUrl(SITE, OVERLAY_KEY, Number.NaN)).toThrow(/ポート/)
  })

  it('ポートが範囲の外ならエラーにする', () => {
    expect(() => relayUrl(SITE, OVERLAY_KEY, 0)).toThrow(/ポート/)
    expect(() => relayUrl(SITE, OVERLAY_KEY, 65536)).toThrow(/ポート/)
  })
})
