/**
 * 意見ボードのサンプル（demo.ts）のテスト
 *
 * 管理画面のプレビューで配置と見栄えを決められるよう、次の点を確かめる。
 * - 場面を追うごとに意見が増え、最後の場面では論点が6つの枠を埋めること（左右の枠に収まるかを確かめられる）
 * - 札の種類が4つとも出てくること
 * - 上限（40文字）ちょうどの意見が入っていること（折り返したときの高さを確かめられる）
 * - 最初の場面には問いかけが無く、意見が出たあとの場面で問いかけが出て、上限（40文字）ちょうどの問いかけもあること（issue #307）
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

  it('最初の場面には問いかけが無く、あとの場面で問いかけが出て、上限ちょうどの問いかけもある', () => {
    const prompts = demoOpinionBoards.map((board) => board.theme?.prompt ?? null)
    expect(prompts[0]).toBeNull()
    expect(prompts.slice(1).every((prompt) => prompt !== null)).toBe(true)
    expect(Math.max(...prompts.map((prompt) => [...(prompt ?? '')].length))).toBe(40)
  })
})
