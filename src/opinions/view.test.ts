// @vitest-environment jsdom
/**
 * 意見ボードの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の点を確かめる。
 * - 中央にテーマ、左右に論点を3つずつ並べ、論点ごとに新しい意見を3件まで札の種類つきで出すこと
 * - 人数を出さないこと（多数決に見せないため）
 * - 「いま紹介している意見」を現在時刻から選んで中央に出し、論点の中の同じ札にも印を付けること
 * - 作ったばかりの意見に印を付けること
 * - 締め切ったテーマはそれと分かる見出しにし、テーマが無ければ何も出さないこと
 * - 変わっていない札の要素は作り直さないこと（作り直すと出現のアニメーションが全部の札で走る）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { FRESH_MS, SPOTLIGHT_MS, type OpinionBoard, type OverlayOpinion } from './entry'
import { createOpinionView } from './view'

const theme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null }

/** 時刻 minute 分に作った意見 */
const opinion = (id: number, kind: OverlayOpinion['kind'], text: string, author: string, minute: number): OverlayOpinion => ({
  id,
  kind,
  text,
  author,
  createdAt: `2026-10-10T12:${String(minute).padStart(2, '0')}:00.000Z`,
})

/** 論点が7つ（7つ目は枠に入らない）・最初の論点に意見が4件ある意見ボード */
const board: OpinionBoard = {
  theme,
  topics: [
    {
      id: 1,
      title: '視聴者との距離',
      opinions: [
        opinion(14, 'solution', '挨拶だけAIに任せる', 'hana', 4),
        opinion(13, 'insight', '初見さんへの挨拶はAIでも嬉しい', 'mugi', 3),
        opinion(12, 'question', 'AIの返事は誰の言葉なのか', 'ren', 2),
        opinion(11, 'issue', 'AIが返事すると距離を感じる', 'aoi', 1),
      ],
    },
    ...['作業のテンポ', '間違いとの付き合い方', 'AIだと分かること', '見ていて楽しいか', '学びになるか'].map((title, index) => ({ id: index + 2, title, opinions: [] })),
  ],
}

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

/** 論点の見出しを、左の枠・右の枠の順に並べる */
const topicTitles = (side: 'left' | 'right'): string[] =>
  [...root.querySelectorAll(`.opinions-side--${side} .opinions-topic-title`)].map((element) => element.textContent ?? '')

/** 最初の論点の札を「種類｜本文」で上から並べる */
const firstTopicCards = (): string[] =>
  [...(root.querySelector('.opinions-topic')?.querySelectorAll('.opinions-card') ?? [])].map(
    (card) => `${card.querySelector('.opinions-tag')?.textContent ?? ''}｜${card.querySelector('.opinions-text')?.textContent ?? ''}`,
  )

describe('createOpinionView', () => {
  it('中央にテーマ、左右に論点を3つずつ並べる', () => {
    createOpinionView(root).setBoard(board)

    expect(root.querySelector('.opinions-theme-title')?.textContent).toBe('配信中にAIをどこまで使っていい？')
    expect(topicTitles('left')).toEqual(['視聴者との距離', '作業のテンポ', '間違いとの付き合い方'])
    expect(topicTitles('right')).toEqual(['AIだと分かること', '見ていて楽しいか', '学びになるか'])
  })

  it('論点ごとに新しい意見を3件まで、札の種類つきで出し、人数は出さない', () => {
    createOpinionView(root).setBoard(board)

    expect(firstTopicCards()).toEqual(['解決策｜挨拶だけAIに任せる', '気づき｜初見さんへの挨拶はAIでも嬉しい', '問い｜AIの返事は誰の言葉なのか'])
    expect(root.textContent).not.toMatch(/[0-9０-９]+人/)
  })

  it('いま紹介している意見を中央に出し、論点の中の同じ札にも印を付ける', () => {
    const view = createOpinionView(root)
    view.setBoard(board)

    // 作った順で最初の意見（id 11）の番
    view.draw(0)

    expect(root.querySelector('.opinions-spotlight-text')?.textContent).toBe('AIが返事すると距離を感じる')
    expect(root.querySelector('.opinions-spotlight-tag')?.textContent).toBe('課題')
    expect(root.querySelector('.opinions-spotlight-topic')?.textContent).toBe('視聴者との距離')
    expect(root.querySelector('.opinions-spotlight-author')?.textContent).toBe('aoiさんのコメントから')

    // 次の番（id 12）は論点の中にも出ているので、その札に印が付く
    view.draw(SPOTLIGHT_MS)
    expect(root.querySelector('.opinions-card[data-lit] .opinions-text')?.textContent).toBe('AIの返事は誰の言葉なのか')
  })

  it('作ったばかりの意見に印を付ける', () => {
    const view = createOpinionView(root)
    view.setBoard(board)

    view.draw(Date.parse('2026-10-10T12:04:00.000Z') + FRESH_MS - 1)
    expect([...root.querySelectorAll('.opinions-card[data-fresh] .opinions-text')].map((element) => element.textContent)).toEqual(['挨拶だけAIに任せる'])

    view.draw(Date.parse('2026-10-10T12:04:00.000Z') + FRESH_MS)
    expect(root.querySelectorAll('.opinions-card[data-fresh]')).toHaveLength(0)
  })

  it('締め切ったテーマは、締め切ったと分かる見出しにする', () => {
    createOpinionView(root).setBoard({ ...board, theme: { ...theme, closedAt: '2026-10-10T12:30:00.000Z' } })
    expect(root.querySelector('.opinions-theme-label')?.textContent).toBe('締め切ったテーマ')
  })

  it('テーマが無ければ何も出さない', () => {
    createOpinionView(root).setBoard({ theme: null, topics: [] })
    expect(root.querySelector<HTMLElement>('.opinions-board')?.hidden).toBe(true)
  })

  it('変わっていない札の要素は作り直さない', () => {
    const view = createOpinionView(root)
    view.setBoard(board)
    const before = root.querySelector('.opinions-card')

    view.setBoard({ ...board })

    expect(root.querySelector('.opinions-card')).toBe(before)
  })
})
