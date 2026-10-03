/**
 * 作業机のサンプル（demo.ts）のテスト
 *
 * プレビューでは、宣言が増えていく様子と、完了して祝われる様子を確かめたいので、次の2点を確かめる。
 * - どの場面も1人1行で、未完了の行が完了した行より上に並ぶこと（Worker の並べ方と同じ）
 * - 未完了だった人が完了する場面が含まれること（祝う見た目をプレビューで確かめられる）
 */
import { describe, expect, it } from 'vitest'
import { demoTaskDeskScenes } from './demo'
import { justCompleted } from './entry'

describe('demoTaskDeskScenes', () => {
  it('どの場面も1人1行で、未完了の行が完了した行より上に並ぶ', () => {
    for (const { entries: scene } of demoTaskDeskScenes) {
      expect(new Set(scene.map((entry) => entry.userId)).size).toBe(scene.length)
      const doneFlags = scene.map((entry) => entry.doneAt !== null)
      expect(doneFlags).toEqual([...doneFlags].sort((left, right) => Number(left) - Number(right)))
    }
  })

  it('未完了だった人が完了する場面が含まれる', () => {
    const completesSomeone = demoTaskDeskScenes.some((scene, index) => {
      const previous = demoTaskDeskScenes[index - 1]?.entries ?? []
      return scene.entries.some((entry) => justCompleted(previous.find((candidate) => candidate.userId === entry.userId), entry))
    })

    expect(completesSomeone).toBe(true)
  })

  it('どの場面にも、並べた人数と作業中の人数に合う作業時間の合計がある（プレビューで合計の見た目を確かめられる）', () => {
    for (const { entries, workTime } of demoTaskDeskScenes) {
      expect(workTime.people).toBe(entries.length)
      expect(workTime.working).toBe(entries.filter((entry) => entry.doneAt === null).length)
    }
  })
})
