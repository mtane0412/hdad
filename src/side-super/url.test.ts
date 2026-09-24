/**
 * OBS用のURLの組み立て（url.ts）のテスト
 *
 * 画面（side-super-page.tsx）から分けてテストする（transcript/url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { sideSuperUrl } from './url'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'
const サイト = 'https://hdad.example.com'

describe('sideSuperUrl', () => {
  it('オーバーレイのURLに、オーバーレイ用キーを付ける', () => {
    expect(sideSuperUrl(サイト, オーバーレイ用キー, 'left')).toBe(`${サイト}/side-super/overlay/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  it('右上に出すときは、寄せる向きをURLに書き足す', () => {
    expect(sideSuperUrl(サイト, オーバーレイ用キー, 'right')).toBe(
      `${サイト}/side-super/overlay/?key=${encodeURIComponent(オーバーレイ用キー)}&position=right`,
    )
  })

  it('左上（既定）なら書き足さない（URLを短く保つ）', () => {
    expect(sideSuperUrl(サイト, オーバーレイ用キー, 'left')).not.toContain('position=')
  })
})
