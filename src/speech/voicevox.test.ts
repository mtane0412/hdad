/**
 * VOICEVOX ENGINE の呼び出し（voicevox.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（transcript/api.test.ts と同じ形）。
 * 確かめること:
 * - 2段（/audio_query → /synthesis）で呼び、話者と読み上げ速度を渡すこと
 * - 話者と読み上げ速度は合成のたびに渡すこと（配信中に管理画面で変えられるようにするため）
 * - つながりの確認（/version）を行えること
 * - ENGINE が失敗を返したらエラーにすること（黙って無音にしない）
 */
import { describe, expect, it } from 'vitest'
import { createVoicevox, voicevoxOrigin } from './voicevox'

/** VOICEVOX ENGINE が /audio_query で返す、読み方の問い合わせ（テストで使う項目だけを持つ） */
const readingQuery = { accent_phrases: [], speedScale: 1, volumeScale: 1, kana: 'コンニチハ' }

interface call {
  readonly url: string
  readonly method: string
  readonly body: string | null
}

/**
 * 呼ばれた内容を記録する fetch を作る。
 *
 * @param response URLの一部（audio_query・synthesis・version）ごとに返す応答
 */
const fetchReturning = (response: (url: string) => Response) => {
  const calls: call[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })
    return response(url)
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

/** 正常に音声を返す ENGINE */
const okResponse = (url: string): Response => {
  if (url.includes('/audio_query')) return Response.json(readingQuery)
  if (url.includes('/synthesis')) return new Response(new Blob(['音声データ'], { type: 'audio/wav' }))
  return Response.json('0.23.0')
}

const baseUrl = voicevoxOrigin('localhost', 50021)
/** 前提: 配信サイト（このページ）から、同じPCのENGINEを呼ぶ。つなぎ先は起動のときに決まる */
const endpoint = { origin: baseUrl, pageOrigin: 'https://hdad.example.workers.dev' }
/** 前提: ずんだもん（ノーマル）を標準の速さで読ませる。声の設定は合成のたびに渡す */
const voiceConfig = { speaker: 3, speed: 1 }

describe('voicevoxOrigin', () => {
  it('ホストとポートから、同じPCのENGINEの起点を組み立てる', () => {
    expect(voicevoxOrigin('127.0.0.1', 50022)).toBe('http://127.0.0.1:50022')
  })
})

describe('synthesize', () => {
  it('読み方を問い合わせてから音声を合成し、話者IDを両方に渡す', async () => {
    const { calls, fetchImpl } = fetchReturning(okResponse)

    const audio = await createVoicevox(fetchImpl, endpoint).synthesize('こんにちは', voiceConfig)

    expect(audio.type).toBe('audio/wav')
    expect(calls[0]).toEqual({
      url: `${baseUrl}/audio_query?speaker=3&text=${encodeURIComponent('こんにちは')}`,
      method: 'POST',
      body: null,
    })
    expect(calls[1]?.url).toBe(`${baseUrl}/synthesis?speaker=3`)
    expect(calls[1]?.method).toBe('POST')
  })

  it('読み上げ速度を、問い合わせの speedScale に差し替えて合成させる', async () => {
    const { calls, fetchImpl } = fetchReturning(okResponse)

    await createVoicevox(fetchImpl, endpoint).synthesize('こんにちは', { ...voiceConfig, speed: 1.3 })

    expect(JSON.parse(calls[1]?.body ?? 'null')).toEqual({ ...readingQuery, speedScale: 1.3 })
  })

  it('同じつなぎ先のまま、合成ごとに違う話者と速度を渡せる（配信中に管理画面で変えられるようにするため）', async () => {
    const { calls, fetchImpl } = fetchReturning(okResponse)
    const voicevox = createVoicevox(fetchImpl, endpoint)

    await voicevox.synthesize('こんにちは', { speaker: 3, speed: 1 })
    await voicevox.synthesize('こんばんは', { speaker: 8, speed: 1.5 })

    expect(calls[0]?.url).toContain('speaker=3')
    expect(calls[2]?.url).toContain('speaker=8')
    expect(JSON.parse(calls[3]?.body ?? 'null')).toMatchObject({ speedScale: 1.5 })
  })

  it('読み方の問い合わせに失敗したらエラーにする', async () => {
    const { fetchImpl } = fetchReturning(() => new Response('話者が見つかりません', { status: 422 }))

    await expect(createVoicevox(fetchImpl, endpoint).synthesize('こんにちは', { ...voiceConfig, speaker: 999 })).rejects.toThrow(/VOICEVOX/)
  })

  it('音声の合成に失敗したらエラーにする', async () => {
    const { fetchImpl } = fetchReturning((url) => (url.includes('/audio_query') ? Response.json(readingQuery) : new Response('', { status: 500 })))

    await expect(createVoicevox(fetchImpl, endpoint).synthesize('こんにちは', voiceConfig)).rejects.toThrow(/VOICEVOX/)
  })
})

describe('checkReady', () => {
  it('ENGINEのバージョンを読めれば、つながっていると分かる', async () => {
    const { calls, fetchImpl } = fetchReturning(okResponse)

    await createVoicevox(fetchImpl, endpoint).checkReady()

    expect(calls).toEqual([{ url: `${baseUrl}/version`, method: 'GET', body: null }])
  })

  it('つながらなければ、考えられる原因（起動・ポート・CORSの許可）を並べたエラーにする', async () => {
    const { fetchImpl } = fetchReturning(() => {
      throw new TypeError('Failed to fetch')
    })

    const failure = createVoicevox(fetchImpl, endpoint).checkReady()

    // OBSの画面にはこの文面しか出ないので、いちばん多い原因（別オリジンからの通信の拒否）と直し方まで含める
    await expect(failure).rejects.toThrow(/VOICEVOX が起動していない/)
    await expect(failure).rejects.toThrow(/ポート番号/)
    await expect(failure).rejects.toThrow(new RegExp(`${baseUrl}/setting`))
    await expect(failure).rejects.toThrow(/https:\/\/hdad\.example\.workers\.dev/)
    await expect(failure).rejects.toThrow(/Failed to fetch/)
  })
})
