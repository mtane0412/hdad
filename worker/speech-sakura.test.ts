/**
 * さくらのAI Engine の音声合成（speech-sakura.ts）のテスト
 *
 * さくらへの通信は代役に差し替え、送った要求と受け取った応答の扱いを確かめる。特に重要なのは次の3点。
 * - 合成は audio_query → synthesis の2段で、読み上げ速度は合成の時点で差し込むこと（声の高さを変えないため）
 * - 合成した音声は加工せずにそのまま返すこと（MP3 への変換などで Worker の CPU 時間を使わないため）
 * - さくらが失敗を返したら、さくらの理由（規約に同意していない話者など）を添えて投げること
 */
import { describe, expect, it } from 'vitest'
import { createSakuraTts, SAKURA_TTS_ORIGIN } from './speech-sakura'

/** テストで使うAPIキー（ヘッダーに載せるので英数字にする） */
const apiKey = 'sakura-test-api-key'

/** 送られた要求の記録 */
interface SentRequest {
  url: string
  method: string
  authorization: string | null
  contentType: string | null
  body: string | null
}

/**
 * さくらの代役を作る。audio_query には読み方を、synthesis には音声を返す。
 *
 * @param respond 経路ごとの応答を差し替えたいときに渡す
 */
const createFakeSakura = (respond: (url: URL) => Response | undefined = () => undefined) => {
  const sent: SentRequest[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    sent.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('Authorization'),
      contentType: request.headers.get('Content-Type'),
      body: request.method === 'POST' ? await request.text() : null,
    })
    const url = new URL(request.url)
    const replaced = respond(url)
    if (replaced) return replaced
    if (url.pathname === '/tts/v1/audio_query') return Response.json({ accent_phrases: [], speedScale: 1, pitchScale: 0 })
    if (url.pathname === '/tts/v1/synthesis') return new Response('ずんだもんの声（WAV）', { headers: { 'Content-Type': 'audio/wav' } })
    return new Response('Not Found', { status: 404 })
  }
  return { fetchImpl, sent }
}

describe('createSakuraTts', () => {
  describe('synthesize', () => {
    it('audio_query で読み方を作らせ、読み上げ速度を差し込んで synthesis へ渡す', async () => {
      const { fetchImpl, sent } = createFakeSakura()

      await createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 1, speed: 1.3 })

      expect(sent).toMatchObject([
        { url: `${SAKURA_TTS_ORIGIN}/tts/v1/audio_query?speaker=1&text=${encodeURIComponent('こんばんは')}`, method: 'POST' },
        { url: `${SAKURA_TTS_ORIGIN}/tts/v1/synthesis?speaker=1`, method: 'POST', contentType: 'application/json' },
      ])
      // 読み方の内容はそのまま渡し、読み上げ速度だけを差し替える
      expect(JSON.parse(sent[1]?.body ?? '')).toEqual({ accent_phrases: [], speedScale: 1.3, pitchScale: 0 })
    })

    it('どちらの呼び出しにも Bearer でAPIキーを付ける', async () => {
      const { fetchImpl, sent } = createFakeSakura()

      await createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 1, speed: 1 })

      expect(sent.map((request) => request.authorization)).toEqual([`Bearer ${apiKey}`, `Bearer ${apiKey}`])
    })

    it('合成した音声を、加工せずに WAV のまま返す', async () => {
      const { fetchImpl } = createFakeSakura()

      const audio = await createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 1, speed: 1 })

      expect(audio.headers.get('Content-Type')).toBe('audio/wav')
      expect(await audio.text()).toBe('ずんだもんの声（WAV）')
    })

    it('さくらが話者を拒んだら、さくらの理由を添えて投げる（規約に同意していない話者を見分けられるようにする）', async () => {
      const { fetchImpl, sent } = createFakeSakura((url) =>
        url.pathname === '/tts/v1/audio_query' ? Response.json({ detail: 'This speaker is not available.' }, { status: 400 }) : undefined,
      )

      await expect(createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 3, speed: 1 })).rejects.toThrow(
        /読み方の問い合わせ.*400.*This speaker is not available\./,
      )
      // 読み方が作れなければ、課金される合成は呼ばない
      expect(sent).toHaveLength(1)
    })

    it('合成に失敗したら、さくらの理由を添えて投げる', async () => {
      const { fetchImpl } = createFakeSakura((url) =>
        url.pathname === '/tts/v1/synthesis' ? Response.json({ detail: 'This model is not available.' }, { status: 400 }) : undefined,
      )

      await expect(createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 1, speed: 1 })).rejects.toThrow(
        /音声の合成.*400.*This model is not available\./,
      )
    })

    it('読み方の問い合わせの応答がオブジェクトでなければ投げる（黙って標準速度で読まない）', async () => {
      const { fetchImpl } = createFakeSakura((url) => (url.pathname === '/tts/v1/audio_query' ? Response.json('読み方') : undefined))

      await expect(createSakuraTts({ fetch: fetchImpl, apiKey }).synthesize('こんばんは', { speaker: 1, speed: 1 })).rejects.toThrow(
        '読み方の問い合わせ',
      )
    })
  })

  describe('checkSpeaker', () => {
    it('課金されない audio_query だけを呼んで、話者が使えることを確かめる', async () => {
      const { fetchImpl, sent } = createFakeSakura()

      await createSakuraTts({ fetch: fetchImpl, apiKey }).checkSpeaker(7)

      expect(sent.map((request) => new URL(request.url).pathname)).toEqual(['/tts/v1/audio_query'])
      expect(new URL(sent[0]?.url ?? '').searchParams.get('speaker')).toBe('7')
    })

    it('話者が使えなければ、さくらの理由を添えて投げる', async () => {
      const { fetchImpl } = createFakeSakura(() => Response.json({ detail: 'This speaker is not available.' }, { status: 400 }))

      await expect(createSakuraTts({ fetch: fetchImpl, apiKey }).checkSpeaker(3)).rejects.toThrow('This speaker is not available.')
    })
  })
})
