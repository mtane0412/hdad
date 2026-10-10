/**
 * 意見ボードの表示
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめと紹介する意見の選び方
 * （entry.ts）・起動（src/overlay/stage.ts）から切り離す。
 *
 * 配置は3列で、中央にテーマと「いま紹介している意見」、左右に論点を3つずつ置く（作った順に左から）。論点の中は新しい意見を
 * CARDS_PER_TOPIC 件まで、札の種類（課題・解決策・問い・気づき）つきで並べる。人数は出さない（多数決に見せないため）。
 * 札の種類は色だけでなく文字でも出し、見た目（opinions.css）で明るさも変える。
 *
 * 毎フレーム（draw）は、現在時刻から「いま紹介している意見」と作ったばかりの意見を決め直し、変わったところだけ書き換える。
 *
 * 注意: 変わっていない札の要素は作り直さない（意見のIDごとに使い回す）。作り直すと、出現のアニメーションが新しい札だけでなく
 * 全部の札で走ってしまう。
 */
import { OPINION_KIND_LABELS, isFresh, spotlightAt, splitTopics, type OpinionBoard, type OverlayOpinion, type OverlayTopic, type Spotlight } from './entry'

/** 論点の中に並べる意見の数。古い意見も「いま紹介している意見」で順に回ってくる */
export const CARDS_PER_TOPIC = 3

/** テーマの見出し。開いているあいだと締め切ったあとで変える */
const OPEN_LABEL = 'いまのテーマ'
const CLOSED_LABEL = '締め切ったテーマ'

/** テーマの下に出す参加のしかた */
const HINT = 'チャットに書いた意見が、観点ごとに並んでいきます'

/** 「いま紹介している意見」の見出し */
const SPOTLIGHT_LABEL = 'いま紹介している意見'

export interface OpinionView {
  /** 映す意見ボードを置き換える */
  setBoard(board: OpinionBoard): void
  /** いまの時刻で、紹介する意見と作ったばかりの印を決め直す。毎フレーム呼ばれるので、変わったところだけ書き換える */
  draw(now: number): void
}

/** 決まった class を持つ要素を作る */
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const created = document.createElement(tag)
  created.className = className
  if (text !== undefined) created.textContent = text
  return created
}

/** 札の種類の印。色だけに頼らず、呼び名を文字で出す */
const createTag = (kind: OverlayOpinion['kind'], className: string): HTMLSpanElement => {
  const tag = element('span', className, OPINION_KIND_LABELS[kind])
  tag.dataset.kind = kind
  return tag
}

/** 意見の札を作る */
const createCard = (opinion: OverlayOpinion): HTMLLIElement => {
  const card = element('li', 'opinions-card')
  card.dataset.kind = opinion.kind
  card.append(createTag(opinion.kind, 'opinions-tag'), element('span', 'opinions-text', opinion.text))
  return card
}

/** 同じ中身の札か。同じなら要素を使い回す */
const sameOpinion = (left: OverlayOpinion, right: OverlayOpinion): boolean => left.kind === right.kind && left.text === right.text

/** 印（data-*）を付け外しする */
const toggleFlag = (target: HTMLElement, name: 'lit' | 'fresh', on: boolean): void => {
  if (on && target.dataset[name] === undefined) target.dataset[name] = ''
  if (!on && target.dataset[name] !== undefined) delete target.dataset[name]
}

/**
 * 意見ボードの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-opinions] の要素）
 */
export const createOpinionView = (root: HTMLElement): OpinionView => {
  const boardElement = element('div', 'opinions-board')
  const left = element('div', 'opinions-side opinions-side--left')
  const right = element('div', 'opinions-side opinions-side--right')

  const center = element('div', 'opinions-center')
  const themeBox = element('div', 'opinions-theme')
  const themeLabel = element('p', 'opinions-theme-label', OPEN_LABEL)
  const themeTitle = element('h1', 'opinions-theme-title')
  themeBox.append(themeLabel, themeTitle, element('p', 'opinions-theme-hint', HINT))

  const spotlightBox = element('div', 'opinions-spotlight')
  // 最初の draw で紹介する意見が決まるまでは隠しておく
  spotlightBox.hidden = true
  const spotlightHead = element('p', 'opinions-spotlight-head')
  const spotlightTag = element('span', 'opinions-spotlight-tag')
  const spotlightTopic = element('span', 'opinions-spotlight-topic')
  spotlightHead.append(spotlightTag, ' ', spotlightTopic)
  const spotlightText = element('p', 'opinions-spotlight-text')
  const spotlightAuthor = element('p', 'opinions-spotlight-author')
  spotlightBox.append(element('p', 'opinions-spotlight-label', SPOTLIGHT_LABEL), spotlightHead, spotlightText, spotlightAuthor)
  center.append(themeBox, spotlightBox)

  boardElement.append(left, center, right)
  root.append(boardElement)

  let topics: readonly OverlayTopic[] = []
  /** 映している札（意見のIDごと）。変わっていない札の要素を使い回す */
  let cards = new Map<number, { opinion: OverlayOpinion; card: HTMLLIElement }>()
  /** 中央に出している意見のID（無ければ null）。変わったときだけ書き換える。undefined は「次の draw で必ず決め直す」 */
  let spotlightId: number | null | undefined

  /** 論点1つの要素を作る（札は使い回す） */
  const renderTopic = (topic: OverlayTopic, nextCards: typeof cards): HTMLElement => {
    const section = element('section', 'opinions-topic')
    const list = element('ul', 'opinions-cards')
    for (const opinion of topic.opinions.slice(0, CARDS_PER_TOPIC)) {
      const previous = cards.get(opinion.id)
      const entry = previous !== undefined && sameOpinion(previous.opinion, opinion) ? previous : { opinion, card: createCard(opinion) }
      nextCards.set(opinion.id, entry)
      list.append(entry.card)
    }
    section.append(element('h2', 'opinions-topic-title', topic.title), list)
    return section
  }

  /** 中央の「いま紹介している意見」を書き換える */
  const showSpotlight = (spotlight: Spotlight | null): void => {
    spotlightBox.hidden = spotlight === null
    if (spotlight === null) return
    const { opinion } = spotlight
    spotlightTag.textContent = OPINION_KIND_LABELS[opinion.kind]
    spotlightTag.dataset.kind = opinion.kind
    spotlightTopic.textContent = spotlight.topicTitle
    spotlightText.textContent = opinion.text
    spotlightAuthor.textContent = `${opinion.author}さんのコメントから`
    // 新しい札として出し直し、切り替わりのアニメーションを走らせる
    spotlightBox.classList.remove('opinions-spotlight--enter')
    void spotlightBox.offsetWidth
    spotlightBox.classList.add('opinions-spotlight--enter')
  }

  return {
    setBoard(board) {
      boardElement.hidden = board.theme === null
      themeLabel.textContent = board.theme !== null && board.theme.closedAt !== null ? CLOSED_LABEL : OPEN_LABEL
      themeTitle.textContent = board.theme?.title ?? ''
      topics = board.topics
      const nextCards: typeof cards = new Map()
      const sides = splitTopics(board.topics)
      left.replaceChildren(...sides.left.map((topic) => renderTopic(topic, nextCards)))
      right.replaceChildren(...sides.right.map((topic) => renderTopic(topic, nextCards)))
      cards = nextCards
      // 意見の並びが変わると、同じ時刻でも紹介する意見が変わりうるので、次の draw で決め直させる
      spotlightId = undefined
    },
    draw(now) {
      const spotlight = spotlightAt(topics, now)
      const nextId = spotlight?.opinion.id ?? null
      if (nextId !== spotlightId) {
        showSpotlight(spotlight)
        spotlightId = nextId
      }
      for (const [id, { opinion, card }] of cards) {
        toggleFlag(card, 'lit', id === nextId)
        toggleFlag(card, 'fresh', isFresh(opinion, now))
      }
    },
  }
}
