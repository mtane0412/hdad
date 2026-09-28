/**
 * 合成ページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（overlay-page.tsx）から分けてテストする（サイドスーパー・注目コメントの url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { overlayPreviewUrl, overlayStageUrl } from './url'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'
const サイト = 'https://hdad.example.com'

describe('overlayStageUrl', () => {
  it('合成ページのURLに、オーバーレイ用キーとオーバーレイの名前を付ける', () => {
    expect(overlayStageUrl(サイト, オーバーレイ用キー, 'back')).toBe(
      `${サイト}/overlay/stage/?key=${encodeURIComponent(オーバーレイ用キー)}&overlay=back`,
    )
  })

  it('オーバーレイの名前もエンコードする（書式の検証はWorkerが持つので、そのまま載せない）', () => {
    expect(overlayStageUrl(サイト, オーバーレイ用キー, 'ゲーム画面')).toContain(`&overlay=${encodeURIComponent('ゲーム画面')}`)
  })

  it('オーバーレイの名前が空なら、貼れないURLを作らずエラーにする', () => {
    expect(() => overlayStageUrl(サイト, オーバーレイ用キー, '')).toThrow(/オーバーレイの名前/)
  })
})

describe('overlayPreviewUrl', () => {
  it('プレビュー用のURLに、オーバーレイの名前とサンプル表示の指定を付ける', () => {
    expect(overlayPreviewUrl(サイト, 'back')).toBe(`${サイト}/overlay/stage/?overlay=back&demo=true`)
  })

  it('オーバーレイ用キーを付けない（プレビューは外へつながないので、合言葉を iframe のURLに載せない）', () => {
    expect(overlayPreviewUrl(サイト, 'front')).not.toContain('key=')
  })

  it('オーバーレイの名前が空なら、何も映らないURLを作らずエラーにする', () => {
    expect(() => overlayPreviewUrl(サイト, '')).toThrow(/オーバーレイの名前/)
  })
})
