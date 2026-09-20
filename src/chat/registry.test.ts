/**
 * チャットボックスのレジストリ（registry.ts）の整合性テスト
 *
 * GitHub PagesではURLのパスごとに実ファイルが必要なため、
 * レジストリの定義と chat/<id>/index.html が1対1で対応していることを確認する。
 * デザインの見た目は src/chat/<id>.css にあるため、ページがそのCSSを読み込んでいることも確認する。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { chats } from './registry'

const chatDir = resolve(import.meta.dirname, '../../chat')
const sourceDir = import.meta.dirname

describe('チャットボックスのレジストリ', () => {
  it('チャットボックスのIDが重複していない', () => {
    const ids = chats.map((chat) => chat.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('公開しているデザインが名前順に並んでいる', () => {
    expect(chats.map((chat) => chat.id)).toEqual(['bubble', 'card', 'plain', 'sticker', 'terminal'])
  })

  it('チャットボックスのIDはURLのパスにそのまま使える英小文字・数字・ハイフンだけで構成される', () => {
    for (const chat of chats) {
      expect(chat.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('chat ディレクトリのページとレジストリの定義が1対1で対応している', () => {
    const pageIds = readdirSync(chatDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(pageIds).toEqual(chats.map((chat) => chat.id).sort())
  })

  it.each(chats.map((chat) => [chat.id]))('%s のページは自分のIDでチャットボックスを起動している', (id) => {
    const pagePath = resolve(chatDir, id, 'index.html')
    expect(existsSync(pagePath)).toBe(true)
    expect(readFileSync(pagePath, 'utf8')).toContain(`data-chat="${id}"`)
  })

  it.each(chats.map((chat) => [chat.id]))('%s には専用のCSSがあり、ページから読み込んでいる', (id) => {
    expect(existsSync(resolve(sourceDir, `${id}.css`))).toBe(true)
    expect(readFileSync(resolve(chatDir, id, 'index.html'), 'utf8')).toContain(`href="../../src/chat/${id}.css"`)
  })

  it.each(chats.map((chat) => [chat.id, chat] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, chat) => {
      expect(() => parseParams(chat.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
