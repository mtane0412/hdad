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

/** 東京都千代田区の紹介（名物は材料に無かったので空） */
const chiyodaIntro = {
  code: '13101',
  prefecture: '東京都',
  county: '',
  name: '千代田区',
  article: { title: '千代田区', url: 'https://ja.wikipedia.org/wiki/%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA' },
  tour: {
    location: '東京都の中心部にある区です。',
    nameOrigin: '江戸城の別名「千代田城」に由来します。',
    history: '江戸時代から政治の中心でした。',
    specialty: '',
    surprise: '夜間の人口が昼間の人口よりずっと少ない区です。',
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

describe('japanMap', () => {
  it('同梱の日本地図（TopoJSON）を、静的なファイルとして読む', async () => {
    const topology = { type: 'Topology', objects: {}, arcs: [] }
    const { calls, fetchImpl } = createFetchWithResponse(200, topology)

    expect(await createTownTourApi(fetchImpl, OVERLAY_KEY).japanMap()).toEqual(topology)
    expect(calls).toEqual([JAPAN_MAP_PATH])
  })
})
