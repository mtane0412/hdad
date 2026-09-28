/**
 * 背景レジストリ（registry.ts）の整合性テスト
 *
 * 背景は合成オーバーレイの素材として選ばれるので（背景だけの単独ページは issue #107 で消した）、
 * IDが一意でパラメータの既定値がそのまま通ることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { backgrounds } from './registry'

describe('背景レジストリ', () => {
  it('背景IDが重複していない', () => {
    const ids = backgrounds.map((background) => background.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('背景IDはクエリ文字列にそのまま書ける英小文字・数字・ハイフンだけで構成される', () => {
    for (const background of backgrounds) {
      expect(background.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it.each(backgrounds.map((background) => [background.id, background] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, background) => {
      expect(() => parseParams(background.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
