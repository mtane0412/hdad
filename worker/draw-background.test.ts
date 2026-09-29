/**
 * 描く画面の背景（配信画面を撮った最新の1枚）の保管のテスト
 *
 * Durable Object の storage の代わりに Map を使う。確かめるのは次の4点である。
 * - 置いた1枚を、形式と撮った時刻ごと読み出せること
 * - storage の1件の上限を超える大きさの1枚も、分けて置いて元どおりに読み出せること
 * - 小さい1枚で置き換えたとき、前の1枚の余った切れ端を残さないこと
 * - 何も置いていなければ「無い」と分かること
 */
import { describe, expect, it } from 'vitest'
import { loadDrawBackground, saveDrawBackground } from './draw-background'
import { createFakeBackgroundStorage as 保管先を作る } from './fake-background-storage'

const 撮った時刻 = Date.parse('2026-09-29T12:00:00Z')

/** 0,1,2… と並んだ中身の画像（中身は確かめやすさのためだけのもの） */
const 画像 = (バイト数: number): ArrayBuffer => Uint8Array.from({ length: バイト数 }, (_, i) => i % 256).buffer

describe('saveDrawBackground と loadDrawBackground', () => {
  it('置いた1枚を、形式と撮った時刻ごと読み出せる', async () => {
    const 保管先 = 保管先を作る()

    await saveDrawBackground(保管先, { image: 画像(10), contentType: 'image/png', capturedAt: 撮った時刻 })

    expect(await loadDrawBackground(保管先)).toEqual({ image: new Uint8Array(画像(10)), contentType: 'image/png', capturedAt: 撮った時刻 })
  })

  it('1件の上限を超える1枚は、分けて置いて元どおりに読み出す', async () => {
    const 保管先 = 保管先を作る()

    await saveDrawBackground(保管先, { image: 画像(25), contentType: 'image/jpeg', capturedAt: 撮った時刻 }, 10)

    expect(保管先.鍵たち()).toEqual(['background', 'background:0', 'background:1', 'background:2'])
    expect((await loadDrawBackground(保管先))?.image).toEqual(new Uint8Array(画像(25)))
  })

  it('小さい1枚で置き換えたら、前の1枚の余った切れ端を消す', async () => {
    const 保管先 = 保管先を作る()
    await saveDrawBackground(保管先, { image: 画像(25), contentType: 'image/png', capturedAt: 撮った時刻 }, 10)

    await saveDrawBackground(保管先, { image: 画像(5), contentType: 'image/png', capturedAt: 撮った時刻 + 60_000 }, 10)

    expect(保管先.鍵たち()).toEqual(['background', 'background:0'])
    expect(await loadDrawBackground(保管先)).toEqual({ image: new Uint8Array(画像(5)), contentType: 'image/png', capturedAt: 撮った時刻 + 60_000 })
  })

  it('何も置いていなければ null を返す', async () => {
    expect(await loadDrawBackground(保管先を作る())).toBeNull()
  })
})
