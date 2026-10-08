/**
 * テキストのサンプル（demo.ts）のテスト
 *
 * プレビューでは、札の大きさと書き換わる様子を確かめたいので、次の2点を確かめる。
 * - 改行を含む本文の場面があること（何行まで箱に収まるかを確かめられる）
 * - 場面ごとに本文が変わること（書き換わったときの見た目を確かめられる）
 */
import { describe, expect, it } from 'vitest'
import { demoTexts } from './demo'

describe('demoTexts', () => {
  it('改行を含む本文の場面がある', () => {
    expect(demoTexts.some((text) => text.body.includes('\n'))).toBe(true)
  })

  it('場面ごとに本文が変わる', () => {
    expect(new Set(demoTexts.map((text) => text.body)).size).toBe(demoTexts.length)
  })
})
