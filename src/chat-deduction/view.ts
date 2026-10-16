/**
 * 合成ページの素材「チャットで推理」の表示（issue #378）
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめ（board.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 上から、見出し（素材の名前・区分・参加のしかたの1行）・カードの一覧・下の帯の順に置く。カードは古いものから読む順（左上から右へ、行を下へ）に
 * 並べ、新しいものから MAX_VISIBLE_CARDS 件までを残す（並べ方の格子は chat-deduction.css が決める）。
 * - 質問のカード: 通し番号（ゲームの初めから数えた何問目か。画面から外れた質問も数える）・答え（はい・いいえ・分からない）の印と
 *   質問・答えの1文・送った人の名前。答えは色だけでなく文字でも出し、data-verdict で見た目（chat-deduction.css）を分ける
 * - 解答のカード: 正解・不正解の印と解答・送った人の名前。data-result で見た目を分け、正解のカードは目立たせる
 * 参加のしかたは開催中だけ見出しの行に出す。終えたら下の帯に「正解は○○でした」（正解者が出たら名前も）を出し、
 * 終わり方を data-end-reason で分ける。ゲームが無ければ何も出さない。
 * 終えたゲームは、終えてから ENDED_GAME_REVEAL_MS のあいだだけ映して消す（次のゲームまで画面に残し続けないため）。
 *
 * 注意: 変わっていないカードの要素は作り直さない（ゲームとカードの種類・IDごとに使い回す）。作り直すと、出現のアニメーションが
 * 新しいカードだけでなく全部のカードで走ってしまう。使い回すカードも、通し番号だけは届くたびに付け直す。
 * 注意: 消す時刻は Worker が決めた終えた時刻（endedAt）と、この端末の時計から決める。時計が数秒ずれていれば、映す長さも数秒ずれる。
 */
import { categoryLabelOf } from './category'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard, ChatDeductionVerdict } from './board'

/** 並べるカードの数。質問と返事が2行ずつに折り返しても、画面いっぱいの格子（src/chat-deduction/chat-deduction.css の3列×4行）に収まる数にする */
export const MAX_VISIBLE_CARDS = 12

/** 終えたゲームの正解を映しておく長さ（ミリ秒）。過ぎたら板ごと消す */
export const ENDED_GAME_REVEAL_MS = 60_000

/** 見出しの素材の名前 */
const TITLE = 'チャットで推理'

/** 開催中に出す参加のしかた。報酬の名前（worker/chat-deduction-rewards.ts）と合わせる */
const HINT = 'チャンネルポイントの「質問」で はい／いいえ を聞いて、「解答」で当てよう'

const VERDICT_LABELS: Readonly<Record<ChatDeductionVerdict, string>> = {
  yes: 'はい',
  no: 'いいえ',
  unknown: '分からない',
}

export interface ChatDeductionViewOptions {
  /** 終えたゲームを ENDED_GAME_REVEAL_MS ののちに消すか。プレビューのサンプル（終えた時刻が固定）では消さない */
  readonly hideEndedGame: boolean
}

export interface ChatDeductionView {
  /** 映すゲームとカードを置き換える */
  setBoard(board: Pick<ChatDeductionBoard, 'game' | 'cards'>): void
}

/** 決まった class を持つ要素を作る */
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag)
  created.className = className
  if (text !== undefined) created.textContent = text
  return created
}

/** 一覧に並べる1件。質問には通し番号（何問目か）を添え、解答は null にする */
interface NumberedCard {
  readonly card: ChatDeductionCard
  readonly number: number | null
}

/** 届いた順のカードに、質問だけを数えた通し番号を付ける（画面から外れる古い質問も数えるため、切り出す前に数える） */
const numberCards = (cards: readonly ChatDeductionCard[]): NumberedCard[] => {
  let questions = 0
  return cards.map((card) => ({ card, number: card.kind === 'question' ? ++questions : null }))
}

/**
 * カード1枚の要素を作る。上の行に答え（正誤）の印・通し番号・送った人の名前、その下に質問（解答）と答えの1文を置く。
 * 印を上の行に置くのは、3列に並べたときに本文の幅をカードいっぱいに使うため。
 */
const createCard = ({ card, number }: NumberedCard): HTMLLIElement => {
  const item = element('li', 'chat-deduction-card')
  item.dataset.kind = card.kind
  const meta = element('div', 'chat-deduction-meta')
  const badge = card.kind === 'question' ? VERDICT_LABELS[card.verdict] : card.correct ? '正解' : '不正解'
  meta.append(element('span', 'chat-deduction-badge', badge))
  if (number !== null) meta.append(element('span', 'chat-deduction-number', `Q${number}`))
  meta.append(element('span', 'chat-deduction-name', card.userName))
  item.append(meta, element('span', 'chat-deduction-text', card.text))
  if (card.kind === 'question') {
    item.dataset.verdict = card.verdict
    item.append(element('span', 'chat-deduction-reply', card.reply))
  } else {
    item.dataset.result = card.correct ? 'correct' : 'wrong'
  }
  return item
}

/** カードを使い回すための鍵。ゲームが替われば同じIDでも別のカードにする */
const keyOf = (game: ChatDeductionBoardGame, card: ChatDeductionCard): string => `${game.id}:${card.kind}:${card.id}`

/**
 * 表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-chat-deduction] の要素）
 * @param options 終えたゲームを消すか（既定は消す）
 */
export const createChatDeductionView = (root: HTMLElement, { hideEndedGame }: ChatDeductionViewOptions = { hideEndedGame: true }): ChatDeductionView => {
  const board = element('div', 'chat-deduction-board')
  board.hidden = true
  const header = element('header', 'chat-deduction-header')
  const category = element('span', 'chat-deduction-category')
  const hint = element('p', 'chat-deduction-hint', HINT)
  header.append(element('span', 'chat-deduction-title', TITLE), category, hint)
  const list = element('ol', 'chat-deduction-cards')
  const result = element('div', 'chat-deduction-result')
  const answer = element('p', 'chat-deduction-answer')
  const solver = element('p', 'chat-deduction-solver')
  result.append(answer, solver)
  board.append(header, list, result)
  root.append(board)

  /** いま並べているカードの要素（鍵ごと） */
  let shown = new Map<string, HTMLLIElement>()
  /** 終えたゲームを消す予約。新しい一覧を受け取るたびに取り消して決め直す */
  let hideTimer: ReturnType<typeof setTimeout> | undefined

  /** 板を隠して、並べていたカードを捨てる */
  const clear = (): void => {
    board.hidden = true
    list.replaceChildren()
    shown = new Map()
  }

  return {
    setBoard: ({ game, cards }) => {
      clearTimeout(hideTimer)
      hideTimer = undefined
      if (game === null) {
        clear()
        return
      }
      if (hideEndedGame && game.endedAt !== null) {
        const remaining = Date.parse(game.endedAt) + ENDED_GAME_REVEAL_MS - Date.now()
        if (remaining <= 0) {
          clear()
          return
        }
        hideTimer = setTimeout(clear, remaining)
      }
      board.hidden = false
      category.textContent = `お題: ${categoryLabelOf(game.category)}`

      const next = new Map<string, HTMLLIElement>()
      const visible = numberCards(cards).slice(-MAX_VISIBLE_CARDS)
      for (const numbered of visible) {
        const key = keyOf(game, numbered.card)
        const reused = shown.get(key)
        if (reused === undefined) {
          next.set(key, createCard(numbered))
          continue
        }
        // 答えた時刻が先の質問があとから前の位置に入ると番号がずれるので、使い回すカードも番号だけは付け直す
        const number = reused.querySelector('.chat-deduction-number')
        if (number !== null && numbered.number !== null) number.textContent = `Q${numbered.number}`
        next.set(key, reused)
      }
      list.replaceChildren(...next.values())
      shown = next

      const ended = game.endedAt !== null
      hint.hidden = ended
      result.hidden = !ended
      if (game.endReason === null) delete result.dataset.endReason
      else result.dataset.endReason = game.endReason
      answer.textContent = game.answer === null ? '' : `正解は${game.answer}でした`
      const winner = cards.find((card) => card.kind === 'guess' && card.correct)
      solver.hidden = game.endReason !== 'solved' || winner === undefined
      solver.textContent = winner === undefined ? '' : `${winner.userName}さんが正解！`
    },
  }
}
