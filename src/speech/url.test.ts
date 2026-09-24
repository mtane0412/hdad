/**
 * 読み上げページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（speech-page.tsx）から分けてテストする（transcript/url.ts・side-super/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SPEECH_SETTINGS, speechUrl, type SpeechSettings } from './url'

const サイト = 'https://hdad.example.com'

/** 既定の設定に、変えたい項目だけを上書きしてURLを組み立てる */
const URL組み立て = (上書き: Partial<SpeechSettings> = {}): string => speechUrl(サイト, { ...DEFAULT_SPEECH_SETTINGS, ...上書き })

describe('speechUrl', () => {
  it('既定の設定なら、パラメータを何も書き足さない（URLを短く保つ）', () => {
    expect(URL組み立て()).toBe(`${サイト}/speech/reader/`)
  })

  it('話者IDを変えると、URLに書き足す', () => {
    expect(URL組み立て({ speaker: 8 })).toBe(`${サイト}/speech/reader/?speaker=8`)
  })

  it('既定と違う項目だけを、宣言した順に並べて書き足す', () => {
    const url = URL組み立て({ port: 50022, speed: 1.3, readName: true })

    expect(url).toBe(`${サイト}/speech/reader/?port=50022&speed=1.3&readName=true`)
  })

  it('読み上げない人がいれば、ログイン名をカンマ区切りで書き足す', () => {
    expect(URL組み立て({ ignoreLogins: ['hdad_bot', 'nightbot'] })).toBe(`${サイト}/speech/reader/?ignore=hdad_bot%2Cnightbot`)
  })

  it('読み上げない人がいなければ、ignore を書き足さない', () => {
    expect(URL組み立て({ ignoreLogins: [] })).not.toContain('ignore=')
  })

  it('話者IDが整数でなければエラーにする（既定へ黙って戻さない）', () => {
    expect(() => URL組み立て({ speaker: 1.5 })).toThrow(/話者ID/)
    expect(() => URL組み立て({ speaker: Number.NaN })).toThrow(/話者ID/)
  })

  it('ポートが範囲の外ならエラーにする', () => {
    expect(() => URL組み立て({ port: 0 })).toThrow(/ポート/)
    expect(() => URL組み立て({ port: 65536 })).toThrow(/ポート/)
  })
})
