/**
 * 配信画面の取り込みの経路（/api/admin/screen・/api/overlay/screen）のテスト
 *
 * KV・R2・D1と外への通信を差し替え、handleRequest を通して確かめる。特に重要なのは次の5点である。
 * - 裏方のページ（オーバーレイ用キー）が、管理画面（セッション）で保存したつなぎ先の設定を読めること
 * - 裏方のページに、撮るのに要らない設定（上げ先のコレクション）は渡さないこと
 * - 撮った1枚が Gyazo へ渡り、その画像IDが記録されること
 * - 配信していなければ Gyazo へ上げないこと（配信前の準備画面を外へ出さないため）
 * - Gyazo のアクセストークンが無いとき、黙って捨てずに失敗させること（Fail-Fast）
 * - 画像でない本文や大きすぎる本文を、読み込む前に拒むこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { DEFAULT_SCREEN_SETTINGS } from './screen-config'
import { createSessionToken } from './session'
import { recordStreamOnline } from './stats-store'

const 現在時刻 = Date.parse('2026-09-28T12:05:00Z')
const 配信の開始 = Date.parse('2026-09-28T12:00:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'
const 画像のID = 'abcdef0123456789abcdef0123456789'
const セッションの秘密鍵 = 'テスト用のセッション秘密鍵'

/** @param gyazoのトークン null を渡すと、トークンが未設定の環境になる */
const 環境を作る = (gyazoのトークン: string | null = 'テスト用のGyazoトークン') => {
  const env = {
    STORE: createFakeStore({ 'overlay-key': 発行済みのキー }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: セッションの秘密鍵,
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
    GYAZO_ACCESS_TOKEN: gyazoのトークン ?? undefined,
  } satisfies Env
  return { env }
}

const 通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}
const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env, fetchImpl = 通信しない) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

const ログイン済みの見出し = async (追加: Record<string, string> = {}): Promise<Record<string, string>> => ({
  Cookie: `__Host-session=${await createSessionToken(配信者のID, セッションの秘密鍵, 現在時刻)}`,
  ...追加,
})

/** Gyazo へのアップロードを覚えたうえで、決めておいた画像IDを返す fetch を作る */
const Gyazoを覚える = () => {
  const 受け取った: { url: string; body: FormData }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    受け取った.push({ url: String(input), body: init?.body as FormData })
    return Response.json({ image_id: 画像のID, permalink_url: `https://gyazo.com/${画像のID}` })
  }) as typeof fetch
  return { fetchImpl, 受け取った }
}

/** 管理画面から設定を保存する */
const 設定を保存する = async (env: Env, 設定: Record<string, unknown>) =>
  呼び出す(
    new Request(`${サイト}/api/admin/screen`, {
      method: 'PUT',
      headers: await ログイン済みの見出し({ Origin: サイト, 'Content-Type': 'application/json' }),
      body: JSON.stringify(設定),
    }),
    env,
  )

/** 正しく埋まった設定（保存のテストで使う） */
const 保存する設定 = {
  host: '127.0.0.1',
  port: 4456,
  password: 'obsのパスワード',
  intervalSeconds: 90,
  collectionId: 'f19e74cebe47c9cadad31b6790098eac',
}

const 画像の本文 = (): Uint8Array => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const 撮った1枚を送る = (本文: BodyInit, contentType = 'image/png') =>
  new Request(`${サイト}/api/overlay/screen?key=${発行済みのキー}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: 本文,
  })

describe('GET /api/overlay/screen', () => {
  it('未保存なら既定のつなぎ先を返す', async () => {
    const { env } = 環境を作る()
    const 応答 = await 呼び出す(new Request(`${サイト}/api/overlay/screen?key=${発行済みのキー}`), env)

    expect(応答.status).toBe(200)
    const { host, port, password, intervalSeconds } = DEFAULT_SCREEN_SETTINGS
    expect(await 応答.json()).toEqual({ host, port, password, intervalSeconds })
  })

  it('オーバーレイ用キーが違えば拒む', async () => {
    const { env } = 環境を作る()
    const 応答 = await 呼び出す(new Request(`${サイト}/api/overlay/screen?key=違うキー`), env)

    expect(応答.status).toBe(401)
  })

  it('管理画面で保存したつなぎ先を、裏方のページが読める', async () => {
    const { env } = 環境を作る()
    expect((await 設定を保存する(env, 保存する設定)).status).toBe(200)

    const 応答 = await 呼び出す(new Request(`${サイト}/api/overlay/screen?key=${発行済みのキー}`), env)
    expect(await 応答.json()).toEqual({ host: '127.0.0.1', port: 4456, password: 'obsのパスワード', intervalSeconds: 90 })
  })

  it('上げ先のコレクションは裏方のページに渡さない（撮るのに要らないため）', async () => {
    const { env } = 環境を作る()
    await 設定を保存する(env, 保存する設定)

    const 応答 = await 呼び出す(new Request(`${サイト}/api/overlay/screen?key=${発行済みのキー}`), env)
    expect(await 応答.json()).not.toHaveProperty('collectionId')
  })

  it('設定に問題があれば、問題点を並べて拒む', async () => {
    const { env } = 環境を作る()
    const 応答 = await 設定を保存する(env, { host: 'obs.example.com', port: 0, password: '', intervalSeconds: 1, collectionId: '' })

    expect(応答.status).toBe(400)
    const 本文 = (await 応答.json()) as { error: { problems: string[] } }
    expect(本文.error.problems).toHaveLength(3)
  })
})

describe('POST /api/overlay/screen', () => {
  it('配信中なら Gyazo へ上げ、画像IDを記録する', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })
    const { fetchImpl, 受け取った } = Gyazoを覚える()

    const 応答 = await 呼び出す(撮った1枚を送る(画像の本文()), env, fetchImpl)

    expect(応答.status).toBe(200)
    expect(await 応答.json()).toEqual({ recorded: true, imageId: 画像のID })
    expect(受け取った[0]?.url).toBe('https://upload.gyazo.com/api/upload')
  })

  it('コレクションを指定してあれば、そのコレクションへ上げる', async () => {
    const { env } = 環境を作る()
    await 設定を保存する(env, 保存する設定)
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })
    const { fetchImpl, 受け取った } = Gyazoを覚える()

    await 呼び出す(撮った1枚を送る(画像の本文()), env, fetchImpl)

    expect(受け取った[0]?.body?.get('collection_id')).toBe('f19e74cebe47c9cadad31b6790098eac')
  })

  it('コレクションを指定していなければ、コレクションの指定を送らない', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })
    const { fetchImpl, 受け取った } = Gyazoを覚える()

    await 呼び出す(撮った1枚を送る(画像の本文()), env, fetchImpl)

    expect(受け取った[0]?.body?.has('collection_id')).toBe(false)
  })

  it('配信していなければ Gyazo へ上げず、記録しなかったことを知らせる', async () => {
    const { env } = 環境を作る()
    const { fetchImpl, 受け取った } = Gyazoを覚える()

    const 応答 = await 呼び出す(撮った1枚を送る(画像の本文()), env, fetchImpl)

    expect(応答.status).toBe(200)
    expect(await 応答.json()).toEqual({ recorded: false, imageId: null })
    expect(受け取った).toEqual([])
  })

  it('Gyazo のアクセストークンが無ければ失敗させる', async () => {
    const { env } = 環境を作る(null)
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })

    const 応答 = await 呼び出す(撮った1枚を送る(画像の本文()), env)

    expect(応答.status).toBe(500)
    expect((await 応答.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'gyazo-token-missing' } })
  })

  it('画像でない本文を拒む', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })

    const 応答 = await 呼び出す(撮った1枚を送る('画像ではない本文', 'text/plain'), env)

    expect(応答.status).toBe(415)
  })

  it('空の本文を拒む', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })

    const 応答 = await 呼び出す(撮った1枚を送る(new Uint8Array()), env)

    expect(応答.status).toBe(400)
  })

  it('大きすぎると申告された本文は、読み込む前に拒む', async () => {
    const { env } = 環境を作る()
    await recordStreamOnline(env.DB, { id: 'session-1', startedAt: 配信の開始 })

    const 応答 = await 呼び出す(
      new Request(`${サイト}/api/overlay/screen?key=${発行済みのキー}`, {
        method: 'POST',
        // 本文の長さの申告（Content-Length）だけで拒めることを確かめる（実際に大きな本文を作らない）
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(9 * 1024 * 1024) },
        body: 画像の本文(),
      }),
      env,
    )

    expect(応答.status).toBe(413)
  })

  it('オーバーレイ用キーが違えば拒む', async () => {
    const { env } = 環境を作る()
    const 応答 = await 呼び出す(
      new Request(`${サイト}/api/overlay/screen?key=違うキー`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: 画像の本文(),
      }),
      env,
    )

    expect(応答.status).toBe(401)
  })
})
