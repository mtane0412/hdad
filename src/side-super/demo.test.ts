/**
 * デモ用のサンプル（demo.ts）のテスト
 *
 * サンプルは配置と見栄えを確かめるためのものなので、実際に出る文言と同じ形（見出しと本文の2行で、
 * それぞれ上限の文字数に収まる）であることを確かめる。上限いっぱいのサンプルが含まれることも確かめる
 * （いちばん幅を取る場合を見られないと、OBSでの配置を決められないため）。
 */
import { describe, expect, it } from 'vitest'
import { DEMO_SIDE_SUPER_HEAD_LENGTH, DEMO_SIDE_SUPER_BODY_LENGTH, demoSideSupers } from './demo'

/** 見た目の文字数を数える（絵文字を2文字と数えないよう、worker/side-super.ts と同じ数え方にする） */
const countChars = (line: string): number => [...line].length

describe('demoSideSupers', () => {
  it('サンプルが1件以上ある', () => {
    expect(demoSideSupers.length).toBeGreaterThan(0)
  })

  it('どのサンプルも見出しと本文の2行で、それぞれ上限の文字数に収まる', () => {
    for (const [head, body] of demoSideSupers) {
      expect(countChars(head)).toBeLessThanOrEqual(DEMO_SIDE_SUPER_HEAD_LENGTH)
      expect(countChars(body)).toBeLessThanOrEqual(DEMO_SIDE_SUPER_BODY_LENGTH)
    }
  })

  it('上限いっぱいのサンプルが含まれる（いちばん幅を取る場合を確かめられるようにする）', () => {
    const maxLengthDemo = demoSideSupers.find(
      ([head, body]) => countChars(head) === DEMO_SIDE_SUPER_HEAD_LENGTH && countChars(body) === DEMO_SIDE_SUPER_BODY_LENGTH,
    )

    expect(maxLengthDemo).toBeDefined()
  })
})
