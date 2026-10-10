/**
 * 意見ボードの形と、紹介する意見の選び方（entry.ts）のテスト
 *
 * 次の点を確かめる。
 * - Worker の応答（読み出しと押し出しで同じ形）を意見ボードとして読み、形が違えば投げること
 * - 「いま紹介している意見」は人数ではなく、意見を作った順に一定の時間ずつ回すこと（少数の意見にも同じだけ出番を回す）
 * - 作ったばかりの意見を見分けられること
 * - 論点を左右の枠（3つずつ）に分けること
 */
import { describe, expect, it } from 'vitest'
import {
  FRESH_MS,
  SPOTLIGHT_MS,
  isFresh,
  parseOpinionBoardMessage,
  readOpinionBoard,
  spotlightAt,
  splitTopics,
  type OpinionBoard,
  type OverlayTopic,
} from './entry'

const theme = { id: 1, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-10-10T12:00:00.000Z', closedAt: null }

/** 論点が2つ、意見が3件ある意見ボード（意見は新しい順） */
const board: OpinionBoard = {
  theme,
  topics: [
    {
      id: 1,
      title: '視聴者との距離',
      opinions: [
        { id: 13, kind: 'insight', text: '初見さんへの挨拶はAIでも嬉しい', author: 'mugi', createdAt: '2026-10-10T12:03:00.000Z' },
        { id: 11, kind: 'issue', text: 'AIが返事すると距離を感じる', author: 'aoi', createdAt: '2026-10-10T12:01:00.000Z' },
      ],
    },
    { id: 2, title: '間違いへの不安', opinions: [{ id: 12, kind: 'question', text: 'AIのまとめが間違っていたら誰が直すのか', author: 'tsukimi_dev', createdAt: '2026-10-10T12:02:00.000Z' }] },
  ],
}

describe('readOpinionBoard', () => {
  it('Worker の応答を意見ボードとして読む', () => {
    expect(readOpinionBoard(JSON.parse(JSON.stringify(board)))).toEqual(board)
    expect(readOpinionBoard({ theme: null, topics: [] })).toEqual({ theme: null, topics: [] })
  })

  it('形が違えば投げる', () => {
    expect(() => readOpinionBoard({ theme, topics: [{ id: 1, title: '視聴者との距離' }] })).toThrow()
    expect(() => readOpinionBoard({ theme, topics: [{ id: 1, title: '視聴者との距離', opinions: [{ ...board.topics[1]?.opinions[0], kind: '賛成' }] }] })).toThrow()
    expect(() => readOpinionBoard({ topics: [] })).toThrow('theme')
  })

  it('押し出された文字列も読む', () => {
    expect(parseOpinionBoardMessage(JSON.stringify(board))).toEqual(board)
    expect(() => parseOpinionBoardMessage('意見ボード')).toThrow('JSON')
  })
})

describe('spotlightAt', () => {
  it('意見を作った順に、一定の時間ずつ回す', () => {
    const at = (slot: number): number => slot * SPOTLIGHT_MS + 1
    expect(spotlightAt(board.topics, at(0))?.opinion.id).toBe(11)
    expect(spotlightAt(board.topics, at(1))?.opinion.id).toBe(12)
    expect(spotlightAt(board.topics, at(2))?.opinion.id).toBe(13)
    expect(spotlightAt(board.topics, at(3))?.opinion.id).toBe(11)
  })

  it('紹介する意見の論点の名前を添える', () => {
    expect(spotlightAt(board.topics, 1 * SPOTLIGHT_MS)).toMatchObject({ topicTitle: '間違いへの不安' })
  })

  it('意見が1件も無ければ null', () => {
    expect(spotlightAt([], 0)).toBeNull()
    expect(spotlightAt([{ id: 1, title: '視聴者との距離', opinions: [] }], 0)).toBeNull()
  })
})

describe('isFresh', () => {
  const opinion = board.topics[0]?.opinions[0]
  if (opinion === undefined) throw new Error('意見がありません')
  const created = Date.parse(opinion.createdAt)

  it('作ってから一定の時間のあいだだけ、作ったばかりとみなす', () => {
    expect(isFresh(opinion, created + FRESH_MS - 1)).toBe(true)
    expect(isFresh(opinion, created + FRESH_MS)).toBe(false)
  })
})

describe('splitTopics', () => {
  const topic = (id: number): OverlayTopic => ({ id, title: `論点${id}`, opinions: [] })

  it('作った順に、左に3つ・右に3つ並べる', () => {
    const { left, right } = splitTopics([1, 2, 3, 4, 5].map(topic))
    expect(left.map(({ id }) => id)).toEqual([1, 2, 3])
    expect(right.map(({ id }) => id)).toEqual([4, 5])
  })
})
