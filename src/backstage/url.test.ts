/**
 * 裏方のページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（backstage-page.tsx）から分けてテストする（transcript/url.ts・speech/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PORT } from '../transcript/url'
import { backstageUrl } from './url'

const overlayKey = 'overlay-key_0123456789abcdefghij'
const site = 'https://hdad.example.com'
const defaults = { speech: true, transcript: true, screen: false, bgm: false, port: DEFAULT_TRANSCRIPT_PORT }

describe('backstageUrl', () => {
  it('裏方のページのURLに、オーバーレイ用キーを付ける', () => {
    expect(backstageUrl(site, overlayKey, defaults)).toBe(`${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}`)
  })

  it('既定と同じ組み合わせなら、裏方の指定を書き足さない（URLを短く保つ）', () => {
    const url = backstageUrl(site, overlayKey, defaults)

    expect(url).not.toContain('speech=')
    expect(url).not.toContain('transcript=')
    expect(url).not.toContain('screen=')
    expect(url).not.toContain('bgm=')
  })

  it('BGMは既定で鳴らさないので、鳴らすときだけ書き足す', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, bgm: true })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&bgm=true`,
    )
  })

  it('BGMだけを鳴らすこともできる', () => {
    expect(() => backstageUrl(site, overlayKey, { ...defaults, speech: false, transcript: false, bgm: true })).not.toThrow()
  })

  it('画面の取り込みは既定で動かさないので、動かすときだけ書き足す', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, screen: true })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&screen=true`,
    )
  })

  it('画面の取り込みだけを動かすこともできる', () => {
    expect(backstageUrl(site, overlayKey, { speech: false, transcript: false, screen: true, bgm: false, port: DEFAULT_TRANSCRIPT_PORT })).toContain(
      'screen=true',
    )
  })

  it('読み上げだけを動かすなら、文字起こしを切ると書く', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, transcript: false })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&transcript=false`,
    )
  })

  it('文字起こしだけを動かすなら、読み上げを切ると書く', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, speech: false })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&speech=false`,
    )
  })

  it('ポートが既定と違えば、URLに書き足す', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, port: 20000 })).toBe(
      `${site}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&port=20000`,
    )
  })

  it('文字起こしを動かさないなら、ポートは書かない（つなぎ先を持たないため）', () => {
    expect(backstageUrl(site, overlayKey, { ...defaults, transcript: false, port: 20000 })).not.toContain('port=')
  })

  it('文字起こしを動かさないなら、読めないポートでもエラーにしない（そのポートへはつながないため）', () => {
    expect(() => backstageUrl(site, overlayKey, { ...defaults, transcript: false, port: Number.NaN })).not.toThrow()
  })

  it('文字起こしを動かすのにポートが読めなければエラーにする（既定へ黙って戻さない）', () => {
    expect(() => backstageUrl(site, overlayKey, { ...defaults, port: Number.NaN })).toThrow(/ポート/)
    expect(() => backstageUrl(site, overlayKey, { ...defaults, port: 0 })).toThrow(/ポート/)
  })

  it('裏方をひとつも動かさないURLは組み立てない（貼っても何もしないブラウザソースを作らせない）', () => {
    expect(() =>
      backstageUrl(site, overlayKey, { speech: false, transcript: false, screen: false, bgm: false, port: DEFAULT_TRANSCRIPT_PORT }),
    ).toThrow(/1つ/)
  })
})
