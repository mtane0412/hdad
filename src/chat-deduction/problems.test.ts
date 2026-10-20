/**
 * チャットで推理の問題集（problems.json）の形のテスト
 *
 * 解答の正誤は別名の一覧との照合だけで決め、質問への答えは事実メモだけを材料に LLM に作らせる（issue #375）。
 * そのため、別名か事実メモが空の問題・知らない区分・IDや別名の重複は、ここで止める。
 * 配信者は問題集（「古代史の人物」など）を選び、問題は Worker がその中から決める。
 * そのため、問題の無い問題集・問題集のIDの重複・問題集をまたいだ問題のIDの重複も、ここで止める。
 */
import { describe, expect, it } from 'vitest'
import { readChatDeductionProblemSets, readChatDeductionProblems } from './problems'
import problemSets from './problems.json'

describe('問題集（problems.json）', () => {
  it('問題集の一覧として読める（区分は既知の値・別名と事実メモは空でない・IDの重複なし）', () => {
    expect(() => readChatDeductionProblemSets(problemSets)).not.toThrow()
  })

  it('1つ以上の問題集がある（ページで問題集を選べる）', () => {
    expect(readChatDeductionProblemSets(problemSets).length).toBeGreaterThan(0)
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

describe('readChatDeductionProblemSets', () => {
  const fuji = { id: 'mount-fuji', category: 'place', answer: '富士山', aliases: ['富士山'], facts: ['日本でいちばん高い山。'] }
  const himiko = { id: 'himiko', category: 'person', answer: '卑弥呼', aliases: ['卑弥呼'], facts: ['3世紀前半の倭の女王。'] }
  const misc = { id: 'misc', name: 'いろいろ', problems: [fuji] }
  const ancientPeople = { id: 'ancient-people', name: '古代史の人物', problems: [himiko] }

  it('ID・名前・問題の一覧を持つ問題集を読む', () => {
    expect(readChatDeductionProblemSets([ancientPeople, misc])).toEqual([ancientPeople, misc])
  })

  it('時代などの括り（例: 古代史）を持つ問題集は、括りも読む（お題を「古代史の人物」と出すため）', () => {
    expect(readChatDeductionProblemSets([{ ...ancientPeople, topic: '古代史' }])).toEqual([{ ...ancientPeople, topic: '古代史' }])
  })

  it('括りが空や文字列以外なら投げる（黙って括りなしにしない）', () => {
    expect(() => readChatDeductionProblemSets([{ ...ancientPeople, topic: '' }])).toThrowError(/0番目（ancient-people）.*括り/)
    expect(() => readChatDeductionProblemSets([{ ...ancientPeople, topic: 1 }])).toThrowError(/0番目（ancient-people）.*括り/)
  })

  it('問題集のIDが英小文字・数字・ハイフン以外を含むなら投げる（経路の本文にそのまま載せるため）', () => {
    expect(() => readChatDeductionProblemSets([{ ...misc, id: 'いろいろ' }])).toThrowError(/0番目.*ID/)
  })

  it('問題集の名前が空なら投げる（選ぶ欄に出せないため）', () => {
    expect(() => readChatDeductionProblemSets([{ ...misc, name: '' }])).toThrowError(/0番目（misc）.*名前/)
  })

  it('問題が1つも無い問題集なら投げる（選んでも出題できないため）', () => {
    expect(() => readChatDeductionProblemSets([{ ...misc, problems: [] }])).toThrowError(/0番目（misc）.*問題/)
  })

  it('問題の形が違えば、どの問題集の何番目の問題かを添えて投げる', () => {
    expect(() => readChatDeductionProblemSets([{ ...misc, problems: [{ ...fuji, answer: '' }] }])).toThrowError(/misc.*0番目（mount-fuji）.*正解/)
  })

  it('同じIDの問題集が2つあれば投げる', () => {
    expect(() => readChatDeductionProblemSets([misc, { ...ancientPeople, id: 'misc' }])).toThrowError(/1番目（misc）.*重複/)
  })

  it('問題集をまたいで同じIDの問題があれば投げる（ゲームの行は問題のIDだけを持つため）', () => {
    expect(() => readChatDeductionProblemSets([misc, { ...ancientPeople, problems: [{ ...himiko, id: 'mount-fuji' }] }])).toThrowError(/mount-fuji.*重複/)
  })

  it('配列でなければ投げる', () => {
    expect(() => readChatDeductionProblemSets({})).toThrowError(/配列/)
  })
})
