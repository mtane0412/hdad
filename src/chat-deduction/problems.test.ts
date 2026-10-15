/**
 * チャットで推理の問題集（problems.json）の形のテスト
 *
 * 解答の正誤は別名の一覧との照合だけで決め、質問への答えは事実メモだけを材料に LLM に作らせる（issue #375）。
 * そのため、別名か事実メモが空の問題・知らない区分・IDや別名の重複は、ここで止める。
 */
import { describe, expect, it } from 'vitest'
import { readChatDeductionProblems } from './problems'
import problems from './problems.json'

describe('問題集（problems.json）', () => {
  it('問題集として読める（区分は既知の値・別名と事実メモは空でない・IDの重複なし）', () => {
    expect(() => readChatDeductionProblems(problems)).not.toThrow()
  })

  it('1問以上ある（ページで問題を選べる）', () => {
    expect(readChatDeductionProblems(problems).length).toBeGreaterThan(0)
  })
})

describe('readChatDeductionProblems', () => {
  const valid = {
    id: 'mount-fuji',
    category: 'place',
    answer: '富士山',
    aliases: ['富士山', 'ふじさん', 'フジヤマ'],
    facts: ['静岡県と山梨県にまたがる山。', '標高は3776メートルで、日本でいちばん高い。'],
  }

  it('ID・区分・正解・別名・事実メモを持つ問題を読む', () => {
    const person = { id: 'natsume-soseki', category: 'person', answer: '夏目漱石', aliases: ['夏目漱石', '漱石'], facts: ['明治から大正にかけての小説家。'] }

    expect(readChatDeductionProblems([valid, person])).toEqual([valid, person])
  })

  it('知らない区分（「場所」のような画面の言い方も）なら、何番目のどの問題かを添えて投げる', () => {
    expect(() => readChatDeductionProblems([{ ...valid, category: '場所' }])).toThrowError(/0番目（mount-fuji）.*区分/)
  })

  it('IDが英小文字・数字・ハイフン以外を含む・空なら投げる（URLやD1の行にそのまま載せるため）', () => {
    expect(() => readChatDeductionProblems([{ ...valid, id: '富士山' }])).toThrowError(/ID/)
    expect(() => readChatDeductionProblems([{ ...valid, id: '' }])).toThrowError(/ID/)
  })

  it('正解が空なら投げる', () => {
    expect(() => readChatDeductionProblems([{ ...valid, answer: '' }])).toThrowError(/正解/)
  })

  it('別名が1つも無い・空の別名がある・同じ別名が2回あるなら投げる（正しく答えても不正解になるのを防ぐ）', () => {
    expect(() => readChatDeductionProblems([{ ...valid, aliases: [] }])).toThrowError(/別名/)
    expect(() => readChatDeductionProblems([{ ...valid, aliases: ['富士山', ''] }])).toThrowError(/別名/)
    expect(() => readChatDeductionProblems([{ ...valid, aliases: ['富士山', '富士山'] }])).toThrowError(/別名/)
  })

  it('事実メモが1つも無い・空のメモがあるなら投げる（LLM が答える材料が無くなるため）', () => {
    expect(() => readChatDeductionProblems([{ ...valid, facts: [] }])).toThrowError(/事実メモ/)
    expect(() => readChatDeductionProblems([{ ...valid, facts: [''] }])).toThrowError(/事実メモ/)
  })

  it('同じIDが2問あれば、2問目の位置を添えて投げる', () => {
    expect(() => readChatDeductionProblems([valid, { ...valid, answer: '富士' }])).toThrowError(/1番目（mount-fuji）.*重複/)
  })

  it('配列でなければ投げる', () => {
    expect(() => readChatDeductionProblems({})).toThrowError(/配列/)
  })
})
