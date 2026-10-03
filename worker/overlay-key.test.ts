/**
 * オーバーレイ用キーのテスト
 *
 * 確かめるのは、Durable Object に渡す目印（キーから作る短い要約）の性質である。
 * 目印はキーそのものを持ち出さずに「同じキーで開かれた接続か」を見分けるために使う（worker/overlay-key.ts）。
 */
import { describe, expect, it } from 'vitest'
import { overlayKeyTag } from './overlay-key'

describe('overlayKeyTag', () => {
  it('同じキーからは同じ目印、違うキーからは違う目印を作る', async () => {
    const tag = await overlayKeyTag('配信用のオーバーレイ用キー-1')

    expect(await overlayKeyTag('配信用のオーバーレイ用キー-1')).toBe(tag)
    expect(await overlayKeyTag('配信用のオーバーレイ用キー-2')).not.toBe(tag)
  })

  it('目印は16文字の16進数で、キーそのものを含まない', async () => {
    const key = 'abcdef0123456789abcdef0123456789'

    const tag = await overlayKeyTag(key)

    expect(tag).toMatch(/^[0-9a-f]{16}$/)
    expect(key).not.toContain(tag)
  })
})
