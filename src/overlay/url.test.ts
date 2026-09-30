/**
 * 合成ページのOBS用URLの組み立て（url.ts）のテスト
 *
 * 画面（overlay-page.tsx）から分けてテストする（サイドスーパー・注目コメントの url.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import { overlayPreviewUrl, overlayStageUrl, overlayStageUrlOutline } from './url'

const overlayKey = 'overlay-key_0123456789abcdefghij'
const site = 'https://hdad.example.com'

describe('overlayStageUrl', () => {
  it('合成ページのURLに、オーバーレイ用キーとオーバーレイの名前を付ける', () => {
    expect(overlayStageUrl(site, overlayKey, 'back')).toBe(
      `${site}/overlay/stage/?key=${encodeURIComponent(overlayKey)}&overlay=back`,
    )
  })

  it('オーバーレイの名前もエンコードする（書式の検証はWorkerが持つので、そのまま載せない）', () => {
    expect(overlayStageUrl(site, overlayKey, 'ゲーム画面')).toContain(`&overlay=${encodeURIComponent('ゲーム画面')}`)
  })

  it('オーバーレイの名前が空なら、貼れないURLを作らずエラーにする', () => {
    expect(() => overlayStageUrl(site, overlayKey, '')).toThrow(/オーバーレイの名前/)
  })
})

describe('overlayPreviewUrl', () => {
  it('プレビュー用のURLに、オーバーレイの名前とサンプル表示の指定を付ける', () => {
    expect(overlayPreviewUrl(site, 'back')).toBe(`${site}/overlay/stage/?overlay=back&demo=true`)
  })

  it('オーバーレイ用キーを付けない（プレビューは外へつながないので、合言葉を iframe のURLに載せない）', () => {
    expect(overlayPreviewUrl(site, 'front')).not.toContain('key=')
  })

  it('オーバーレイの名前が空なら、何も映らないURLを作らずエラーにする', () => {
    expect(() => overlayPreviewUrl(site, '')).toThrow(/オーバーレイの名前/)
  })
})

describe('overlayStageUrlOutline', () => {
  it('オーバーレイ用キーを伏せたまま、名前がURLのどこに載るかを見せる', () => {
    expect(overlayStageUrlOutline(site, 'talk')).toBe(`${site}/overlay/stage/?key=…&overlay=talk`)
  })

  it('オーバーレイ用キーそのものを含めない（名前を打っているあいだ画面に出しっぱなしになるため）', () => {
    expect(overlayStageUrlOutline(site, 'talk')).not.toContain(overlayKey)
  })

  it('オーバーレイの名前が空なら、名前の載っていないURLを見せずエラーにする', () => {
    expect(() => overlayStageUrlOutline(site, '')).toThrow(/オーバーレイの名前/)
  })
})
