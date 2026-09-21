/**
 * 時計レジストリ（registry.ts）の整合性テスト
 *
 * Workers 静的アセットではURLのパスごとに実ファイルが必要なため、
 * レジストリの定義と clock/<id>/index.html が1対1で対応していることを確認する。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { clocks } from './registry'

const clockDir = resolve(import.meta.dirname, '../../clock')

describe('時計レジストリ', () => {
  it('時計IDが重複していない', () => {
    const ids = clocks.map((clock) => clock.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('時計IDはURLのパスにそのまま使える英小文字・数字・ハイフンだけで構成される', () => {
    for (const clock of clocks) {
      expect(clock.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('clock ディレクトリのページとレジストリの時計が1対1で対応している', () => {
    const pageIds = readdirSync(clockDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(pageIds).toEqual(clocks.map((clock) => clock.id).sort())
  })

  it.each(clocks.map((clock) => [clock.id]))('%s のページは自分のIDで時計を起動している', (id) => {
    const pagePath = resolve(clockDir, id, 'index.html')
    expect(existsSync(pagePath)).toBe(true)
    expect(readFileSync(pagePath, 'utf8')).toContain(`data-clock="${id}"`)
  })

  it.each(clocks.map((clock) => [clock.id, clock] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, clock) => {
      expect(() => parseParams(clock.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
