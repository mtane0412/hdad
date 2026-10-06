/**
 * 配信の記録の読み出しAPI（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どの経路を呼ぶか」と
 * 「失敗や想定外の応答をエラーとして扱うか（黙って空の一覧にしないか）」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { createStatsApi } from './api'

const SITE = 'https://hdad.example.com'

const FRIDAY_NIGHT_SESSION = {
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
const fetchReturning = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), SITE), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('sessions（配信セッションの一覧）', () => {
  it('一覧の経路を呼び、配信ごとの集計を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { sessions: [FRIDAY_NIGHT_SESSION] })

    expect(await createStatsApi(fetchImpl).sessions()).toEqual([FRIDAY_NIGHT_SESSION])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/sessions')
  })

  it('配信中（endedAt が null）と記録が無い項目（視聴者数が null）を受け取れる', async () => {
    const liveSession = { ...FRIDAY_NIGHT_SESSION, endedAt: null, averageViewers: null, peakViewers: null, followerDelta: null, eventCounts: {} }
    expect(await createStatsApi(fetchReturning(200, { sessions: [liveSession] }).fetchImpl).sessions()).toEqual([liveSession])
  })

  it('応答が想定した形でなければエラーにする（黙って空の一覧にしない）', async () => {
    const sessionWithoutStart = { ...FRIDAY_NIGHT_SESSION, startedAt: 12345 }
    await expect(createStatsApi(fetchReturning(200, { sessions: [sessionWithoutStart] }).fetchImpl).sessions()).rejects.toThrow('sessions[0]')
    await expect(createStatsApi(fetchReturning(200, { sessions: 'まだありません' }).fetchImpl).sessions()).rejects.toThrow('sessions')
  })

  it('イベントの件数が数値でなければエラーにする', async () => {
    const sessionWithStringCount = { ...FRIDAY_NIGHT_SESSION, eventCounts: { 'channel.raid': '1' } }
    await expect(createStatsApi(fetchReturning(200, { sessions: [sessionWithStringCount] }).fetchImpl).sessions()).rejects.toThrow('sessions[0]')
  })

  it('Workerが失敗を返したら、そのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = fetchReturning(500, { error: { code: 'misconfigured', message: 'Workerの環境変数が設定されていません: DB' } })
    await expect(createStatsApi(fetchImpl).sessions()).rejects.toThrow('DB')
  })
})

describe('session（配信ごとの視聴者数の推移）', () => {
  it('配信IDを経路に入れて呼び、視聴者数の時系列を返す', async () => {
    const detail = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: '2026-09-19T15:30:00.000Z',
      title: '金曜夜のもくもく配信',
      categoryName: 'Software and Game Development',
      samples: [
        { sampledAt: '2026-09-19T12:05:00.000Z', viewerCount: 8 },
        { sampledAt: '2026-09-19T12:10:00.000Z', viewerCount: 15 },
      ],
      chapters: [
        {
          startedAt: '2026-09-19T12:00:00.000Z',
          endedAt: '2026-09-19T12:30:00.000Z',
          title: 'エディタの設定を見直す',
          summary: '配信者がエディタの拡張機能を整理し、視聴者からおすすめの拡張が寄せられた。',
        },
      ],
      // 章ごとに作った配信タイトルの候補と、公開してよいかの Jev の判定（試験運用）
      titleCandidates: [{ chapterStartedAt: '2026-09-19T12:00:00.000Z', candidate: 'エディタを整理中', publishable: 0.97 }],
      summary: 'エディタを整えた配信者。いまは新しい機能の実装に取りかかったところ。',
      // 作業机で3人が合わせて2時間作業した
      workTime: { people: 3, totalMs: 2 * 60 * 60 * 1000 },
    }
    const { requests, fetchImpl } = fetchReturning(200, detail)

    expect(await createStatsApi(fetchImpl).session('配信ID-2026-09-19')).toEqual(detail)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/sessions/%E9%85%8D%E4%BF%A1ID-2026-09-19')
  })

  it('章の形が想定と違えば、黙って捨てずにエラーにする', async () => {
    const detail = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: null,
      title: '配信',
      categoryName: 'Just Chatting',
      samples: [],
      chapters: [{ startedAt: '2026-09-19T12:00:00.000Z', title: '見出しだけの章' }],
      titleCandidates: [],
      summary: null,
      workTime: null,
    }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('chapters[0]')
  })

  it('タイトルの候補の判定が数でなければ、黙って捨てずにエラーにする', async () => {
    const detail = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: null,
      title: '配信',
      categoryName: 'Just Chatting',
      samples: [],
      chapters: [],
      titleCandidates: [{ chapterStartedAt: '2026-09-19T12:00:00.000Z', candidate: 'エディタを整理中', publishable: '高い' }],
      summary: null,
      workTime: null,
    }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('titleCandidates[0]')
  })

  it('あらすじが文字列でも null でもなければエラーにする', async () => {
    const detail = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting', samples: [], chapters: [], titleCandidates: [], summary: 0, workTime: null }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('配信セッション')
  })

  it('作業した時間の合計が人数と時間の組でも null でもなければエラーにする（0 に読み替えない）', async () => {
    const detail = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting', samples: [], chapters: [], titleCandidates: [], summary: null, workTime: { people: 3 } }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('配信セッション')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const detailWithoutSeries = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting' }
    await expect(createStatsApi(fetchReturning(200, detailWithoutSeries).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('samples')
  })
})

describe('titleSettings（配信タイトルの候補を作るかの設定）', () => {
  it('設定の経路を呼び、候補を作るかを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { settings: { enabled: false } })

    expect(await createStatsApi(fetchImpl).titleSettings()).toEqual({ enabled: false })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stream-title/settings')
  })

  it('保存するときは PUT で送り、保存された設定を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { settings: { enabled: true } })

    expect(await createStatsApi(fetchImpl).saveTitleSettings({ enabled: true })).toEqual({ enabled: true })
    expect(requests[0]?.method).toBe('PUT')
    expect(await requests[0]?.json()).toEqual({ enabled: true })
  })

  it('応答の設定が想定した形でなければエラーにする（黙って「作らない」にしない）', async () => {
    await expect(createStatsApi(fetchReturning(200, { settings: { enabled: 'はい' } }).fetchImpl).titleSettings()).rejects.toThrow('settings')
  })
})

describe('followers（フォロワー数の推移）', () => {
  it('フォロワー数の経路を呼び、時系列を返す', async () => {
    const trend = [
      { sampledAt: '2026-09-18T00:00:00.000Z', followerTotal: 100 },
      { sampledAt: '2026-09-19T00:00:00.000Z', followerTotal: 104 },
    ]
    const { requests, fetchImpl } = fetchReturning(200, { samples: trend })

    expect(await createStatsApi(fetchImpl).followers()).toEqual(trend)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/followers')
  })

  it('応答が想定した形でなければエラーにする（黙って空の推移にしない）', async () => {
    await expect(createStatsApi(fetchReturning(200, { samples: [{ sampledAt: '2026-09-18T00:00:00.000Z' }] }).fetchImpl).followers()).rejects.toThrow(
      'samples[0]',
    )
  })
})
