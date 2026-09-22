/**
 * 配信の記録の読み出しAPI（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どの経路を呼ぶか」と
 * 「失敗や想定外の応答をエラーとして扱うか（黙って空の一覧にしないか）」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { createStatsApi } from './api'

const サイト = 'https://hdad.example.com'

const 金曜夜の配信 = {
  id: '配信ID-2026-09-19',
  startedAt: '2026-09-19T12:00:00.000Z',
  endedAt: '2026-09-19T15:30:00.000Z',
  title: '金曜夜のもくもく配信',
  categoryName: 'Software and Game Development',
  averageViewers: 12.5,
  peakViewers: 31,
  followerDelta: 4,
  eventCounts: { 'channel.subscribe': 2, 'channel.raid': 1 },
}

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('sessions（配信セッションの一覧）', () => {
  it('一覧の経路を呼び、配信ごとの集計を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { sessions: [金曜夜の配信] })

    expect(await createStatsApi(fetchImpl).sessions()).toEqual([金曜夜の配信])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/sessions')
  })

  it('配信中（endedAt が null）と記録が無い項目（視聴者数が null）を受け取れる', async () => {
    const 配信中 = { ...金曜夜の配信, endedAt: null, averageViewers: null, peakViewers: null, followerDelta: null, eventCounts: {} }
    expect(await createStatsApi(応答を返すfetch(200, { sessions: [配信中] }).fetchImpl).sessions()).toEqual([配信中])
  })

  it('応答が想定した形でなければエラーにする（黙って空の一覧にしない）', async () => {
    const 開始日時のない配信 = { ...金曜夜の配信, startedAt: 12345 }
    await expect(createStatsApi(応答を返すfetch(200, { sessions: [開始日時のない配信] }).fetchImpl).sessions()).rejects.toThrow('sessions[0]')
    await expect(createStatsApi(応答を返すfetch(200, { sessions: 'まだありません' }).fetchImpl).sessions()).rejects.toThrow('sessions')
  })

  it('イベントの件数が数値でなければエラーにする', async () => {
    const 件数が文字列の配信 = { ...金曜夜の配信, eventCounts: { 'channel.raid': '1' } }
    await expect(createStatsApi(応答を返すfetch(200, { sessions: [件数が文字列の配信] }).fetchImpl).sessions()).rejects.toThrow('sessions[0]')
  })

  it('Workerが失敗を返したら、そのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(500, { error: { code: 'misconfigured', message: 'Workerの環境変数が設定されていません: DB' } })
    await expect(createStatsApi(fetchImpl).sessions()).rejects.toThrow('DB')
  })
})

describe('session（配信ごとの視聴者数の推移）', () => {
  it('配信IDを経路に入れて呼び、視聴者数の時系列を返す', async () => {
    const 詳細 = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: '2026-09-19T15:30:00.000Z',
      title: '金曜夜のもくもく配信',
      categoryName: 'Software and Game Development',
      samples: [
        { sampledAt: '2026-09-19T12:05:00.000Z', viewerCount: 8 },
        { sampledAt: '2026-09-19T12:10:00.000Z', viewerCount: 15 },
      ],
    }
    const { requests, fetchImpl } = 応答を返すfetch(200, 詳細)

    expect(await createStatsApi(fetchImpl).session('配信ID-2026-09-19')).toEqual(詳細)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/sessions/%E9%85%8D%E4%BF%A1ID-2026-09-19')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const 時系列のない詳細 = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting' }
    await expect(createStatsApi(応答を返すfetch(200, 時系列のない詳細).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('samples')
  })
})

describe('followers（フォロワー数の推移）', () => {
  it('フォロワー数の経路を呼び、時系列を返す', async () => {
    const 推移 = [
      { sampledAt: '2026-09-18T00:00:00.000Z', followerTotal: 100 },
      { sampledAt: '2026-09-19T00:00:00.000Z', followerTotal: 104 },
    ]
    const { requests, fetchImpl } = 応答を返すfetch(200, { samples: 推移 })

    expect(await createStatsApi(fetchImpl).followers()).toEqual(推移)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/followers')
  })

  it('応答が想定した形でなければエラーにする（黙って空の推移にしない）', async () => {
    await expect(createStatsApi(応答を返すfetch(200, { samples: [{ sampledAt: '2026-09-18T00:00:00.000Z' }] }).fetchImpl).followers()).rejects.toThrow(
      'samples[0]',
    )
  })
})
