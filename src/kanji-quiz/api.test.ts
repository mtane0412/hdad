/**
 * 漢字クイズの、Worker とのつなぎ方（api.ts）のテスト
 *
 * 合成ページは出題を流しはじめたら、オーバーレイ用キーを付けて出題を開かせる（POST /api/overlay/kanji-quiz/open。issue #301）。
 * 開けなかったときは Worker の理由ごと投げる（合成ページが素材の箱に出す）。
 * 裏方のページは配信を止めた結果を知らせ（POST /api/overlay/kanji-quiz/stop/result）、下部バーは停止を取り消す
 * （POST /api/admin/kanji-quiz/stop/cancel。issue #302）。
 */
import { describe, expect, it } from 'vitest'
import { createKanjiQuizAdminApi, createKanjiQuizApi } from './api'

/** 届いた要求を覚え、決まった応答を返す fetch の代役 */
const fetchReturning = (response: () => Response) => {
  const requests: Request[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), 'https://hdad.example.com'), init))
    return response()
  }) as typeof fetch
  return { requests, fetchImpl }
}

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

describe('reportStop', () => {
  it('オーバーレイ用キーを付けて、止められなかった理由（止められたら null）を知らせる', async () => {
    const { requests, fetchImpl } = fetchReturning(() => new Response(null, { status: 204 }))

    await createKanjiQuizApi(fetchImpl, OVERLAY_KEY).reportStop('quiz-keidai', 'OBS が配信していません')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname + new URL(request.url).search])).toEqual([
      ['POST', `/api/overlay/kanji-quiz/stop/result?key=${encodeURIComponent(OVERLAY_KEY)}`],
    ])
    expect(await requests[0]?.json()).toEqual({ quizId: 'quiz-keidai', error: 'OBS が配信していません' })
  })
})

describe('cancelStop', () => {
  it('猶予のあいだの停止を取り消し、取り消した出題の識別子を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(() => Response.json({ quizIds: ['quiz-keidai'] }))

    expect(await createKanjiQuizAdminApi(fetchImpl).cancelStop()).toEqual(['quiz-keidai'])
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([['POST', '/api/admin/kanji-quiz/stop/cancel']])
  })

  it('取り消すものが無ければ、Workerが返した理由ごと投げる', async () => {
    const { fetchImpl } = fetchReturning(() =>
      Response.json({ error: { code: 'kanji-quiz-stop-not-pending', message: '取り消せる配信の停止がありません' } }, { status: 409 }),
    )

    await expect(createKanjiQuizAdminApi(fetchImpl).cancelStop()).rejects.toThrow('取り消せる配信の停止がありません')
  })

  it('応答に取り消した出題の識別子が無ければ投げる', async () => {
    const { fetchImpl } = fetchReturning(() => Response.json({}))

    await expect(createKanjiQuizAdminApi(fetchImpl).cancelStop()).rejects.toThrow('quizIds')
  })
})
