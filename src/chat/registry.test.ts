/**
 * チャットボックスのレジストリ（registry.ts）の整合性テスト
 *
 * チャットボックスは合成オーバーレイの素材として選ばれるので（デザインごとの単独ページは issue #107 で消した）、
 * IDが一意でパラメータの既定値がそのまま通ることを確認する。
 * デザインの見た目は src/chat/<id>.css にあるため、そのCSSが存在することも確認する
 * （合成ページが読み込んでいるかどうかは src/overlay/styles.test.ts が確かめる）。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseParams } from '../core/params'
import { chats } from './registry'

const sourceDir = import.meta.dirname

describe('チャットボックスのレジストリ', () => {
  it('チャットボックスのIDが重複していない', () => {
    const ids = chats.map((chat) => chat.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('公開しているデザインが名前順に並んでいる', () => {
    expect(chats.map((chat) => chat.id)).toEqual(['bubble', 'card', 'plain', 'sticker', 'terminal'])
  })

  it('チャットボックスのIDはクエリ文字列にそのまま書ける英小文字・数字・ハイフンだけで構成される', () => {
    for (const chat of chats) {
      expect(chat.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it.each(chats.map((chat) => [chat.id]))('%s には専用のCSSがある', (id) => {
    expect(existsSync(resolve(sourceDir, `${id}.css`))).toBe(true)
  })

  it.each(chats.map((chat) => [chat.id, chat] as const))(
    '%s はパラメータなしのURLで既定値のまま解析できる',
    (_id, chat) => {
      expect(() => parseParams(chat.schema, new URLSearchParams())).not.toThrow()
    },
  )
})
