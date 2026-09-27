/**
 * 注目コメントのオーバーレイのURLの組み立て（url.ts）のテスト
 *
 * 配信者はここで作ったURLをOBSのブラウザソースに貼る。貼り間違いを減らすため、既定と同じ値は
 * 書き足さない（サイドスーパーの url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { focusDemoUrl, focusUrl } from './url'

const サイト = 'https://hdad.example.com'
const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

describe('focusUrl', () => {
  it('オーバーレイのパスにオーバーレイ用キーを付ける', () => {
    expect(focusUrl(サイト, オーバーレイ用キー)).toBe(`${サイト}/focus/overlay/?key=${オーバーレイ用キー}`)
  })

  it('URLに使えない文字を含むキーも読めるように変換する', () => {
    expect(focusUrl(サイト, 'キー/あり')).toBe(`${サイト}/focus/overlay/?key=${encodeURIComponent('キー/あり')}`)
  })
})

describe('focusDemoUrl', () => {
  it('デモはWorkerに接続しないので、オーバーレイ用キーを付けない', () => {
    expect(focusDemoUrl(サイト)).toBe(`${サイト}/focus/overlay/?demo=true`)
  })
})
