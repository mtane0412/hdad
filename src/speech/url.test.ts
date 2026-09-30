/**
 * 読み上げページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（speech-page.tsx）から分けてテストする（transcript/url.ts・side-super/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { speechUrl } from './url'

const origin = 'https://hdad.example.com'
const overlayKey = 'overlay-key_0123456789abcdefghij'

describe('speechUrl', () => {
  it('オーバーレイ用キーだけを付けたURLを組み立てる（設定はWorkerから読むのでURLに入れない）', () => {
    expect(speechUrl(origin, overlayKey)).toBe(`${origin}/speech/reader/?key=${overlayKey}`)
  })

  it('キーにURLで使えない文字が混じっていても、そのまま埋めずに書き換える', () => {
    expect(speechUrl(origin, 'a+b/c')).toBe(`${origin}/speech/reader/?key=a%2Bb%2Fc`)
  })
})
