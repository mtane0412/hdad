/**
 * 作業ログのサンプル（demo.ts）のテスト
 *
 * プレビューでは行が1行ずつ増えていく様子と、3つの種類の見え方の違いを確かめたいので、次の2点を確かめる。
 * - サンプルの場面は1行ずつ増え、どの場面も新しい順に並んでいること
 * - コミット・マージ・AIのまとめの3つの種類がすべて含まれること
 */
import { describe, expect, it } from 'vitest'
import { demoWorkLogScenes } from './demo'

describe('demoWorkLogScenes', () => {
  it('場面ごとに1行ずつ増え、どの場面も新しい順に並ぶ', () => {
    demoWorkLogScenes.forEach((scene, index) => {
      expect(scene).toHaveLength(index + 1)
      expect(scene.map((entry) => entry.at)).toEqual(scene.map((entry) => entry.at).sort().reverse())
    })
  })

  it('3つの種類がすべて含まれる', () => {
    const kinds = new Set(demoWorkLogScenes.at(-1)?.map((entry) => entry.kind))

    expect(kinds).toEqual(new Set(['commit', 'merge', 'chapter']))
  })
})
