/**
 * 時計レジストリ（registry.ts）の整合性テスト
 *
 * 時計は合成オーバーレイの素材として選ばれるので（時計だけの単独ページは issue #107 で消した）、
 * IDが一意でパラメータの既定値がそのまま通ることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { clocks } from './registry'

describe('時計レジストリ', () => {
  it('時計IDが重複していない', () => {
    const ids = clocks.map((clock) => clock.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('時計IDはクエリ文字列にそのまま書ける英小文字・数字・ハイフンだけで構成される', () => {
    for (const clock of clocks) {
      expect(clock.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it.each(clocks.map((clock) => [clock.id, clock] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, clock) => {
      expect(() => parseParams(clock.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
