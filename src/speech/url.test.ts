/**
 * 読み上げページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（speech-page.tsx）から分けてテストする（transcript/url.ts・side-super/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { speechUrl } from './url'

const サイト = 'https://hdad.example.com'
const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

describe('speechUrl', () => {
  it('オーバーレイ用キーだけを付けたURLを組み立てる（設定はWorkerから読むのでURLに入れない）', () => {
    expect(speechUrl(サイト, オーバーレイ用キー)).toBe(`${サイト}/speech/reader/?key=${オーバーレイ用キー}`)
  })

  it('キーにURLで使えない文字が混じっていても、そのまま埋めずに書き換える', () => {
    expect(speechUrl(サイト, 'a+b/c')).toBe(`${サイト}/speech/reader/?key=a%2Bb%2Fc`)
  })
})
