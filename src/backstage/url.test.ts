/**
 * 裏方のページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（backstage-page.tsx）から分けてテストする（speech/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { backstageUrl } from './url'

const overlayKey = 'overlay-key_0123456789abcdefghij'
const site = 'https://hdad.example.com'
const defaults = { speech: true, screen: false, bgm: false }

describe('backstageUrl', () => {
  it('裏方のページのURLに、オーバーレイ用キーを付ける', () => {
    expect(backstageUrl(site, overlayKey, defaults)).toBe(`${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}`)
  })

  it('既定と同じ組み合わせなら、裏方の指定を書き足さない（URLを短く保つ）', () => {
    const url = backstageUrl(site, overlayKey, defaults)

    expect(url).not.toContain('speech=')
    expect(url).not.toContain('screen=')
    expect(url).not.toContain('bgm=')
  })

  it('ゆかコネNEO の中継の指定（transcript・port）は書かない（アプリの枠の音声認識に置き換えた）', () => {
    const url = backstageUrl(site, overlayKey, { speech: true, screen: true, bgm: true })

    expect(url).not.toContain('transcript=')
    expect(url).not.toContain('port=')
  })

  it('BGMは既定で鳴らさないので、鳴らすときだけ書き足す', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, bgm: true })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&bgm=true`,
    )
  })

  it('BGMだけを鳴らすなら、読み上げを切ると書く', () => {
    expect(backstageUrl(site, overlayKey, { speech: false, screen: false, bgm: true })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&speech=false&bgm=true`,
    )
  })

  it('画面の取り込みは既定で動かさないので、動かすときだけ書き足す', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, screen: true })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&screen=true`,
    )
  })

  it('画面の取り込みだけを動かすこともできる', () => {
    expect(backstageUrl(site, overlayKey, { speech: false, screen: true, bgm: false })).toContain('screen=true')
  })

  it('裏方をひとつも動かさないURLは組み立てない（貼っても何もしないブラウザソースを作らせない）', () => {
    expect(() => backstageUrl(site, overlayKey, { speech: false, screen: false, bgm: false })).toThrow(/1つ/)
  })
})
