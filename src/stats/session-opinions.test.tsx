// @vitest-environment jsdom
/**
 * 配信の振り返りの意見ボード（session-opinions.tsx）のテスト
 *
 * 確かめること:
 * - 読み込み中は読み込み中と分かる表示を出し、失敗したら空に見せかけず理由を出すこと（Fail-Fast）
 * - 配信の時間にテーマを開いていなければ、その旨を文で伝えること
 * - テーマごとの区切りに、全論点・全意見・札の種類・人数・もとのコメントの原文を出すこと
 * - 隠した意見は「隠しています」と分かる形で出すこと
 * - 意見にならなかったコメントは、件数の内訳だけを出すこと
 * - 締め切ったテーマには、機械が作ったまとめを機械のものと分かる枠で出し、作り直しの操作は置かないこと
 *
 * 日時はブラウザのタイムゾーンで出す決まりなので、TZ を東京に固定する。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpinionThemeReview } from './api'
import { SessionOpinions } from './session-opinions'

process.env.TZ = 'Asia/Tokyo'

const AI_THEME: OpinionThemeReview = {
  theme: { id: 3, title: '配信中にAIをどこまで使っていい？', openedAt: '2026-09-19T12:10:00.000Z', closedAt: '2026-09-19T12:50:00.000Z', prompt: null },
  topics: [
    {
      id: 5,
      title: '視聴者との距離',
      opinions: [
        {
          id: 8,
          kind: 'issue',
          text: 'AIが返事すると距離を感じる',
          author: 'aoi',
          createdAt: '2026-09-19T12:20:00.000Z',
          hidden: false,
          people: 2,
          sources: [
            { userName: 'aoi', text: 'AIのコメ返しは寂しい' },
            { userName: 'riku', text: 'AIの返事だと距離を感じる' },
          ],
        },
        {
          id: 9,
          kind: 'solution',
          text: '返事はAIだと明記する',
          author: 'mochi',
          createdAt: '2026-09-19T12:25:00.000Z',
          hidden: true,
          people: 1,
          sources: [{ userName: 'mochi', text: 'AIって書いてくれれば気にならない' }],
        },
      ],
    },
    { id: 6, title: '使いどころ', opinions: [] },
  ],
  counts: { received: 12, used: 3, pending: 0, dropped: { command: 1, emote: 2, reaction: 3 }, filtered: 1, ignored: 2, failed: 0 },
  summary: {
    agreements: ['AIの返事は距離を感じさせる'],
    disagreements: ['AIだと明記すれば気にならない人もいる'],
    openQuestions: ['どこまでAIに任せてよいか'],
    createdAt: '2026-09-19T12:51:00.000Z',
  },
}

const BGM_THEME: OpinionThemeReview = {
  theme: { id: 4, title: '作業用BGMの好み', openedAt: '2026-09-19T13:00:00.000Z', closedAt: null, prompt: null },
  topics: [],
  counts: { received: 0, used: 0, pending: 0, dropped: { command: 0, emote: 0, reaction: 0 }, filtered: 0, ignored: 0, failed: 0 },
  summary: null,
}

afterEach(cleanup)

/** 決めた読み込みを返す代役のAPIで、配信「配信ID」の振り返りを出す */
const renderReview = (sessionOpinions: (sessionId: string) => Promise<OpinionThemeReview[]>) =>
  render(<SessionOpinions api={{ sessionOpinions }} sessionId="配信ID" />)

describe('読み込みの途中と失敗', () => {
  it('読み込みが終わるまでは、読み込み中と分かる表示を出す', () => {
    renderReview(() => new Promise<OpinionThemeReview[]>(() => {}))
    expect(screen.getByLabelText('意見ボードの振り返りを読み込んでいます')).toBeInTheDocument()
  })

  it('読み込みに失敗したら、空に見せかけず理由を出す', async () => {
    renderReview(vi.fn(async () => Promise.reject(new Error('Workerが応答しません'))))
    expect(await screen.findByText('意見ボードの振り返りを読み込めませんでした')).toBeInTheDocument()
    expect(screen.getByText('Workerが応答しません')).toBeInTheDocument()
  })
})

describe('テーマを開いていない配信', () => {
  it('この配信では意見ボードを使っていないことを文で伝える', async () => {
    renderReview(vi.fn(async () => []))
    expect(await screen.findByText('この配信では意見ボードのテーマを開いていません。')).toBeInTheDocument()
  })
})

describe('テーマごとの振り返り', () => {
  it('テーマごとの区切りに、テーマの題と開いていた時間を出す', async () => {
    renderReview(vi.fn(async () => [AI_THEME, BGM_THEME]))

    const aiTheme = await screen.findByRole('group', { name: 'テーマ「配信中にAIをどこまで使っていい？」の振り返り' })
    // 東京の時刻で出る（12:10Z は 21:10）
    expect(aiTheme).toHaveTextContent('21:10〜21:50')
    const bgmTheme = screen.getByRole('group', { name: 'テーマ「作業用BGMの好み」の振り返り' })
    // 締め切っていないテーマは、開いたままだと分かる
    expect(bgmTheme).toHaveTextContent('22:00〜')
    expect(bgmTheme).toHaveTextContent('締め切っていません')
  })

  it('論点ごとに、全意見を札の種類と人数つきで出し、もとのコメントの原文を読める', async () => {
    renderReview(vi.fn(async () => [AI_THEME]))

    const topic = await screen.findByRole('group', { name: '論点「視聴者との距離」' })
    const opinion = within(topic).getByRole('group', { name: '意見「AIが返事すると距離を感じる」' })
    expect(opinion).toHaveTextContent('課題')
    expect(opinion).toHaveTextContent('2人')
    expect(opinion).toHaveTextContent('aoi: AIのコメ返しは寂しい')
    expect(opinion).toHaveTextContent('riku: AIの返事だと距離を感じる')
    // 意見の無い論点も、論点として出す
    expect(screen.getByRole('group', { name: '論点「使いどころ」' })).toHaveTextContent('意見はありません')
  })

  it('隠した意見は「隠しています」と分かる形で出す', async () => {
    renderReview(vi.fn(async () => [AI_THEME]))

    const hidden = await screen.findByRole('group', { name: '意見「返事はAIだと明記する」' })
    expect(hidden).toHaveTextContent('隠しています')
    expect(screen.getByRole('group', { name: '意見「AIが返事すると距離を感じる」' })).not.toHaveTextContent('隠しています')
  })

  it('意見にならなかったコメントは、件数の内訳だけを出す', async () => {
    renderReview(vi.fn(async () => [AI_THEME]))

    const counts = await screen.findByRole('group', { name: 'コメントの内訳（配信中にAIをどこまで使っていい？）' })
    expect(counts).toHaveTextContent('12件')
    expect(counts).toHaveTextContent('意見になった3件')
    // 規則で落とした6件（コマンド1・エモートだけ2・短い反応3）
    expect(counts).toHaveTextContent('規則で落とした6件')
    expect(counts).toHaveTextContent('Jevが意見ではないとみた1件')
    expect(counts).toHaveTextContent('無関係とした2件')
  })
})

describe('機械が作ったまとめ', () => {
  it('締め切ったテーマの区切りに、AIのまとめを機械が作ったと分かる枠で出す', async () => {
    renderReview(vi.fn(async () => [AI_THEME]))

    const aiTheme = await screen.findByRole('group', { name: 'テーマ「配信中にAIをどこまで使っていい？」の振り返り' })
    const summary = within(aiTheme).getByRole('group', { name: 'AIのまとめ' })
    expect(summary).toHaveTextContent('機械が作成')
    expect(summary).toHaveTextContent('AIの返事は距離を感じさせる')
    expect(summary).toHaveTextContent('AIだと明記すれば気にならない人もいる')
    expect(summary).toHaveTextContent('どこまでAIに任せてよいか')
    // 振り返りは読むだけの場所なので、作り直しの操作は置かない（作り直しは /opinions/ で行う）
    expect(within(summary).queryByRole('button')).not.toBeInTheDocument()
  })

  it('締め切っていないテーマには、まとめの枠を出さない', async () => {
    renderReview(vi.fn(async () => [BGM_THEME]))

    const bgmTheme = await screen.findByRole('group', { name: 'テーマ「作業用BGMの好み」の振り返り' })
    expect(within(bgmTheme).queryByRole('group', { name: 'AIのまとめ' })).not.toBeInTheDocument()
  })
})
