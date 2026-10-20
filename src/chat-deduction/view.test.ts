// @vitest-environment jsdom
/**
 * 合成ページの素材「チャットで推理」の表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の点を確かめる（issue #378）。
 * - 区分を見出しに出し、カードを古い順（読む順）に並べること（古いカードは MAX_VISIBLE_CARDS 件を超えたら出さない）
 * - 質問のカードには、ゲームの初めから数えた通し番号を付けること（解答のカードには付けない）
 * - 質問のカードは答え（はい・いいえ・分からない）を文字と data-verdict で分け、送った人の名前と1文を添えること
 * - 解答のカードは正解と不正解を文字と data-result で分けること（正解のカードは別の見た目にする）
 * - 開催中は参加のしかたを出し、終えたら「正解は○○でした」を出すこと（正解者が出たら名前も添え、終わり方を data-end-reason で分ける）
 * - ゲームが無ければ何も出さないこと
 * - 変わっていないカードの要素は作り直さないこと（作り直すと出現のアニメーションが全部のカードで走る）
 * - 終えたゲームは、終えてから ENDED_REVEAL_MS のあいだだけ映し、そのあとは消すこと（プレビューのサンプルでは消さない）
 * - 下部バーの「演出を消す」を受けたら、終えたゲームを待たずに消すこと（開催中のゲームは消さない）
 * - 終えてから EXPLANATION_DELAY_MS たったら、カードの格子の代わりに正解の解説を出すこと（まず正解の帯とカードを見せるため）
 * - 解説に画像があれば、作者とライセンスを添えて解説の横に出すこと（読み込めなければ画像を外し、失敗を知らせる）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard } from './board'
import { ENDED_REVEAL_MS } from '../core/ended-reveal'
import { EXPLANATION_DELAY_MS, MAX_VISIBLE_CARDS, createChatDeductionView } from './view'

const openGame: ChatDeductionBoardGame = { id: 1, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null, explanation: null, image: null }

/** 富士山の問題の解説 */
const FUJI_EXPLANATION = '静岡県と山梨県にまたがる、標高3776メートルの日本でいちばん高い山。'

/** 富士山の記事の代表画像 */
const FUJI_IMAGE = { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mt.Fuji.jpg/1280px-Mt.Fuji.jpg', artist: '山田花子', license: 'CC BY-SA 4.0' }

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
  it('区分を見出しに出し、カードを古い順（読む順）に並べる', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [yesCard, noCard, wrongCard] })

    expect(textOf('.chat-deduction-category')).toContain('場所')
    expect(cardsOf().map((card) => card.querySelector('.chat-deduction-text')?.textContent)).toEqual(['日本にありますか？', '生き物ですか？', '阿蘇山'])
  })

  it('時代などの括りがある問題では、お題を括りつきで出す（例: 古代史の人物）', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: { ...openGame, category: 'person', topic: '古代史' }, cards: [] })

    expect(textOf('.chat-deduction-category')).toBe('お題: 古代史の人物')
  })

  it('質問のカードにはゲームの初めから数えた通し番号を付け、解答のカードには付けない', () => {
    const view = createChatDeductionView(root)

    // 前提: 質問・解答・質問の順に届いている
    view.setBoard({ game: openGame, cards: [yesCard, wrongCard, noCard] })

    // 検証: 解答を数えずに、質問だけが Q1・Q2 になる
    expect(cardsOf().map((card) => card.querySelector('.chat-deduction-number')?.textContent ?? null)).toEqual(['Q1', null, 'Q2'])
  })

  it('質問のカードは、答えを文字と data-verdict で分け、送った人の名前と1文を添える', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [yesCard, noCard, { ...yesCard, id: 3, verdict: 'unknown', reply: 'メモにはありません。' }] })

    const [yes, no, unknown] = cardsOf()
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

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山', explanation: FUJI_EXPLANATION, image: null }, cards: [wrongCard, correctCard] })

    const [wrong, correct] = cardsOf()
    expect(correct?.dataset.result).toBe('correct')
    expect(correct?.querySelector('.chat-deduction-badge')?.textContent).toBe('正解')
    expect(wrong?.dataset.result).toBe('wrong')
    expect(wrong?.querySelector('.chat-deduction-badge')?.textContent).toBe('不正解')
  })

  it(`カードは新しいものから ${MAX_VISIBLE_CARDS} 件まで出し、通し番号は隠れたカードも数える`, () => {
    const view = createChatDeductionView(root)
    // 前提: 並べられる数より2件多い質問が届いている
    const many = Array.from({ length: MAX_VISIBLE_CARDS + 2 }, (_, index): ChatDeductionCard => ({ ...yesCard, id: index + 1, text: `質問${index + 1}` }))

    view.setBoard({ game: openGame, cards: many })

    // 検証: 古い2件が外れ、3件目から最新までが読む順に並ぶ
    expect(cardsOf()).toHaveLength(MAX_VISIBLE_CARDS)
    expect(cardsOf()[0]?.querySelector('.chat-deduction-text')?.textContent).toBe('質問3')
    expect(cardsOf()[0]?.querySelector('.chat-deduction-number')?.textContent).toBe('Q3')
    expect(cardsOf().at(-1)?.querySelector('.chat-deduction-text')?.textContent).toBe(`質問${MAX_VISIBLE_CARDS + 2}`)
  })

  it('開催中は参加のしかたを出し、正解は出さない', () => {
    const view = createChatDeductionView(root)

    view.setBoard({ game: openGame, cards: [] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-hint')?.hidden).toBe(false)
    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.hidden).toBe(true)
  })

  it('正解者が出て終えたら、「正解は○○でした」と正解者の名前を出し、参加のしかたは隠す', () => {
    const view = createChatDeductionView(root, KEEP_ENDED_GAME)

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山', explanation: FUJI_EXPLANATION, image: null }, cards: [wrongCard, correctCard] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.hidden).toBe(false)
    expect(textOf('.chat-deduction-answer')).toBe('正解は富士山でした')
    expect(textOf('.chat-deduction-solver')).toBe('田中太郎さんが正解！')
    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.dataset.endReason).toBe('solved')
    expect(root.querySelector<HTMLElement>('.chat-deduction-hint')?.hidden).toBe(true)
  })

  it('配信者が打ち切って終えたら、「正解は○○でした」だけを出す', () => {
    const view = createChatDeductionView(root, KEEP_ENDED_GAME)

    view.setBoard({ game: { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'stopped', answer: '富士山', explanation: FUJI_EXPLANATION, image: null }, cards: [wrongCard] })

    expect(textOf('.chat-deduction-answer')).toBe('正解は富士山でした')
    expect(root.querySelector<HTMLElement>('.chat-deduction-solver')?.hidden).toBe(true)
    expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.dataset.endReason).toBe('stopped')
  })

  it('ゲームが無ければ何も出さない', () => {
    const view = createChatDeductionView(root)
    view.setBoard({ game: openGame, cards: [yesCard] })

    view.setBoard({ game: null, cards: [] })

    expect(root.querySelector<HTMLElement>('.chat-deduction-board')?.hidden).toBe(true)
  })

  it('変わっていないカードの要素は作り直さない', () => {
    const view = createChatDeductionView(root)
    const board: Pick<ChatDeductionBoard, 'game' | 'cards'> = { game: openGame, cards: [yesCard] }
    view.setBoard(board)
    const before = cardsOf()[0]

    view.setBoard({ ...board, cards: [yesCard, wrongCard] })

    expect(cardsOf()[0]).toBe(before)
  })

  it('あとから前の位置に質問が入ったら、使い回すカードの通し番号を付け直す', () => {
    const view = createChatDeductionView(root)
    // 前提: 鈴木さんの質問だけが届き、Q1 として出ている
    view.setBoard({ game: openGame, cards: [noCard] })
    const before = cardsOf()[0]

    // 答えた時刻が先だった田中さんの質問が、あとから前の位置に入った
    view.setBoard({ game: openGame, cards: [yesCard, noCard] })

    // 検証: 鈴木さんのカードは作り直さず、番号だけが Q2 になる
    expect(cardsOf()[1]).toBe(before)
    expect(cardsOf().map((card) => card.querySelector('.chat-deduction-number')?.textContent)).toEqual(['Q1', 'Q2'])
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
    const solvedGame: ChatDeductionBoardGame = { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山', explanation: FUJI_EXPLANATION, image: null }
    const endedAtMs = Date.parse('2026-10-15T12:05:00.000Z')
    const boardElement = (): HTMLElement | null => root.querySelector<HTMLElement>('.chat-deduction-board')

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('終えた直後は正解を映し、終えてから ENDED_REVEAL_MS たったら消す', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })
      expect(boardElement()?.hidden).toBe(false)

      vi.advanceTimersByTime(ENDED_REVEAL_MS - 1)
      expect(boardElement()?.hidden).toBe(false)

      vi.advanceTimersByTime(1)
      expect(boardElement()?.hidden).toBe(true)
    })

    it('開き直したときにもう ENDED_REVEAL_MS を過ぎていれば、最初から映さない', () => {
      vi.setSystemTime(endedAtMs + ENDED_REVEAL_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(boardElement()?.hidden).toBe(true)
    })

    it('消す前に次のゲームが始まったら、次のゲームは消さない', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)
      view.setBoard({ game: solvedGame, cards: [correctCard] })

      view.setBoard({ game: { ...openGame, id: 2 }, cards: [] })
      vi.advanceTimersByTime(ENDED_REVEAL_MS)

      expect(boardElement()?.hidden).toBe(false)
    })

    it('「演出を消す」を受けたら、終えたゲームを待たずに消し、読み直しで同じゲームが届いても映さない', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)
      view.setBoard({ game: solvedGame, cards: [correctCard] })

      view.dismiss()
      expect(boardElement()?.hidden).toBe(true)

      // 5分おきの読み直しで、同じ終えたゲームがまた届いた
      view.setBoard({ game: solvedGame, cards: [correctCard] })
      expect(boardElement()?.hidden).toBe(true)

      // 次のゲームが始まったら映す
      view.setBoard({ game: { ...openGame, id: 2 }, cards: [] })
      expect(boardElement()?.hidden).toBe(false)
    })

    it('「演出を消す」を受けても、開催中のゲームは消さない（視聴者が参加している最中のため）', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)
      view.setBoard({ game: openGame, cards: [yesCard] })

      view.dismiss()

      expect(boardElement()?.hidden).toBe(false)
      // 開催中に受けた合図は、そのあと終えたゲームまで消さない
      view.setBoard({ game: { ...solvedGame, id: openGame.id }, cards: [yesCard, correctCard] })
      expect(boardElement()?.hidden).toBe(false)
    })

    it('プレビューのサンプルでは、終えたゲームを消さない', () => {
      vi.setSystemTime(endedAtMs + ENDED_REVEAL_MS)
      const view = createChatDeductionView(root, { hideEndedGame: false })

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(boardElement()?.hidden).toBe(false)
    })
  })

  describe('正解の解説', () => {
    const solvedGame: ChatDeductionBoardGame = { ...openGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山', explanation: FUJI_EXPLANATION, image: null }
    const endedAtMs = Date.parse('2026-10-15T12:05:00.000Z')
    const explanationElement = (): HTMLElement | null => root.querySelector<HTMLElement>('.chat-deduction-explanation')
    const cardList = (): HTMLElement | null => root.querySelector<HTMLElement>('.chat-deduction-cards')

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('開催中は解説を出さない', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)

      view.setBoard({ game: openGame, cards: [yesCard] })
      vi.advanceTimersByTime(EXPLANATION_DELAY_MS)

      expect(explanationElement()?.hidden).toBe(true)
      expect(cardList()?.hidden).toBe(false)
    })

    it('終えた直後は正解の帯とカードを見せ、終えてから EXPLANATION_DELAY_MS たったらカードの代わりに解説を出す', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [wrongCard, correctCard] })
      expect(explanationElement()?.hidden).toBe(true)
      expect(cardList()?.hidden).toBe(false)

      vi.advanceTimersByTime(EXPLANATION_DELAY_MS - 1)
      expect(explanationElement()?.hidden).toBe(true)

      vi.advanceTimersByTime(1)
      expect(explanationElement()?.hidden).toBe(false)
      expect(textOf('.chat-deduction-explanation-text')).toBe(FUJI_EXPLANATION)
      expect(cardList()?.hidden).toBe(true)
      // 正解の帯は解説のあいだも残す
      expect(root.querySelector<HTMLElement>('.chat-deduction-result')?.hidden).toBe(false)
    })

    it('開き直したときにもう EXPLANATION_DELAY_MS を過ぎていれば、最初から解説を出す', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(explanationElement()?.hidden).toBe(false)
    })

    it('解説を出す前に次のゲームが始まったら、解説を出さない', () => {
      vi.setSystemTime(endedAtMs)
      const view = createChatDeductionView(root)
      view.setBoard({ game: solvedGame, cards: [correctCard] })

      view.setBoard({ game: { ...openGame, id: 2 }, cards: [] })
      vi.advanceTimersByTime(EXPLANATION_DELAY_MS)

      expect(explanationElement()?.hidden).toBe(true)
      expect(cardList()?.hidden).toBe(false)
    })

    it('解説を出したあとに次のゲームが始まったら、解説を隠してカードの格子に戻す', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)
      view.setBoard({ game: solvedGame, cards: [correctCard] })

      view.setBoard({ game: { ...openGame, id: 2 }, cards: [] })

      expect(explanationElement()?.hidden).toBe(true)
      expect(cardList()?.hidden).toBe(false)
    })

    it('画像があれば、作者とライセンスを添えて解説と一緒に出す', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: { ...solvedGame, image: FUJI_IMAGE }, cards: [correctCard] })

      const image = root.querySelector<HTMLImageElement>('.chat-deduction-explanation img')
      expect(image?.src).toBe(FUJI_IMAGE.url)
      // 何の画像かは見出しの正解で分かるので、読み上げには正解の名前を渡す
      expect(image?.alt).toBe('富士山の画像')
      expect(textOf('.chat-deduction-explanation-credit')).toBe('画像: 山田花子 / CC BY-SA 4.0（Wikimedia Commons）')
      expect(root.querySelector<HTMLElement>('.chat-deduction-explanation-figure')?.hidden).toBe(false)
    })

    it('作者の表記が要らない画像（パブリック・ドメインなど）で作者が空なら、ライセンスだけを添える', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: { ...solvedGame, image: { ...FUJI_IMAGE, artist: '', license: 'Public domain' } }, cards: [correctCard] })

      expect(textOf('.chat-deduction-explanation-credit')).toBe('画像: Public domain（Wikimedia Commons）')
    })

    it('画像が無ければ、解説だけを出す', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)

      view.setBoard({ game: solvedGame, cards: [correctCard] })

      expect(root.querySelector<HTMLElement>('.chat-deduction-explanation-figure')?.hidden).toBe(true)
      expect(root.querySelector('.chat-deduction-explanation img')).toBeNull()
    })

    it('画像を読み込めなければ、画像を外して失敗を知らせる（解説は出したまま）', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const onImageError = vi.fn()
      const view = createChatDeductionView(root, { hideEndedGame: true, onImageError })

      view.setBoard({ game: { ...solvedGame, image: FUJI_IMAGE }, cards: [correctCard] })
      root.querySelector<HTMLImageElement>('.chat-deduction-explanation img')?.dispatchEvent(new Event('error'))

      expect(root.querySelector<HTMLElement>('.chat-deduction-explanation-figure')?.hidden).toBe(true)
      expect(onImageError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(FUJI_IMAGE.url) }))
      expect(explanationElement()?.hidden).toBe(false)
    })

    it('同じゲームの読み直しでは、画像の要素を作り直さない（読み込み直しでちらつかせない）', () => {
      vi.setSystemTime(endedAtMs + EXPLANATION_DELAY_MS)
      const view = createChatDeductionView(root)
      const board = { game: { ...solvedGame, image: FUJI_IMAGE }, cards: [correctCard] }

      view.setBoard(board)
      const first = root.querySelector('.chat-deduction-explanation img')
      view.setBoard(board)

      expect(root.querySelector('.chat-deduction-explanation img')).toBe(first)
    })
  })
})
