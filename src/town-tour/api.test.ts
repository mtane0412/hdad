/**
 * 市町村紹介の読み出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（task-desk/api.test.ts と同じ形）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { JAPAN_MAP_PATH, createTownTourApi } from './api'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

/** 東京都千代田区の紹介 */
const chiyodaIntro = {
  code: '13101',
  prefecture: '東京都',
  county: '',
  name: '千代田区',
  article: { title: '千代田区', url: 'https://ja.wikipedia.org/wiki/%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA' },
  tour: {
    hook: '住む人より働きに来る人が多い区',
    points: [
      { label: '名前の由来', text: '江戸城の別名「千代田城」に由来します。' },
      { label: '昼と夜', text: '夜間の人口が昼間の人口よりずっと少ない区です。' },
    ],
    cue: '千代田区で働いたことはありますか？',
  },
}

describe('introduce', () => {
  it('オーバーレイ用キーとコードを付けて、市町村の紹介を作らせる', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, chiyodaIntro)

    expect(await createTownTourApi(fetchImpl, OVERLAY_KEY).introduce('13101')).toEqual({ article: chiyodaIntro.article, tour: chiyodaIntro.tour })
    expect(calls).toEqual([`/api/overlay/town-tour?key=${encodeURIComponent(OVERLAY_KEY)}&code=13101`])
  })

  it('紹介を作れなかった（502）ときは、Workerが返した理由ごと投げる', async () => {
    const { fetchImpl } = createFetchWithResponse(502, { error: { code: 'town-tour-failed', message: 'Wikipedia の記事を取得できませんでした' } })

    const failure = createTownTourApi(fetchImpl, OVERLAY_KEY).introduce('13101')

    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await expect(failure).rejects.toThrow('Wikipedia の記事を取得できませんでした')
  })
})

describe('openQuiz', () => {
  it('オーバーレイ用キーを付けて、出題の識別子と市町村のコードを送り、出題を開かせる', async () => {
    const requests: Request[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(new URL(String(input), 'https://hdad.example.com'), init))
      return new Response(null, { status: 204 })
    }) as typeof fetch

    await createTownTourApi(fetchImpl, OVERLAY_KEY).openQuiz('quiz-chiyoda', '13101')

    expect(requests.map((request) => [request.method, new URL(request.url).pathname + new URL(request.url).search])).toEqual([
      ['POST', `/api/overlay/town-tour/quiz?key=${encodeURIComponent(OVERLAY_KEY)}`],
    ])
    expect(await requests[0]?.json()).toEqual({ quizId: 'quiz-chiyoda', code: '13101' })
  })

  it('出題を開けなかったときは、Workerが返した理由ごと投げる', async () => {
    const { fetchImpl } = createFetchWithResponse(404, { error: { code: 'unknown-town', message: '市町村の一覧に無いコードです: 99999' } })

    await expect(createTownTourApi(fetchImpl, OVERLAY_KEY).openQuiz('quiz-unknown', '99999')).rejects.toThrow('99999')
  })
})

describe('japanMap', () => {
  it('同梱の日本地図（TopoJSON）を、静的なファイルとして読む', async () => {
    const topology = { type: 'Topology', objects: {}, arcs: [] }
    const { calls, fetchImpl } = createFetchWithResponse(200, topology)

    expect(await createTownTourApi(fetchImpl, OVERLAY_KEY).japanMap()).toEqual(topology)
    expect(calls).toEqual([JAPAN_MAP_PATH])
  })
})
