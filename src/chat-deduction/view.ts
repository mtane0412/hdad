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
 * 参加のしかたは開催中だけ見出しの行に出す。終えたら下の帯に「正解は○○でした」（正解者が出たら名前も、制限時間が尽きたら「時間切れ！」も）を出し、
 * 終わり方を data-end-reason で分ける。ゲームが無ければ何も出さない。
 * 制限時間のある開催中のゲームでは、見出しに締め切り（closesAt）までの残り時間を出し、REMAINING_TICK_MS ごとに書き直す。
 * 終えてから EXPLANATION_DELAY_MS たったら、カードの格子を隠してその場所に正解の解説を出す（まず正解の帯と正解のカードを
 * 見せてから、答えについての知識を残すため。正解の帯は解説のあいだも残す）。解説に画像（Wikipedia の記事の代表画像）があれば、
 * 作者とライセンスを添えて解説の左に出す。読み込めなければ画像を外し、onImageError で知らせる（解説は出したまま）。
 * 終えたゲームは、終えてから ENDED_REVEAL_MS のあいだだけ映して消す（次のゲームまで画面に残し続けないため）。
 * 下部バーの「演出を消す」を受けたら、終えたゲームを待たずに消す（開催中のゲームは消さない）。
 *
 * 注意: 変わっていないカードの要素は作り直さない（ゲームとカードの種類・IDごとに使い回す）。作り直すと、出現のアニメーションが
 * 新しいカードだけでなく全部のカードで走ってしまう。使い回すカードも、通し番号だけは届くたびに付け直す。
 * 注意: 消す時刻は Worker が決めた終えた時刻（endedAt）と、この端末の時計から決める。時計が数秒ずれていれば、映す長さも数秒ずれる。
 * 注意: 残り時間は締め切りとこの端末の時計から出すだけで、自分の時計では終えない。締め切りを過ぎても Worker から時間切れで
 *   終えた一覧が届くまでは、残り 0:00 のまま開催中として映す（終えるかどうかを決めるのは Worker のアラームである）。
 */
import { ENDED_REVEAL_MS } from '../core/ended-reveal'
import { subjectLabelOf } from './category'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard, ChatDeductionVerdict } from './board'
import type { ChatDeductionImage } from './images'
import { formatChatDeductionRemaining } from './time-limit'

/** 並べるカードの数。質問と返事が2行ずつに折り返しても、画面いっぱいの格子（src/chat-deduction/chat-deduction.css の3列×4行）に収まる数にする */
export const MAX_VISIBLE_CARDS = 12

/** 終えてから解説を出すまでの長さ（ミリ秒）。そのあいだは正解の帯と正解のカードを見せる */
export const EXPLANATION_DELAY_MS = 5_000

/** 残り時間を書き直す間隔（ミリ秒） */
const REMAINING_TICK_MS = 1_000

/** 制限時間が尽きて終えたときに、正解の帯に添える言葉 */
const TIMEOUT_LABEL = '時間切れ！'

/** 見出しの素材の名前 */
const TITLE = 'チャットで推理'

/** 開催中に出す参加のしかた。報酬の名前（worker/chat-deduction-rewards.ts）と合わせる */
const HINT = 'チャンネルポイントの「質問」で はい／いいえ を聞いて、「解答」で当てよう'

/** 解説の板の見出し */
const EXPLANATION_HEADING = '解説'

const VERDICT_LABELS: Readonly<Record<ChatDeductionVerdict, string>> = {
  yes: 'はい',
  no: 'いいえ',
  unknown: '分からない',
}

export interface ChatDeductionViewOptions {
  /** 終えたゲームを ENDED_REVEAL_MS ののちに消すか。プレビューのサンプル（終えた時刻が固定）では消さない */
  readonly hideEndedGame: boolean
  /** 解説の画像を読み込めなかった。渡さなければ、失敗を投げて黙らせない（合成ページは素材の箱に出す） */
  readonly onImageError?: (error: Error) => void
}

export interface ChatDeductionView {
  /** 映すゲームとカードを置き換える */
  setBoard(board: Pick<ChatDeductionBoard, 'game' | 'cards'>): void
  /**
   * 下部バーの「演出を消す」を受けた。映しているゲームを終えていれば、ENDED_REVEAL_MS を待たずに消し、
   * そのゲームは読み直しで届いても映さない（次のゲームが始まれば映す）。開催中のゲームは消さない。
   */
  dismiss(): void
}

/** 画像に添える出典（作者の表記が要らない画像で作者が空なら、ライセンスだけ） */
const creditOf = ({ artist, license }: ChatDeductionImage): string => `画像: ${artist === '' ? license : `${artist} / ${license}`}（Wikimedia Commons）`

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
export const createChatDeductionView = (
  root: HTMLElement,
  {
    hideEndedGame,
    onImageError = (error) => {
      throw error
    },
  }: ChatDeductionViewOptions = { hideEndedGame: true },
): ChatDeductionView => {
  const board = element('div', 'chat-deduction-board')
  board.hidden = true
  const header = element('header', 'chat-deduction-header')
  const category = element('span', 'chat-deduction-category')
  const remaining = element('span', 'chat-deduction-remaining')
  remaining.hidden = true
  const hint = element('p', 'chat-deduction-hint', HINT)
  header.append(element('span', 'chat-deduction-title', TITLE), category, remaining, hint)
  const list = element('ol', 'chat-deduction-cards')
  const result = element('div', 'chat-deduction-result')
  const answer = element('p', 'chat-deduction-answer')
  const solver = element('p', 'chat-deduction-solver')
  result.append(answer, solver)
  const explanation = element('section', 'chat-deduction-explanation')
  explanation.hidden = true
  const explanationText = element('p', 'chat-deduction-explanation-text')
  const figure = element('figure', 'chat-deduction-explanation-figure')
  figure.hidden = true
  const credit = element('figcaption', 'chat-deduction-explanation-credit')
  figure.append(credit)
  const explanationBody = element('div', 'chat-deduction-explanation-body')
  explanationBody.append(figure, explanationText)
  explanation.append(element('h2', 'chat-deduction-explanation-heading', EXPLANATION_HEADING), explanationBody)
  board.append(header, list, explanation, result)
  root.append(board)

  /** いま並べているカードの要素（鍵ごと） */
  let shown = new Map<string, HTMLLIElement>()
  /** 終えたゲームを消す予約。新しい一覧を受け取るたびに取り消して決め直す */
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  /** 解説を出す予約。新しい一覧を受け取るたびに取り消して決め直す */
  let explanationTimer: ReturnType<typeof setTimeout> | undefined
  /** 残り時間を書き直す刻み。新しい一覧を受け取るたびに止めて決め直す */
  let remainingTimer: ReturnType<typeof setInterval> | undefined
  /** 最後に受け取ったゲーム。「演出を消す」を受けたときに、終えたゲームかを見るために使う */
  let currentGame: ChatDeductionBoardGame | null = null
  /** 「演出を消す」で消した、終えたゲームのID。消していなければ null */
  let dismissedGameId: number | null = null

  /** いま置いている画像の URL。読み直しで同じ画像が届いたら要素を作り直さない（読み込み直しでちらつかせない） */
  let shownImageUrl: string | null = null

  /** 解説の画像を置き換える。画像が無ければ外す */
  const setImage = (image: ChatDeductionImage | null, answerLabel: string): void => {
    if (image?.url === shownImageUrl) return
    figure.querySelector('img')?.remove()
    shownImageUrl = image?.url ?? null
    figure.hidden = image === null
    if (image === null) return
    const img = element('img', 'chat-deduction-explanation-image')
    img.alt = `${answerLabel}の画像`
    img.addEventListener('error', () => {
      figure.hidden = true
      onImageError(new Error(`チャットで推理の解説の画像を読み込めませんでした: ${image.url}`))
    })
    img.src = image.url
    figure.prepend(img)
    credit.textContent = creditOf(image)
  }

  /** 解説を出すか（出すあいだはカードの格子を隠す） */
  const showExplanation = (shown: boolean): void => {
    explanation.hidden = !shown
    list.hidden = shown
  }

  /** 締め切りまでの残り時間を出し、刻みで書き直す。締め切りが無い（制限時間なし・終えたゲーム）なら隠して止める */
  const showRemaining = (closesAt: string | null): void => {
    clearInterval(remainingTimer)
    remainingTimer = undefined
    remaining.hidden = closesAt === null
    if (closesAt === null) return
    const closesAtMs = Date.parse(closesAt)
    const render = (): void => {
      remaining.textContent = `残り ${formatChatDeductionRemaining(closesAtMs - Date.now())}`
    }
    render()
    remainingTimer = setInterval(render, REMAINING_TICK_MS)
  }

  /** 板を隠して、並べていたカードを捨てる */
  const clear = (): void => {
    showRemaining(null)
    clearTimeout(explanationTimer)
    explanationTimer = undefined
    showExplanation(false)
    setImage(null, '')
    board.hidden = true
    list.replaceChildren()
    shown = new Map()
  }

  return {
    setBoard: ({ game, cards }) => {
      clearTimeout(hideTimer)
      hideTimer = undefined
      clearTimeout(explanationTimer)
      explanationTimer = undefined
      showExplanation(false)
      currentGame = game
      if (game === null || (game.endedAt !== null && game.id === dismissedGameId)) {
        clear()
        return
      }
      if (hideEndedGame && game.endedAt !== null) {
        const remaining = Date.parse(game.endedAt) + ENDED_REVEAL_MS - Date.now()
        if (remaining <= 0) {
          clear()
          return
        }
        hideTimer = setTimeout(clear, remaining)
      }
      board.hidden = false
      category.textContent = `お題: ${subjectLabelOf(game.category, game.topic)}`

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
      showRemaining(ended ? null : game.closesAt)
      hint.hidden = ended
      result.hidden = !ended
      if (game.endReason === null) delete result.dataset.endReason
      else result.dataset.endReason = game.endReason
      answer.textContent = game.answer === null ? '' : `正解は${game.answer}でした`
      const winner = cards.find((card) => card.kind === 'guess' && card.correct)
      if (game.endReason === 'timeout') {
        solver.hidden = false
        solver.textContent = TIMEOUT_LABEL
      } else {
        solver.hidden = game.endReason !== 'solved' || winner === undefined
        solver.textContent = winner === undefined ? '' : `${winner.userName}さんが正解！`
      }

      explanationText.textContent = game.explanation ?? ''
      setImage(game.image, game.answer ?? '')
      if (game.endedAt !== null && game.explanation !== null) {
        const untilExplanation = Date.parse(game.endedAt) + EXPLANATION_DELAY_MS - Date.now()
        if (untilExplanation <= 0) showExplanation(true)
        else explanationTimer = setTimeout(() => showExplanation(true), untilExplanation)
      }
    },

    dismiss: () => {
      if (currentGame === null || currentGame.endedAt === null) return
      clearTimeout(hideTimer)
      hideTimer = undefined
      dismissedGameId = currentGame.id
      clear()
    },
  }
}
