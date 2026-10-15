// @vitest-environment jsdom
/**
 * 合成ページの素材「チャットで推理」の表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の点を確かめる（issue #378）。
 * - 区分を見出しに出し、カードを新しい順に並べること（古いカードは MAX_VISIBLE_CARDS 件を超えたら出さない）
 * - 質問のカードは答え（はい・いいえ・分からない）を文字と data-verdict で分け、送った人の名前と1文を添えること
 * - 解答のカードは正解と不正解を文字と data-result で分けること（正解のカードは別の見た目にする）
 * - 開催中は参加のしかたを出し、終えたら「正解は○○でした」を出すこと（正解者が出たら名前も添える）
 * - ゲームが無ければ何も出さないこと
 * - 変わっていないカードの要素は作り直さないこと（作り直すと出現のアニメーションが全部のカードで走る）
 * - 終えたゲームは、終えてから ENDED_GAME_REVEAL_MS のあいだだけ映し、そのあとは消すこと（プレビューのサンプルでは消さない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard } from './board'
import { ENDED_GAME_REVEAL_MS, MAX_VISIBLE_CARDS, createChatDeductionView } from './view'

const openGame: ChatDeductionBoardGame = { id: 1, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null }

const yesCard: ChatDeductionCard = { kind: 'question', id: 1, userName: '田中太郎', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' }
const noCard: ChatDeductionCard = { kind: 'question', id: 2, userName: '鈴木花子', text: '生き物ですか？', verdict: 'no', reply: '生き物ではありません。' }
const wrongCard: ChatDeductionCard = { kind: 'guess', id: 1, userName: '佐藤一郎', text: '阿蘇山', correct: false }
const correctCard: ChatDeductionCard = { kind: 'guess', id: 2, userName: '田中太郎', text: '富士山', correct: true }

/** 終えたゲームの見た目だけを確かめるテストでは、いまの時計で消えないよう消さない設定にする（消す動きは「終えたゲームを消す」で確かめる） */
const KEEP_ENDED_GAME = { hideEndedGame: false }

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

const cardsOf = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.chat-deduction-card')]
const textOf = (selector: string): string | null | undefined => root.querySelector(selector)?.textContent

describe('createChatDeductionView', () => {
  it('区分を見出しに出し、カードを新しい順に並べる', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [yesCard, noCard, wrongCard] })

    expect(textOf('.chat-deduction-category')).toContain('場所')
    expect(cardsOf().map((card) => card.querySelector('.chat-deduction-text')?.textContent)).toEqual(['阿蘇山', '生き物ですか？', '日本にありますか？'])
  })

  it('質問のカードは、答えを文字と data-verdict で分け、送った人の名前と1文を添える', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [yesCard, noCard, { ...yesCard, id: 3, verdict: 'unknown', reply: 'メモにはありません。' }] })

    const [unknown, no, yes] = cardsOf()
    expect(yes?.dataset.verdict).toBe('yes')
    expect(yes?.querySelector('.chat-deduction-badge')?.textContent).toBe('はい')
    expect(yes?.querySelector('.chat-deduction-reply')?.textContent).toBe('静岡県と山梨県にまたがっています。')
    expect(yes?.querySelector('.chat-deduction-name')?.textContent).toBe('田中太郎')
    expect(no?.dataset.verdict).toBe('no')
    expect(no?.querySelector('.chat-deduction-badge')?.textContent).toBe('いいえ')
    expect(unknown?.dataset.verdict).toBe('unknown')
    expect(unknown?.querySelector('.chat-deduction-badge')?.textContent).toBe('分からない')
  })

  it('解答のカードは、正解と不正解を文字と data-result で分ける', () => {
    const view = createChatDeductionView(root, KEEP_ENDED_GAME)

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' }, cards: [wrongCard, correctCard] })

    const [correct, wrong] = cardsOf()
    expect(correct?.dataset.result).toBe('correct')
    expect(correct?.querySelector('.chat-deduction-badge')?.textContent).toBe('正解')
    expect(wrong?.dataset.result).toBe('wrong')
    expect(wrong?.querySelector('.chat-deduction-badge')?.textContent).toBe('不正解')
  })

  it(`カードは新しいものから ${MAX_VISIBLE_CARDS} 件まで出す`, () => {
    const view = createChatDeductionView(root)
    const many = Array.from({ length: MAX_VISIBLE_CARDS + 2 }, (_, index): ChatDeductionCard => ({ ...yesCard, id: index + 1, text: `質問${index + 1}` }))

    view.setBoard({ game: openGame, cards: many })

    expect(cardsOf()).toHaveLength(MAX_VISIBLE_CARDS)
    expect(cardsOf()[0]?.querySelector('.chat-deduction-text')?.textContent).toBe(`質問${MAX_VISIBLE_CARDS + 2}`)
  })

  it('開催中は参加のしかたを出し、正解は出さない', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-hint')?.hidden).toBe(false)
    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.hidden).toBe(true)
  })

  it('正解者が出て終えたら、「正解は○○でした」と正解者の名前を出し、参加のしかたは隠す', () => {
    const view = createChatDeductionView(root, KEEP_ENDED_GAME)

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' }, cards: [wrongCard, correctCard] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.hidden).toBe(false)
    expect(textOf('.chat-deduction-answer')).toBe('正解は富士山でした')
    expect(textOf('.chat-deduction-solver')).toBe('田中太郎さんが正解！')
    expect(root.querySelector<HTMLElement>('.chat-deduction-hint')?.hidden).toBe(true)
  })

  it('配信者が打ち切って終えたら、「正解は○○でした」だけを出す', () => {
    const view = createChatDeductionView(root, KEEP_ENDED_GAME)

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'stopped', answer: '富士山' }, cards: [wrongCard] })

    expect(textOf('.chat-deduction-answer')).toBe('正解は富士山でした')
    expect(root.querySelector<HTMLElement>('.chat-deduction-solver')?.hidden).toBe(true)
  })

  it('ゲームが無ければ何も出さない', () => {
    const view = createChatDeductionView(root)
    view.setBoard({ game: openGame, cards: [yesCard] })

    view.setBoard({ game: null, cards: [] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-board')?.hidden).toBe(true)
  })

  it('変わっていないカードの要素は作り直さない', () => {
    const view = createChatDeductionView(root)
    const board: ChatDeductionBoard = { game: openGame, cards: [yesCard] }
    view.setBoard(board)
    const before = cardsOf()[0]

    view.setBoard({ ...board, cards: [yesCard, wrongCard] })

    expect(cardsOf()[1]).toBe(before)
  })

  it('次のゲームでは、IDが同じでも前のゲームのカードを使い回さない', () => {
    const view = createChatDeductionView(root)
    view.setBoard({ game: openGame, cards: [yesCard] })
    const before = cardsOf()[0]

    view.setBoard({ game: { ...openGame, id: 2 }, cards: [yesCard] })

    expect(cardsOf()[0]).not.toBe(before)
  })

  describe('終えたゲームを消す', () => {
    /** 正解者が出て 12:05 に終えたゲーム */
    const solvedGame: ChatDeductionBoardGame = { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' }
    const endedAtMs = Date.parse('2026-10-15T12:05:00.000Z')
    const boardElement = (): HTMLElement | null => root.querySelector<HTMLElement>('.chat-deduction-board')

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('終えた直後は正解を映し、終えてから ENDED_GAME_REVEAL_MS たったら消す', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })
      expect(boardElement()?.hidden).toBe(false)

      vi.advanceTimersByTime(ENDED_GAME_REVEAL_MS - 1)
      expect(boardElement()?.hidden).toBe(false)

      vi.advanceTimersByTime(1)
      expect(boardElement()?.hidden).toBe(true)
    })

    it('開き直したときにもう ENDED_GAME_REVEAL_MS を過ぎていれば、最初から映さない', () => {
      vi.setSystemTime(endedAtMs + ENDED_GAME_REVEAL_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(boardElement()?.hidden).toBe(true)
    })

    it('消す前に次のゲームが始まったら、次のゲームは消さない', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)
      view.setBoard({ game: solvedGame, cards: [correctCard] })

      view.setBoard({ game: { ...openGame, id: 2 }, cards: [] })
      vi.advanceTimersByTime(ENDED_GAME_REVEAL_MS)

      expect(boardElement()?.hidden).toBe(false)
    })

    it('プレビューのサンプルでは、終えたゲームを消さない', () => {
      vi.setSystemTime(endedAtMs + ENDED_GAME_REVEAL_MS)
      const view = createChatDeductionView(root, { hideEndedGame: false })

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(boardElement()?.hidden).toBe(false)
    })
  })
})
