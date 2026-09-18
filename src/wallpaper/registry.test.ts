/**
 * 背景レジストリ（registry.ts）の整合性テスト
 *
 * GitHub PagesではURLのパスごとに実ファイルが必要なため、
 * レジストリの定義と wallpaper/<id>/index.html が1対1で対応していることを確認する。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { backgrounds } from './registry'

const wallpaperDir = resolve(import.meta.dirname, '../../wallpaper')

describe('背景レジストリ', () => {
  it('背景IDが重複していない', () => {
    const ids = backgrounds.map((background) => background.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('背景IDはURLのパスにそのまま使える英小文字・数字・ハイフンだけで構成される', () => {
    for (const background of backgrounds) {
      expect(background.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('wallpaper ディレクトリのページとレジストリの背景が1対1で対応している', () => {
    const pageIds = readdirSync(wallpaperDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(pageIds).toEqual(backgrounds.map((background) => background.id).sort())
  })

  it.each(backgrounds.map((background) => [background.id]))(
    '%s のページは自分のIDで背景を起動している',
    (id) => {
      const pagePath = resolve(wallpaperDir, id, 'index.html')
      expect(existsSync(pagePath)).toBe(true)
      expect(readFileSync(pagePath, 'utf8')).toContain(`data-background="${id}"`)
    },
  )

  it.each(backgrounds.map((background) => [background.id, background] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, background) => {
      expect(() => parseParams(background.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
