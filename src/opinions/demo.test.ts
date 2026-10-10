/**
 * 意見ボードのサンプル（demo.ts）のテスト
 *
 * 管理画面のプレビューで配置と見栄えを決められるよう、次の点を確かめる。
 * - 場面を追うごとに意見が増え、最後の場面では論点が6つの枠を埋めること（左右の枠に収まるかを確かめられる）
 * - 札の種類が4つとも出てくること
 * - 上限（40文字）ちょうどの意見が入っていること（折り返したときの高さを確かめられる）
 */
import { describe, expect, it } from 'vitest'
import { demoOpinionBoards } from './demo'
import { OPINION_KINDS } from './entry'

/** 場面の意見の数 */
const countOpinions = (index: number): number => demoOpinionBoards[index]?.topics.reduce((sum, topic) => sum + topic.opinions.length, 0) ?? 0

describe('demoOpinionBoards', () => {
  it('場面を追うごとに意見が増え、最後の場面では論点が6つになる', () => {
    const counts = demoOpinionBoards.map((_, index) => countOpinions(index))
    expect(counts).toEqual([...counts].sort((left, right) => left - right))
    expect(new Set(counts).size).toBe(counts.length)
    expect(demoOpinionBoards.at(-1)?.topics).toHaveLength(6)
  })

  it('札の種類が4つとも出てくる', () => {
    const kinds = new Set(demoOpinionBoards.flatMap((board) => board.topics.flatMap((topic) => topic.opinions.map((opinion) => opinion.kind))))
    expect([...kinds].sort()).toEqual([...OPINION_KINDS].sort())
  })

  it('上限ちょうどの意見が入っている', () => {
    const lengths = demoOpinionBoards.flatMap((board) => board.topics.flatMap((topic) => topic.opinions.map((opinion) => [...opinion.text].length)))
    expect(Math.max(...lengths)).toBe(40)
  })
})
