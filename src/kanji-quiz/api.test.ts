/**
 * 漢字クイズの、Worker とのつなぎ方（api.ts）のテスト
 *
 * 合成ページは出題を流しはじめたら、オーバーレイ用キーを付けて出題を開かせる（POST /api/overlay/kanji-quiz/open。issue #301）。
 * 開けなかったときは Worker の理由ごと投げる（合成ページが素材の箱に出す）。
 */
import { describe, expect, it } from 'vitest'
import { createKanjiQuizApi } from './api'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'

describe('openQuiz', () => {
  it('オーバーレイ用キーを付けて出題の識別子を送り、出題を開かせる', async () => {
    const requests: Request[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(new URL(String(input), 'https://hdad.example.com'), init))
      return new Response(null, { status: 204 })
    }) as typeof fetch

    await createKanjiQuizApi(fetchImpl, OVERLAY_KEY).openQuiz('quiz-keidai')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname + new URL(request.url).search])).toEqual([
      ['POST', `/api/overlay/kanji-quiz/open?key=${encodeURIComponent(OVERLAY_KEY)}`],
    ])
    expect(await requests[0]?.json()).toEqual({ quizId: 'quiz-keidai' })
  })

  it('出題を開けなかったときは、Workerが返した理由ごと投げる', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      Response.json({ error: { code: 'unknown-kanji-quiz', message: '選んでいない漢字クイズの出題です: quiz-unknown' } }, { status: 404 })) as typeof fetch

    await expect(createKanjiQuizApi(fetchImpl, OVERLAY_KEY).openQuiz('quiz-unknown')).rejects.toThrow('quiz-unknown')
  })
})
