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
          // この章では5人が合わせて12回チャットした
          chatCount: 12,
          chatterCount: 5,
        },
        {
          startedAt: '2026-09-19T12:30:00.000Z',
          endedAt: '2026-09-19T13:00:00.000Z',
          title: 'ログイン機能の実装',
          summary: '配信者がログイン画面を作りはじめた。',
          // チャットの数を残す前に作った章は null（記録なし）
          chatCount: null,
          chatterCount: null,
        },
      ],
      summary: 'エディタを整えた配信者。いまは新しい機能の実装に取りかかったところ。',
      // 作業机で3人が合わせて2時間作業した
      workTime: { people: 3, totalMs: 2 * 60 * 60 * 1000 },
      // 「まつもと」が20人でレイドしてきた。レイド元を残す前のレイドは時刻だけを持つ
      raids: [
        { occurredAt: '2026-09-19T12:41:00.000Z', fromUserId: '33333', fromUserLogin: 'matsumoto_dev', fromUserName: 'まつもと', viewers: 20 },
        { occurredAt: '2026-09-19T13:00:00.000Z', fromUserId: null, fromUserLogin: null, fromUserName: null, viewers: null },
      ],
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
      summary: null,
      workTime: null,
      raids: [],
    }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('chapters[0]')
  })

  it('章のチャットの件数が数でも null でもなければ、0件に読み替えずにエラーにする', async () => {
    const detail = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: null,
      title: '配信',
      categoryName: 'Just Chatting',
      samples: [],
      chapters: [{ startedAt: '2026-09-19T12:00:00.000Z', endedAt: '2026-09-19T12:30:00.000Z', title: '雑談', summary: '雑談した。', chatCount: '12件', chatterCount: 5 }],
      summary: null,
      workTime: null,
    }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('chapters[0]')
  })

  it('レイドの人数が数でも null でもなければ、黙って捨てずにエラーにする', async () => {
    const detail = {
      id: '配信ID-2026-09-19',
      startedAt: '2026-09-19T12:00:00.000Z',
      endedAt: null,
      title: '配信',
      categoryName: 'Just Chatting',
      samples: [],
      chapters: [],
      summary: null,
      workTime: null,
      raids: [{ occurredAt: '2026-09-19T12:41:00.000Z', fromUserId: '33333', fromUserLogin: 'matsumoto_dev', fromUserName: 'まつもと', viewers: '20人' }],
    }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('raids[0]')
  })

  it('あらすじが文字列でも null でもなければエラーにする', async () => {
    const detail = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting', samples: [], chapters: [], summary: 0, workTime: null, raids: [] }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('配信セッション')
  })

  it('作業した時間の合計が人数と時間の組でも null でもなければエラーにする（0 に読み替えない）', async () => {
    const detail = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting', samples: [], chapters: [], summary: null, workTime: { people: 3 }, raids: [] }
    await expect(createStatsApi(fetchReturning(200, detail).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('配信セッション')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const detailWithoutSeries = { id: '配信ID-2026-09-19', startedAt: '2026-09-19T12:00:00.000Z', endedAt: null, title: '配信', categoryName: 'Just Chatting' }
    await expect(createStatsApi(fetchReturning(200, detailWithoutSeries).fetchImpl).session('配信ID-2026-09-19')).rejects.toThrow('samples')
  })
})

const REVIEW_THEME = {
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
          hidden: true,
          people: 2,
          sources: [{ userName: 'aoi', text: 'AIのコメ返しは寂しい' }],
        },
      ],
    },
  ],
  counts: { received: 12, used: 5, pending: 0, dropped: { command: 1, emote: 2, reaction: 3 }, filtered: 0, ignored: 1, failed: 0 },
  summary: { agreements: ['AIの返事は寂しい'], disagreements: [], openQuestions: ['どこまでAIに任せるか'], createdAt: '2026-09-19T12:51:00.000Z' },
}

describe('sessionOpinions（配信の時間に開いた意見ボードのテーマ）', () => {
  it('配信IDを経路に入れて呼び、テーマごとの論点・意見・人数・内訳を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { themes: [REVIEW_THEME] })

    expect(await createStatsApi(fetchImpl).sessionOpinions('配信ID-2026-09-19')).toEqual([REVIEW_THEME])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/stats/sessions/%E9%85%8D%E4%BF%A1ID-2026-09-19/opinions')
  })

  it('テーマが無ければ空の一覧を返す', async () => {
    expect(await createStatsApi(fetchReturning(200, { themes: [] }).fetchImpl).sessionOpinions('配信ID')).toEqual([])
  })

  it('意見の形やコメントの内訳が想定と違えば、黙って捨てずにエラーにする', async () => {
    const brokenOpinion = { ...REVIEW_THEME, topics: [{ id: 5, title: '視聴者との距離', opinions: [{ id: 8, text: '種類がない' }] }] }
    await expect(createStatsApi(fetchReturning(200, { themes: [brokenOpinion] }).fetchImpl).sessionOpinions('配信ID')).rejects.toThrow('themes[0]')
    const brokenCounts = { ...REVIEW_THEME, counts: { received: '多い' } }
    await expect(createStatsApi(fetchReturning(200, { themes: [brokenCounts] }).fetchImpl).sessionOpinions('配信ID')).rejects.toThrow('themes[0]')
    const brokenSummary = { ...REVIEW_THEME, summary: { agreements: '合意の文' } }
    await expect(createStatsApi(fetchReturning(200, { themes: [brokenSummary] }).fetchImpl).sessionOpinions('配信ID')).rejects.toThrow('themes[0]')
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
