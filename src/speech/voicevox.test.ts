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
const 読み方の問い合わせ = { accent_phrases: [], speedScale: 1, volumeScale: 1, kana: 'コンニチハ' }

interface 呼び出し {
  readonly url: string
  readonly method: string
  readonly body: string | null
}

/**
 * 呼ばれた内容を記録する fetch を作る。
 *
 * @param 応答 URLの一部（audio_query・synthesis・version）ごとに返す応答
 */
const 応答を返すfetch = (応答: (url: string) => Response) => {
  const 呼び出し一覧: 呼び出し[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    呼び出し一覧.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })
    return 応答(url)
  }
  return { 呼び出し一覧, fetchImpl: fetchImpl as unknown as typeof fetch }
}

/** 正常に音声を返す ENGINE */
const 正常な応答 = (url: string): Response => {
  if (url.includes('/audio_query')) return Response.json(読み方の問い合わせ)
  if (url.includes('/synthesis')) return new Response(new Blob(['音声データ'], { type: 'audio/wav' }))
  return Response.json('0.23.0')
}

const 起点 = voicevoxOrigin('localhost', 50021)
/** 前提: 配信サイト（このページ）から、同じPCのENGINEを呼ぶ。つなぎ先は起動のときに決まる */
const つなぎ先 = { origin: 起点, pageOrigin: 'https://hdad.example.workers.dev' }
/** 前提: ずんだもん（ノーマル）を標準の速さで読ませる。声の設定は合成のたびに渡す */
const 声の設定 = { speaker: 3, speed: 1 }

describe('voicevoxOrigin', () => {
  it('ホストとポートから、同じPCのENGINEの起点を組み立てる', () => {
    expect(voicevoxOrigin('127.0.0.1', 50022)).toBe('http://127.0.0.1:50022')
  })
})

describe('synthesize', () => {
  it('読み方を問い合わせてから音声を合成し、話者IDを両方に渡す', async () => {
    const { 呼び出し一覧, fetchImpl } = 応答を返すfetch(正常な応答)

    const 音声 = await createVoicevox(fetchImpl, つなぎ先).synthesize('こんにちは', 声の設定)

    expect(音声.type).toBe('audio/wav')
    expect(呼び出し一覧[0]).toEqual({
      url: `${起点}/audio_query?speaker=3&text=${encodeURIComponent('こんにちは')}`,
      method: 'POST',
      body: null,
    })
    expect(呼び出し一覧[1]?.url).toBe(`${起点}/synthesis?speaker=3`)
    expect(呼び出し一覧[1]?.method).toBe('POST')
  })

  it('読み上げ速度を、問い合わせの speedScale に差し替えて合成させる', async () => {
    const { 呼び出し一覧, fetchImpl } = 応答を返すfetch(正常な応答)

    await createVoicevox(fetchImpl, つなぎ先).synthesize('こんにちは', { ...声の設定, speed: 1.3 })

    expect(JSON.parse(呼び出し一覧[1]?.body ?? 'null')).toEqual({ ...読み方の問い合わせ, speedScale: 1.3 })
  })

  it('同じつなぎ先のまま、合成ごとに違う話者と速度を渡せる（配信中に管理画面で変えられるようにするため）', async () => {
    const { 呼び出し一覧, fetchImpl } = 応答を返すfetch(正常な応答)
    const voicevox = createVoicevox(fetchImpl, つなぎ先)

    await voicevox.synthesize('こんにちは', { speaker: 3, speed: 1 })
    await voicevox.synthesize('こんばんは', { speaker: 8, speed: 1.5 })

    expect(呼び出し一覧[0]?.url).toContain('speaker=3')
    expect(呼び出し一覧[2]?.url).toContain('speaker=8')
    expect(JSON.parse(呼び出し一覧[3]?.body ?? 'null')).toMatchObject({ speedScale: 1.5 })
  })

  it('読み方の問い合わせに失敗したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(() => new Response('話者が見つかりません', { status: 422 }))

    await expect(createVoicevox(fetchImpl, つなぎ先).synthesize('こんにちは', { ...声の設定, speaker: 999 })).rejects.toThrow(/VOICEVOX/)
  })

  it('音声の合成に失敗したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch((url) => (url.includes('/audio_query') ? Response.json(読み方の問い合わせ) : new Response('', { status: 500 })))

    await expect(createVoicevox(fetchImpl, つなぎ先).synthesize('こんにちは', 声の設定)).rejects.toThrow(/VOICEVOX/)
  })
})

describe('checkReady', () => {
  it('ENGINEのバージョンを読めれば、つながっていると分かる', async () => {
    const { 呼び出し一覧, fetchImpl } = 応答を返すfetch(正常な応答)

    await createVoicevox(fetchImpl, つなぎ先).checkReady()

    expect(呼び出し一覧).toEqual([{ url: `${起点}/version`, method: 'GET', body: null }])
  })

  it('つながらなければ、考えられる原因（起動・ポート・CORSの許可）を並べたエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(() => {
      throw new TypeError('Failed to fetch')
    })

    const 失敗 = createVoicevox(fetchImpl, つなぎ先).checkReady()

    // OBSの画面にはこの文面しか出ないので、いちばん多い原因（別オリジンからの通信の拒否）と直し方まで含める
    await expect(失敗).rejects.toThrow(/VOICEVOX が起動していない/)
    await expect(失敗).rejects.toThrow(/ポート番号/)
    await expect(失敗).rejects.toThrow(new RegExp(`${起点}/setting`))
    await expect(失敗).rejects.toThrow(/https:\/\/hdad\.example\.workers\.dev/)
    await expect(失敗).rejects.toThrow(/Failed to fetch/)
  })
})
