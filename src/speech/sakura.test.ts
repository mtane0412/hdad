/**
 * さくらのAI Engine での合成（sakura.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（api.test.ts と同じ形）。
 * 確かめること:
 * - 起動時の確認も合成も、さくらを直接呼ばずに Worker の経路をオーバーレイ用キー付きで呼ぶこと（APIキーをブラウザに置かないため）
 * - 合成では読み上げ文だけを送り、受け取った音声をそのまま返すこと（話者と速度は Worker が保存済みの設定から取る）
 * - Worker が失敗を返したら、その理由でエラーにすること（黙って無音にしない）
 */
import { describe, expect, it } from 'vitest'
import { createSakuraSpeech } from './sakura'

const overlayKey = 'overlay-key_0123456789abcdefghij'

interface Call {
  readonly path: string
  readonly method: string
  readonly body: string | null
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch を作る */
const fetchReturning = (response: () => Response) => {
  const calls: Call[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null })
    return response()
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

/** Workerが返す失敗（さくらが話者を拒んだとき） */
const speakerRejected = (): Response =>
  Response.json(
    { error: { code: 'speech-synthesis-failed', message: 'さくらのAI Engine が読み方の問い合わせに失敗しました（400）: This speaker is not available.' } },
    { status: 502 },
  )

describe('createSakuraSpeech', () => {
  it('起動時の確認は、Worker の確認の経路をオーバーレイ用キー付きで呼ぶ', async () => {
    const { calls, fetchImpl } = fetchReturning(() => new Response(null, { status: 204 }))

    await createSakuraSpeech(fetchImpl, overlayKey).checkReady()

    expect(calls).toEqual([{ path: `/api/overlay/speech/check?key=${encodeURIComponent(overlayKey)}`, method: 'POST', body: null }])
  })

  it('起動時の確認で Worker が失敗を返したら、その理由でエラーにする', async () => {
    const { fetchImpl } = fetchReturning(speakerRejected)

    await expect(createSakuraSpeech(fetchImpl, overlayKey).checkReady()).rejects.toThrow('This speaker is not available.')
  })

  it('合成では読み上げ文だけを Worker へ送り、受け取った音声を返す', async () => {
    const { calls, fetchImpl } = fetchReturning(() => new Response('ずんだもんの声（WAV）', { headers: { 'Content-Type': 'audio/wav' } }))

    const audio = await createSakuraSpeech(fetchImpl, overlayKey).synthesize('こんばんは', { speaker: 3, speed: 1.5 })

    expect(await audio.text()).toBe('ずんだもんの声（WAV）')
    expect(calls).toEqual([
      { path: `/api/overlay/speech/synthesis?key=${encodeURIComponent(overlayKey)}`, method: 'POST', body: JSON.stringify({ text: 'こんばんは' }) },
    ])
  })

  it('合成で Worker が失敗を返したら、その理由でエラーにする（黙って無音にしない）', async () => {
    const { fetchImpl } = fetchReturning(speakerRejected)

    await expect(createSakuraSpeech(fetchImpl, overlayKey).synthesize('こんばんは', { speaker: 3, speed: 1 })).rejects.toThrow(
      'This speaker is not available.',
    )
  })
})
