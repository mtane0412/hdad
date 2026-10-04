/**
 * 市町村紹介の経路（GET /api/overlay/town-tour）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - オーバーレイ用キーが無ければ断る
 * - 一覧に無いコードは、Wikipedia も LLM も呼ばずに 404 で断る
 * - 一覧のコードなら、対応する記事を Wikipedia から取り、LLM に紹介を作らせ、出典の URL と一緒に返す
 * - 記事が取れない・LLM の応答の形が違うときは 502 で理由を返し、ダッシュボードの失敗の記録にも残す
 *
 * 材料の拾い方と紹介の読み取りは worker/town-wikipedia.test.ts・worker/town-tour.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { listFailures } from './stats-store'

const now = Date.parse('2026-10-04T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'

/** 広島県府中市（一覧のコード 34208。記事名は「府中市 (広島県)」） */
const FUCHU_HIROSHIMA = '34208'

/** LLM が返す、正しい形の紹介 */
const fuchuTour = {
  location: '広島県の南東部、芦田川が流れる盆地の市です。',
  nameOrigin: '備後国の国府が置かれたことに由来するとされます。',
  history: '',
  specialty: '約400年の歴史を持つ府中味噌が名物です。',
  surprise: 'ミンチ肉を使う「府中焼き」というお好み焼きがあります。',
}

const createEnv = (aiResponse: string) =>
  ({
    STORE: createFakeStore({ 'overlay-key': overlayKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi({ response: aiResponse }),
  }) satisfies Env

/** Wikipedia の API だけに答える通信の代役。渡された URL を控える */
const fakeWikipedia = (body: unknown) => {
  const urls: URL[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname !== 'ja.wikipedia.org') throw new Error(`テストで想定していない通信です: ${url.href}`)
    urls.push(url)
    return Response.json(body)
  }
  return { fetchImpl, urls }
}

/** 府中市 (広島県) の記事を返す Wikipedia の応答 */
const fuchuArticle = {
  query: {
    pages: [
      {
        pageid: 1,
        title: '府中市 (広島県)',
        extract: ['府中市は、広島県の南東部に位置する市。', '== 名物 ==', '府中味噌 - およそ400年の歴史を持つ味噌。'].join('\n'),
      },
    ],
  },
}

const invoke = (path: string, env: Env, fetchImpl: typeof fetch) =>
  handleRequest(new Request(`${site}${path}`), env, {
    fetch: fetchImpl,
    now: () => now,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

describe('GET /api/overlay/town-tour', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=wrong-key&code=${FUCHU_HIROSHIMA}`, createEnv(JSON.stringify(fuchuTour)), fetchImpl)

    expect(response.status).toBe(401)
  })

  it('一覧に無いコードは、外を呼ばずに 404 で断る', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl, urls } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=99999`, env, fetchImpl)

    expect(response.status).toBe(404)
    expect(urls).toEqual([])
    expect(env.AI.calls).toEqual([])
  })

  it('一覧のコードなら、記事を材料に紹介を作り、出典の URL と一緒に返す', async () => {
    const { fetchImpl, urls } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, createEnv(JSON.stringify(fuchuTour)), fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      code: FUCHU_HIROSHIMA,
      prefecture: '広島県',
      county: '',
      name: '府中市',
      article: { title: '府中市 (広島県)', url: 'https://ja.wikipedia.org/wiki/%E5%BA%9C%E4%B8%AD%E5%B8%82_(%E5%BA%83%E5%B3%B6%E7%9C%8C)' },
      tour: fuchuTour,
    })
    // 名前（府中市）ではなく、コードから引いた記事名で取りに行く
    expect(urls.map((url) => url.searchParams.get('titles'))).toEqual(['府中市 (広島県)'])
  })

  it('記事が取れなければ 502 で理由を返し、失敗の記録に残す', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ title: '府中市 (広島県)', missing: true }] } })

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-failed', message: expect.stringContaining('府中市 (広島県)') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-failed' })])
  })

  it('LLM の応答の形が違えば 502 で理由を返し、失敗の記録に残す', async () => {
    const env = createEnv('府中市は広島県の市です。')
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-failed', message: expect.stringContaining('JSON') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-failed' })])
  })
})
