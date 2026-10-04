/**
 * 市町村紹介の経路（GET /api/overlay/town-tour）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - オーバーレイ用キーが無ければ断る
 * - 一覧に無いコードは、Wikipedia も LLM も呼ばずに 404 で断る
 * - 一覧のコードなら、対応する記事を Wikipedia から取り、LLM に紹介を作らせ、出典の URL と一緒に返す
 * - 記事が取れない・LLM の応答の形が違うときは 502 で理由を返し、ダッシュボードの失敗の記録にも残す
 *
 * - 合成ページの素材「市町村紹介」の WebSocket の接続を、市町村紹介を受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/town-tour/demo）は、ログインした配信者にだけ、市町村を1つ引いて押し出す
 * - 音の設定（GET・PUT /api/admin/town-tour/sound）は、ログインした配信者にだけ読み書きさせ、音声でない素材を選んだ設定は400で断る
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
import { createSessionToken } from './session'
import { listFailures } from './stats-store'
import { DEFAULT_TOWN_TOUR_SOUND, loadTownTourSound, saveTownTourSound } from './town-tour-sound'

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

const createEnv = (aiResponse: string, alertChannel = createFakeAlertChannel()) =>
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
    ALERTS: alertChannel.namespace,
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

const invoke = (path: string, env: Env, fetchImpl: typeof fetch, init: RequestInit = {}) =>
  handleRequest(new Request(`${site}${path}`, init), env, {
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

  it('失敗の記録そのものに失敗しても、紹介を作れなかった理由を 502 で返し、記録の失敗も添える', async () => {
    // 前提: データベース（D1）への書き込みが失敗する
    const env = { ...createEnv('府中市は広島県の市です。'), DB: { ...createFakeDatabase(), batch: () => Promise.reject(new Error('D1 が応答しません')) } }
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('town-tour-failed')
    expect(body.error.message).toContain('JSON')
    expect(body.error.message).toContain('D1 が応答しません')
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

describe('GET /api/overlay/town-tour/socket', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/town-tour/socket?key=${overlayKey}`, createEnv(''), noFetch)

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、市町村紹介を受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)

    const response = await handleRequest(new Request(`${site}/api/overlay/town-tour/socket?key=${overlayKey}`, { headers: { Upgrade: 'websocket' } }), env, {
      fetch: noFetch,
      now: () => now,
      wait: async () => {},
      waitUntil: () => undefined,
    })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['townTour'])
  })
})

describe('POST /api/admin/town-tour/demo', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  /** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/town-tour/demo', env, noFetch, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site },
    })
  }

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/town-tour/demo', createEnv('', alertChannel), noFetch, { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedTownTours).toEqual([])
  })

  it('市町村を1つ引き、試し再生と分かる一文を添えて押し出し、押し出したものを返す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv('', alertChannel))

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTownTours).toHaveLength(1)
    expect(alertChannel.pushedTownTours[0]?.headline).toMatch(/^試し再生: 本日は.+をご紹介します$/)
    expect(await response.json()).toEqual(alertChannel.pushedTownTours[0])
  })

  it('配送先が失敗したら、黙って成功にせず 502 で返す', async () => {
    const response = await callAsBroadcaster(createEnv('', createFakeAlertChannel({ shouldFail: true })))

    expect(response.status).toBe(502)
  })

  it('保存した音の設定を、トリガーと同じく音声のURLにして一緒に押し出す（試し再生で聞き比べられるように）', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)
    await saveTownTourSound(env.STORE, { ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, landing: 'media-peta' } })

    await callAsBroadcaster(env)

    expect(alertChannel.pushedTownTours[0]?.sound.slots.landing).toBe(`/api/media/media-peta?key=${overlayKey}`)
  })
})

describe('GET・PUT /api/admin/town-tour/sound', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/town-tour/sound', env, noNetwork, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }
  const noNetwork: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  /** BGM（ピアノの曲）と着地の効果音、地図の画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv('')
    await env.MEDIA.put('media-cookie', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'cookie-cookie.mp3' } })
    await env.MEDIA.put('media-peta', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'peta1.mp3' } })
    await env.MEDIA.put('media-chizu', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'chizu.png' } })
    return env
  }

  const sound = {
    slots: { bgm: 'media-cookie', opening: null, zoom: null, landing: 'media-peta', item: null, closing: null },
    bgmVolume: 0.25,
    effectVolume: 0.8,
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/town-tour/sound', createEnv(''), noNetwork)

    expect(response.status).toBe(401)
  })

  it('未保存なら、どの枠も鳴らさない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv(''))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_TOWN_TOUR_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify({ ...sound, slots: { ...sound.slots, zoom: 'media-chizu' } }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['slots.zoom: 素材「media-chizu」は音声ではありません'])
    expect(await loadTownTourSound(env.STORE)).toEqual(DEFAULT_TOWN_TOUR_SOUND)
  })
})
