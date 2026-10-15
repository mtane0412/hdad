/**
 * 合成ページの素材「チャットで推理」の表示（issue #378）
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめ（board.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 上から、見出し（区分）・カードの一覧・下の帯の順に置く。カードは新しいものを上にして MAX_VISIBLE_CARDS 件まで並べる。
 * - 質問のカード: 答え（はい・いいえ・分からない）の印と質問・答えの1文・送った人の名前。答えは色だけでなく文字でも出し、
 *   data-verdict で見た目（chat-deduction.css）を分ける
 * - 解答のカード: 正解・不正解の印と解答・送った人の名前。data-result で見た目を分け、正解のカードは目立たせる
 * 下の帯は、開催中は参加のしかた、終えたら「正解は○○でした」（正解者が出たら名前も）を出す。ゲームが無ければ何も出さない。
 *
 * 注意: 変わっていないカードの要素は作り直さない（ゲームとカードの種類・IDごとに使い回す）。作り直すと、出現のアニメーションが
 * 新しいカードだけでなく全部のカードで走ってしまう。
 */
import { categoryLabelOf } from './category'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard, ChatDeductionVerdict } from './board'

/** 並べるカードの数。返事が2行に折り返しても、中央の板（src/chat-deduction/chat-deduction.css）に収まる数にする */
export const MAX_VISIBLE_CARDS = 5

/** 見出しの素材の名前 */
const TITLE = 'チャットで推理'

/** 開催中に出す参加のしかた。報酬の名前（worker/chat-deduction-rewards.ts）と合わせる */
const HINT = 'チャンネルポイントの「質問」で はい／いいえ を聞いて、「解答」で当てよう'

const VERDICT_LABELS: Readonly<Record<ChatDeductionVerdict, string>> = {
  yes: 'はい',
  no: 'いいえ',
  unknown: '分からない',
}

export interface ChatDeductionView {
  /** 映すゲームとカードを置き換える */
  setBoard(board: ChatDeductionBoard): void
}

/** 決まった class を持つ要素を作る */
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag)
  created.className = className
  if (text !== undefined) created.textContent = text
  return created
}

/** カード1枚の要素を作る */
const createCard = (card: ChatDeductionCard): HTMLLIElement => {
  const item = element('li', 'chat-deduction-card')
  item.dataset.kind = card.kind
  const body = element('div', 'chat-deduction-body')
  body.append(element('span', 'chat-deduction-text', card.text))
  if (card.kind === 'question') {
    item.dataset.verdict = card.verdict
    body.append(element('span', 'chat-deduction-reply', card.reply))
    item.append(element('span', 'chat-deduction-badge', VERDICT_LABELS[card.verdict]), body)
  } else {
    item.dataset.result = card.correct ? 'correct' : 'wrong'
    item.append(element('span', 'chat-deduction-badge', card.correct ? '正解' : '不正解'), body)
  }
  item.append(element('span', 'chat-deduction-name', card.userName))
  return item
}

/** カードを使い回すための鍵。ゲームが替われば同じIDでも別のカードにする */
const keyOf = (game: ChatDeductionBoardGame, card: ChatDeductionCard): string => `${game.id}:${card.kind}:${card.id}`

/**
 * 表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-chat-deduction] の要素）
 */
export const createChatDeductionView = (root: HTMLElement): ChatDeductionView => {
  const board = element('div', 'chat-deduction-board')
  board.hidden = true
  const header = element('header', 'chat-deduction-header')
  const category = element('span', 'chat-deduction-category')
  header.append(element('span', 'chat-deduction-title', TITLE), category)
  const list = element('ol', 'chat-deduction-cards')
  const hint = element('p', 'chat-deduction-hint', HINT)
  const result = element('div', 'chat-deduction-result')
  const answer = element('p', 'chat-deduction-answer')
  const solver = element('p', 'chat-deduction-solver')
  result.append(answer, solver)
  board.append(header, list, hint, result)
  root.append(board)

  /** いま並べているカードの要素（鍵ごと） */
  let shown = new Map<string, HTMLLIElement>()

  return {
    setBoard: ({ game, cards }) => {
      board.hidden = game === null
      if (game === null) {
        list.replaceChildren()
        shown = new Map()
        return
      }
      category.textContent = `お題: ${categoryLabelOf(game.category)}`

      const next = new Map<string, HTMLLIElement>()
      const visible = cards.slice(-MAX_VISIBLE_CARDS).reverse()
      for (const card of visible) {
        const key = keyOf(game, card)
        next.set(key, shown.get(key) ?? createCard(card))
      }
      list.replaceChildren(...next.values())
      shown = next

      const ended = game.endedAt !== null
      hint.hidden = ended
      result.hidden = !ended
      answer.textContent = game.answer === null ? '' : `正解は${game.answer}でした`
      const winner = cards.find((card) => card.kind === 'guess' && card.correct)
      solver.hidden = game.endReason !== 'solved' || winner === undefined
      solver.textContent = winner === undefined ? '' : `${winner.userName}さんが正解！`
    },
  }
}
