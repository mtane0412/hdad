/**
 * 合成ページの素材「チャットで推理」のサンプル（demo.ts）のテスト
 *
 * プレビュー（/overlay/ の表示領域）では、質問が増えていく様子と、正解で終わる様子を確かめたいので、次の点を確かめる（issue #378）。
 * - 開催中の場面では正解の表記を持たないこと（Worker と同じく、開催中に答えを出さない）
 * - はい・いいえ・分からないの質問と、不正解の解答がどれも出てくること（見た目の違いをプレビューで確かめられる）
 * - 最後の場面は正解者が出て終えた場面で、正解のカードと正解の表記・解説を持つこと
 */
import { describe, expect, it } from 'vitest'
import { demoChatDeductionBoards } from './demo'

describe('demoChatDeductionBoards', () => {
  it('開催中の場面では正解の表記を持たない', () => {
    for (const { game } of demoChatDeductionBoards) {
      if (game?.endedAt === null) expect(game).toMatchObject({ answer: null, explanation: null })
    }
  })

  it('はい・いいえ・分からないの質問と、不正解の解答がどれも出てくる', () => {
    const cards = demoChatDeductionBoards.flatMap((board) => board.cards)

    expect(new Set(cards.flatMap((card) => (card.kind === 'question' ? [card.verdict] : [])))).toEqual(new Set(['yes', 'no', 'unknown']))
    expect(cards.some((card) => card.kind === 'guess' && !card.correct)).toBe(true)
  })

  it('最後の場面は正解者が出て終えた場面で、正解のカードと正解の表記・解説を持つ', () => {
    const last = demoChatDeductionBoards.at(-1)

    expect(last?.game).toMatchObject({ endReason: 'solved', answer: expect.any(String), explanation: expect.any(String) })
    expect(last?.cards.some((card) => card.kind === 'guess' && card.correct)).toBe(true)
  })
})
