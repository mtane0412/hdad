/**
 * 手書きの線の経路（/api/admin/draw/socket・/api/overlay/draw）のテスト
 *
 * 確かめるのは次の6点である。
 * - 描く画面（配信者のセッション）からの接続が、描く側として中継先へ引き渡されること
 * - 合成ページ（オーバーレイ用キー）からの接続が、見るだけとして引き渡されること
 * - ログインしていない接続・キーの誤った接続を断ること
 * - 別のサイトから開かれた接続を断ること（WebSocketはGETなので、書き換えのときのCSRF対策が効かない）
 * - 描いたものの保存と読み出しが、配信者のセッション（描く画面）とオーバーレイ用キー（合成ページ）の両方から通ること
 * - 検証に通らない線の保存を、問題点を添えて断ること
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { recordScreenCapture } from './screen-store'
import { recordStreamOnline } from './stats-store'
import { createSessionToken } from './session'

const 現在時刻 = Date.parse('2026-09-29T09:00:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'

const 環境を作る = () => {
  const 中継先 = createFakeDrawChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': 発行済みのキー }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: 中継先.namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, 中継先 }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}

const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env) => handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** ブラウザがWebSocketをつなぐときと同じヘッダーで呼ぶ */
const つなぐ = (env: Env, path: string, headers: Record<string, string> = {}) =>
  呼び出す(new Request(`${サイト}${path}`, { headers: { Upgrade: 'websocket', Origin: サイト, ...headers } }), env)

/** 配信者としてログインした状態でつなぐ */
const 配信者としてつなぐ = async (env: Env, path: string, headers: Record<string, string> = {}) => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  return つなぐ(env, path, { Cookie: `__Host-session=${session}`, ...headers })
}

describe('GET /api/admin/draw/socket', () => {
  it('配信者の接続を、描く側として中継先へ引き渡す', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await 配信者としてつなぐ(env, '/api/admin/draw/socket')

    expect(response.status).toBe(200)
    expect(中継先.引き渡された接続.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['writer'])
  })

  it('ログインしていない接続は断る', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, '/api/admin/draw/socket')

    expect(response.status).toBe(401)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('別のサイトから開かれた接続は断る', async () => {
    // WebSocketの接続はGETなので、書き換えのときの送信元の確認（requireAdmin）が効かない。
    // SameSite=Lax のクッキーは別サイトからのWebSocketには付かないが、ブラウザの決まりだけに頼らず確かめる
    const { env, 中継先 } = 環境を作る()

    const response = await 配信者としてつなぐ(env, '/api/admin/draw/socket', { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = 環境を作る()
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)

    const response = await 呼び出す(new Request(`${サイト}/api/admin/draw/socket`, { headers: { Cookie: `__Host-session=${session}`, Origin: サイト } }), env)

    expect(response.status).toBe(400)
  })
})

describe('GET /api/overlay/draw', () => {
  it('オーバーレイ用キーの合う接続を、見るだけとして中継先へ引き渡す', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, `/api/overlay/draw?key=${発行済みのキー}`)

    expect(response.status).toBe(200)
    expect(中継先.引き渡された接続.map(({ url }) => new URL(url).searchParams.get('role'))).toEqual(['viewer'])
  })

  it('オーバーレイ用キーが違う接続は断る', async () => {
    const { env, 中継先 } = 環境を作る()

    const response = await つなぐ(env, '/api/overlay/draw?key=違うキー')

    expect(response.status).toBe(401)
    expect(中継先.引き渡された接続).toEqual([])
  })

  it('WebSocketでない要求は断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/draw?key=${発行済みのキー}`), env)

    expect(response.status).toBe(400)
  })
})

/** 描く画面が保存のときに送るのと同じ形で呼ぶ */
const 保存する = (env: Env, body: unknown, headers: Record<string, string> = {}) =>
  呼び出す(
    new Request(`${サイト}/api/admin/draw/strokes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: サイト, ...headers },
      body: JSON.stringify(body),
    }),
    env,
  )

/** 配信者としてログインした状態で保存する */
const 配信者として保存する = async (env: Env, body: unknown) => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  return 保存する(env, body, { Cookie: `__Host-session=${session}` })
}

/** 配信画面に引いた線1本 */
const 引いた線 = { id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }

describe('PUT・GET /api/admin/draw/strokes', () => {
  it('配信者が描いた線を保存し、同じ形で読み出せる', async () => {
    // OBSのブラウザソースを作り直しても描いたものが残るように、引き終えた線をKVへ写す
    const { env } = 環境を作る()
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)

    const 保存の応答 = await 配信者として保存する(env, { strokes: [引いた線] })
    const 読み出しの応答 = await 呼び出す(new Request(`${サイト}/api/admin/draw/strokes`, { headers: { Cookie: `__Host-session=${session}` } }), env)

    expect(保存の応答.status).toBe(200)
    expect(await 読み出しの応答.json()).toEqual({ strokes: [引いた線] })
  })

  it('ログインしていない保存は断る', async () => {
    const { env } = 環境を作る()

    const response = await 保存する(env, { strokes: [引いた線] })

    expect(response.status).toBe(401)
  })

  it('検証に通らない線は、問題点を添えて断る', async () => {
    const { env } = 環境を作る()

    const response = await 配信者として保存する(env, { strokes: [{ ...引いた線, color: 'magenta' }] })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { problems: [expect.stringContaining('strokes[0]')] } })
  })
})

describe('GET /api/overlay/draw/strokes', () => {
  it('合成ページがオーバーレイ用キーで、保存されている線を読める', async () => {
    const { env } = 環境を作る()
    await 配信者として保存する(env, { strokes: [引いた線] })

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/draw/strokes?key=${発行済みのキー}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ strokes: [引いた線] })
  })

  it('一度も描いていなければ、線が無い状態を返す', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/draw/strokes?key=${発行済みのキー}`), env)

    expect(await response.json()).toEqual({ strokes: [] })
  })

  it('オーバーレイ用キーが違う読み出しは断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/draw/strokes?key=違うキー`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/admin/draw/background', () => {
  const 撮った時刻 = Date.parse('2026-09-29T08:59:00Z')
  const 画像のID = 'abcdef0123456789abcdef0123456789'
  const 画像のURL = `https://i.gyazo.com/${画像のID}.png`

  /** Gyazo の1枚の情報を返し、呼ばれた回数を数える fetch */
  const Gyazoを数える = () => {
    const 呼ばれたURL: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      呼ばれたURL.push(String(input))
      return Response.json({ image_id: 画像のID, url: 画像のURL, access_policy: 'anyone' })
    }) as typeof fetch
    return { fetchImpl, 呼ばれたURL }
  }

  /** 配信者としてログインした状態で背景を読む */
  const 配信者として背景を読む = async (env: Env, fetchImpl: typeof fetch, headers: Record<string, string> = {}) => {
    const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
    return handleRequest(new Request(`${サイト}/api/admin/draw/background`, { headers: { Cookie: `__Host-session=${session}`, ...headers } }), env, {
      fetch: fetchImpl,
      now: () => 現在時刻,
      wait: 待たない,
      waitUntil: 後回しにしない,
    })
  }

  /** 配信中に画面の取り込みが1枚撮った状態にする */
  const 撮っておく = async (env: Env) => {
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 撮った時刻 - 60_000 })
    await recordScreenCapture(env.DB, 画像のID, 撮った時刻)
  }

  const Gyazoのトークン付きの環境 = () => {
    const { env } = 環境を作る()
    return { ...env, GYAZO_ACCESS_TOKEN: 'テスト用のGyazoトークン' } satisfies Env
  }

  it('最後に撮った1枚の画像のURLと撮った時刻を返す。手元に残さないよう指示する', async () => {
    const env = Gyazoのトークン付きの環境()
    await 撮っておく(env)

    const response = await 配信者として背景を読む(env, Gyazoを数える().fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ imageId: 画像のID, capturedAt: 撮った時刻, url: 画像のURL })
    expect(response.headers.get('ETag')).toBe(`"${画像のID}"`)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('手元と同じ1枚なら、Gyazo を呼ばずに304を返す', async () => {
    const env = Gyazoのトークン付きの環境()
    await 撮っておく(env)
    const { fetchImpl, 呼ばれたURL } = Gyazoを数える()

    const response = await 配信者として背景を読む(env, fetchImpl, { 'If-None-Match': `"${画像のID}"` })

    expect(response.status).toBe(304)
    expect(呼ばれたURL).toEqual([])
  })

  it('まだ1枚も撮っていなければ204を返す', async () => {
    const response = await 配信者として背景を読む(Gyazoのトークン付きの環境(), Gyazoを数える().fetchImpl)

    expect(response.status).toBe(204)
  })

  it('Gyazo のアクセストークンが無ければ失敗させる（黙って背景なしにしない）', async () => {
    const { env } = 環境を作る()
    await 撮っておく(env)

    const response = await 配信者として背景を読む(env, Gyazoを数える().fetchImpl)

    expect(response.status).toBe(500)
  })

  it('ログインしていなければ断る', async () => {
    const { env } = 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/draw/background`), env)

    expect(response.status).toBe(401)
  })
})
