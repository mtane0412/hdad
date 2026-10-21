/**
 * チャットで推理の出題（問題集から1問を決める）のテスト
 *
 * 配信者は問題集だけを選び、どの問題かは Worker が乱数で決める（配信者も答えを知らずに参加するため）。
 * 確かめること:
 * - 乱数に応じて、問題集の中から1問を選ぶこと
 * - 直前のゲームの問題は選ばないこと（同じ問題が続かないように）
 * - 問題集に1問しか無ければ、直前と同じでもその問題を選ぶこと（始められなくしないため）
 */
import { describe, expect, it } from 'vitest'
import type { ChatDeductionProblem, ChatDeductionProblemSet } from '../src/chat-deduction/problems'
import { pickChatDeductionProblem, pickConfiguredChatDeductionProblem } from './chat-deduction-pick'

const problemOf = (id: string, answer: string): ChatDeductionProblem => ({ id, category: 'person', answer, aliases: [answer], facts: [`${answer}についての事実。`], explanation: `${answer}についての解説。`, wikipedia: answer })

const ancientPeople: ChatDeductionProblemSet = {
  id: 'ancient-people',
  name: '古代史の人物',
  problems: [problemOf('himiko', '卑弥呼'), problemOf('shotoku-taishi', '聖徳太子'), problemOf('kukai', '空海')],
}

describe('pickChatDeductionProblem', () => {
  it('乱数に応じて、問題集の中から1問を選ぶ（0なら先頭、1に近ければ末尾）', () => {
    expect(pickChatDeductionProblem(ancientPeople, null, () => 0).id).toBe('himiko')
    expect(pickChatDeductionProblem(ancientPeople, null, () => 0.5).id).toBe('shotoku-taishi')
    expect(pickChatDeductionProblem(ancientPeople, null, () => 0.99).id).toBe('kukai')
  })

  it('直前のゲームの問題は選ばない（残りの問題から乱数で選ぶ）', () => {
    // 直前が卑弥呼なら、候補は聖徳太子と空海の2問になる
    expect(pickChatDeductionProblem(ancientPeople, 'himiko', () => 0).id).toBe('shotoku-taishi')
    expect(pickChatDeductionProblem(ancientPeople, 'himiko', () => 0.99).id).toBe('kukai')
  })

  it('直前のゲームがほかの問題集の問題なら、問題集のすべての問題から選ぶ', () => {
    expect(pickChatDeductionProblem(ancientPeople, 'mount-fuji', () => 0).id).toBe('himiko')
  })

  it('問題集に1問しか無ければ、直前と同じでもその問題を選ぶ', () => {
    const single: ChatDeductionProblemSet = { ...ancientPeople, problems: [problemOf('himiko', '卑弥呼')] }

    expect(pickChatDeductionProblem(single, 'himiko', () => 0).id).toBe('himiko')
  })
})

describe('pickConfiguredChatDeductionProblem（トリガーの動作の設定から決める）', () => {
  const misc: ChatDeductionProblemSet = { id: 'misc', name: 'いろいろ', problems: [problemOf('mount-fuji', '富士山')] }
  const sets = [ancientPeople, misc]

  it('問題を指定していなければ、問題集から直前の問題を除いて乱数で選ぶ', () => {
    expect(pickConfiguredChatDeductionProblem(sets, { setId: 'ancient-people', problemId: null }, 'himiko', () => 0).id).toBe('shotoku-taishi')
  })

  it('問題を指定していれば、直前のゲームと同じ問題でもその問題を選ぶ（配信者が選んだ問題を差し替えない）', () => {
    expect(pickConfiguredChatDeductionProblem(sets, { setId: 'ancient-people', problemId: 'kukai' }, 'kukai', () => 0).id).toBe('kukai')
  })

  it('保存したあとで問題集・問題が消えていたら、ほかの問題で黙って始めずに投げる', () => {
    expect(() => pickConfiguredChatDeductionProblem(sets, { setId: '消えた問題集', problemId: null }, null, () => 0)).toThrowError(/消えた問題集/)
    expect(() => pickConfiguredChatDeductionProblem(sets, { setId: 'misc', problemId: 'kukai' }, null, () => 0)).toThrowError(/kukai/)
  })
})
