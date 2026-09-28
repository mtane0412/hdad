/**
 * 裏方のページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（backstage-page.tsx）から分けてテストする（transcript/url.ts・speech/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PORT } from '../transcript/url'
import { backstageUrl } from './url'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'
const サイト = 'https://hdad.example.com'
const 両方 = { speech: true, transcript: true, port: DEFAULT_TRANSCRIPT_PORT }

describe('backstageUrl', () => {
  it('裏方のページのURLに、オーバーレイ用キーを付ける', () => {
    expect(backstageUrl(サイト, オーバーレイ用キー, 両方)).toBe(`${サイト}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  it('両方を動かすときは、裏方の指定を書き足さない（URLを短く保つ）', () => {
    const url = backstageUrl(サイト, オーバーレイ用キー, 両方)

    expect(url).not.toContain('speech=')
    expect(url).not.toContain('transcript=')
  })

  it('読み上げだけを動かすなら、文字起こしを切ると書く', () => {
    expect(backstageUrl(サイト, オーバーレイ用キー, { ...両方, transcript: false })).toBe(
      `${サイト}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&transcript=false`,
    )
  })

  it('文字起こしだけを動かすなら、読み上げを切ると書く', () => {
    expect(backstageUrl(サイト, オーバーレイ用キー, { ...両方, speech: false })).toBe(
      `${サイト}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&speech=false`,
    )
  })

  it('ポートが既定と違えば、URLに書き足す', () => {
    expect(backstageUrl(サイト, オーバーレイ用キー, { ...両方, port: 20000 })).toBe(
      `${サイト}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&port=20000`,
    )
  })

  it('文字起こしを動かさないなら、ポートは書かない（つなぎ先を持たないため）', () => {
    expect(backstageUrl(サイト, オーバーレイ用キー, { speech: true, transcript: false, port: 20000 })).not.toContain('port=')
  })

  it('文字起こしを動かさないなら、読めないポートでもエラーにしない（そのポートへはつながないため）', () => {
    expect(() => backstageUrl(サイト, オーバーレイ用キー, { speech: true, transcript: false, port: Number.NaN })).not.toThrow()
  })

  it('文字起こしを動かすのにポートが読めなければエラーにする（既定へ黙って戻さない）', () => {
    expect(() => backstageUrl(サイト, オーバーレイ用キー, { ...両方, port: Number.NaN })).toThrow(/ポート/)
    expect(() => backstageUrl(サイト, オーバーレイ用キー, { ...両方, port: 0 })).toThrow(/ポート/)
  })

  it('裏方をひとつも動かさないURLは組み立てない（貼っても何もしないブラウザソースを作らせない）', () => {
    expect(() => backstageUrl(サイト, オーバーレイ用キー, { speech: false, transcript: false, port: DEFAULT_TRANSCRIPT_PORT })).toThrow(
      /1つ/,
    )
  })
})
