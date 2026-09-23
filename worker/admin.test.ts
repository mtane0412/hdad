/**
 * 管理用APIとオーバーレイ用API（設定・素材・キーの再発行）のテスト
 *
 * KVとR2を差し替え、経路ごとの振る舞いを確認する。特に重要なのは次の3点。
 * - 管理用API（/api/admin/*）は配信者のセッションがなければ使えないこと
 * - 素材と設定は、オーバーレイ用キーか配信者のセッションがなければ読めないこと
 * - キーを再発行したら、古いキーでは何も読めなくなること
 */
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { saveToken } from './token'
import { TRANSCRIPT_MAX_LENGTH } from './overlay-routes'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const 環境を作る = () => {
  const store = createFakeStore({ 'overlay-key': 発行済みのキー })
  const bucket = createFakeBucket()
  const 配送 = createFakeAlertChannel()
  const env = {
    STORE: store,
    MEDIA: bucket,
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: 配送.namespace,
    AI: createFakeAi(),
  } satisfies Env
  return { env, store, bucket, 配送 }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/** アナウンスの送信間隔を空けるための待ちは、テストでは実際に待たない */
const 待たない = async (): Promise<void> => {}

/**
 * これらの経路は応答のあとに続く処理（waitUntil）を使わない。
 * 黙って捨てると気づけなくなるので、預けられたら失敗させる（使うのは webhook-routes.test.ts だけ）。
 */
const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env) => handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const 配信者のリクエスト = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET' && !headers.has('Origin')) headers.set('Origin', サイト)
  return new Request(`${サイト}${path}`, { ...init, headers })
}

const 画像をアップロードする = async (env: Env, fileName = '乾杯.png'): Promise<{ id: string }> => {
  const response = await 呼び出す(
    await 配信者のリクエスト(env, '/api/admin/media', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(fileName) },
      body: new Uint8Array([137, 80, 78, 71]),
    }),
    env,
  )
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const トリガー = (mediaId: string) => ({
  event: REDEMPTION,
  conditions: [],
  actions: [{ type: 'alert', mediaId, durationSeconds: 5, volume: 1, message: '{user} さんが「{reward}」を交換しました' }],
})

/** 保存されたあとの形（アラートの動作に素材の種類が書き足される） */
const 保存済みのトリガー = (mediaId: string, mediaKind: string) => ({
  ...トリガー(mediaId),
  actions: [{ ...トリガー(mediaId).actions[0], mediaKind }],
})

const エラーコード = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

describe('管理用APIの保護', () => {
  it.each([
    ['GET', '/api/admin/config'],
    ['PUT', '/api/admin/config'],
    ['GET', '/api/admin/media'],
    ['POST', '/api/admin/media'],
    ['DELETE', '/api/admin/media/some-id'],
    ['POST', '/api/admin/overlay-key'],
  ])('%s %s は、セッションがなければ401を返す', async (method, path) => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}${path}`, { method, headers: { Origin: サイト } }), env)
    expect(response.status).toBe(401)
  })

  it('別のサイトから送られた書き換え（Originが違う）は、セッションがあっても403で拒否する', async () => {
    const { env } = 環境を作る()
    const request = await 配信者のリクエスト(env, '/api/admin/overlay-key', { method: 'POST', headers: { Origin: 'https://evil.example.com' } })
    const response = await 呼び出す(request, env)
    expect(response.status).toBe(403)
    expect(await エラーコード(response)).toBe('cross-origin')
  })
})

describe('素材（/api/admin/media）', () => {
  it('アップロードした素材は一覧に載り、ファイル名・種類・大きさが分かる', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env, '乾杯.png')

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/media'), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      media: [{ id, name: '乾杯.png', kind: 'image', contentType: 'image/png', size: 4, uploadedAt: '2026-09-21T12:00:00.000Z' }],
    })
  })

  it('画像・動画・音声以外のファイルは415で拒否する', async () => {
    const { env, bucket } = 環境を作る()
    const response = await 呼び出す(
      await 配信者のリクエスト(env, '/api/admin/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip', 'X-File-Name': 'sozai.zip' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
    )
    expect(response.status).toBe(415)
    expect(bucket.entries.size).toBe(0)
  })

  it('大きすぎるファイルは413で拒否する', async () => {
    const { env, bucket } = 環境を作る()
    const response = await 呼び出す(
      await 配信者のリクエスト(env, '/api/admin/media', {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4', 'X-File-Name': 'nagai.mp4', 'Content-Length': String(51 * 1024 * 1024) },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
    )
    expect(response.status).toBe(413)
    expect(bucket.entries.size).toBe(0)
  })

  it('ファイル名がなければ400で拒否する', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(
      await 配信者のリクエスト(env, '/api/admin/media', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1]) }),
      env,
    )
    expect(response.status).toBe(400)
  })

  it('どのトリガーにも使われていない素材は削除できる', async () => {
    const { env, bucket } = 環境を作る()
    const { id } = await 画像をアップロードする(env)

    const response = await 呼び出す(await 配信者のリクエスト(env, `/api/admin/media/${id}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(204)
    expect(bucket.entries.size).toBe(0)
  })

  it('トリガーに使われている素材は409で削除を拒否する（配信中にアラートが出なくなるのを防ぐ）', async () => {
    const { env, bucket } = 環境を作る()
    const { id } = await 画像をアップロードする(env)
    await 呼び出す(await 配信者のリクエスト(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [トリガー(id)] }) }), env)

    const response = await 呼び出す(await 配信者のリクエスト(env, `/api/admin/media/${id}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
    expect(bucket.entries.size).toBe(1)
  })

  it('存在しない素材の削除は404を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/media/nai-sozai', { method: 'DELETE' }), env)
    expect(response.status).toBe(404)
  })
})

describe('設定（/api/admin/config）', () => {
  it('保存した設定を読み出せる。素材の種類はサーバーが書き足す', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env)

    const saved = await 呼び出す(
      await 配信者のリクエスト(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [トリガー(id)] }) }),
      env,
    )
    expect(saved.status).toBe(200)

    const loaded = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/config'), env)
    expect(await loaded.json()).toEqual({ triggers: [保存済みのトリガー(id, 'image')] })
  })

  it('一度も保存していなければ、トリガーなしの設定を返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/config'), env)
    expect(await response.json()).toEqual({ triggers: [] })
  })

  it('存在しない素材を指す設定は400で拒否し、問題点を返して、保存しない', async () => {
    const { env, store } = 環境を作る()
    const response = await 呼び出す(
      await 配信者のリクエスト(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [トリガー('nai-sozai')] }) }),
      env,
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; problems: string[] } }
    expect(body.error.code).toBe('invalid-config')
    expect(body.error.problems).toEqual(['triggers[0].actions[0].mediaId: 素材「nai-sozai」が存在しません'])
    expect(store.entries.has('alert-config')).toBe(false)
  })

  it('JSONでない本文は400で拒否する', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/config', { method: 'PUT', body: 'JSONではない' }), env)
    expect(response.status).toBe(400)
  })
})

describe('オーバーレイ用API', () => {
  const 接続を頼む = (env: Env, key: string, upgrade = true) =>
    呼び出す(new Request(`${サイト}/api/overlay/socket?key=${key}`, { headers: upgrade ? { Upgrade: 'websocket' } : {} }), env)

  it('GET /api/overlay/socket は、正しいキーなら接続を配送先（Durable Object）へ引き渡す', async () => {
    const { env, 配送 } = 環境を作る()

    const response = await 接続を頼む(env, 発行済みのキー)

    expect(response.status).toBe(200)
    expect(配送.引き渡された接続).toHaveLength(1)
  })

  it('GET /api/overlay/socket は、キーが違えば401を返し、配送先を呼ばない', async () => {
    const { env, 配送 } = 環境を作る()

    const response = await 接続を頼む(env, 'atezuppou')

    expect(response.status).toBe(401)
    expect(await エラーコード(response)).toBe('invalid-overlay-key')
    expect(配送.引き渡された接続).toHaveLength(0)
  })

  it('GET /api/overlay/socket は、WebSocketの接続でなければ400を返す', async () => {
    const { env } = 環境を作る()

    const response = await 接続を頼む(env, 発行済みのキー, false)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('expected-websocket')
  })

  describe('POST /api/overlay/transcript（文字起こしの受け口）', () => {
    /** 配信中の区切りを1件作る。ended_at が NULL なら配信中である */
    const 配信を始める = (env: Env): void => {
      ;(env.DB as ReturnType<typeof createFakeDatabase>).sqlite
        .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
        .run('配信1', new Date(現在時刻 - 60_000).toISOString(), '雑談配信', 'Just Chatting')
    }

    const 送る = (env: Env, body: unknown, key = 発行済みのキー) =>
      呼び出す(
        new Request(`${サイト}/api/overlay/transcript?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        env,
      )

    const 行を数える = (env: Env): number =>
      (
        (env.DB as ReturnType<typeof createFakeDatabase>).sqlite.prepare('SELECT COUNT(*) AS count FROM transcripts').get() as {
          count: number
        }
      ).count

    it('配信中なら、届いた発話を記録して記録したと答える', async () => {
      const { env } = 環境を作る()
      配信を始める(env)

      const response = await 送る(env, { messageId: '発話1', text: 'こんばんは、配信を始めます' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ recorded: true })
      expect(行を数える(env)).toBe(1)
    })

    it('配信していなければ捨て、捨てたと答える', async () => {
      const { env } = 環境を作る()

      const response = await 送る(env, { messageId: '独り言', text: 'マイクの確認です' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ recorded: false })
      expect(行を数える(env)).toBe(0)
    })

    it('同じメッセージIDが二度届いても行が増えない', async () => {
      const { env } = 環境を作る()
      配信を始める(env)

      await 送る(env, { messageId: '発話1', text: 'こんばんは' })
      const response = await 送る(env, { messageId: '発話1', text: 'こんばんは' })

      expect(response.status).toBe(200)
      expect(行を数える(env)).toBe(1)
    })

    it('オーバーレイ用キーが違えば401を返し、記録しない', async () => {
      const { env } = 環境を作る()
      配信を始める(env)

      const response = await 送る(env, { messageId: '発話1', text: 'こんばんは' }, 'atezuppou')

      expect(response.status).toBe(401)
      expect(await エラーコード(response)).toBe('invalid-overlay-key')
      expect(行を数える(env)).toBe(0)
    })

    it('JSONでない本文は400で拒否する', async () => {
      const { env } = 環境を作る()
      const response = await 送る(env, 'JSONではない')
      expect(response.status).toBe(400)
      expect(await エラーコード(response)).toBe('invalid-body')
    })

    it('メッセージIDが無ければ400で拒否する', async () => {
      const { env } = 環境を作る()
      const response = await 送る(env, { text: 'こんばんは' })
      expect(response.status).toBe(400)
      expect(await エラーコード(response)).toBe('invalid-message-id')
    })

    it('本文が空なら400で拒否する', async () => {
      const { env } = 環境を作る()
      const response = await 送る(env, { messageId: '発話1', text: '   ' })
      expect(response.status).toBe(400)
      expect(await エラーコード(response)).toBe('invalid-text')
    })

    it('本文が長すぎれば400で拒否する', async () => {
      const { env } = 環境を作る()
      const response = await 送る(env, { messageId: '発話1', text: 'あ'.repeat(TRANSCRIPT_MAX_LENGTH + 1) })
      expect(response.status).toBe(400)
      expect(await エラーコード(response)).toBe('text-too-long')
    })

    it('DELETE は記録済みの発話を取り消す', async () => {
      const { env } = 環境を作る()
      配信を始める(env)
      await 送る(env, { messageId: '言い間違い', text: 'えーと' })

      const response = await 呼び出す(new Request(`${サイト}/api/overlay/transcript/言い間違い?key=${発行済みのキー}`, { method: 'DELETE' }), env)

      expect(response.status).toBe(204)
      expect(行を数える(env)).toBe(0)
    })

    it('DELETE も、オーバーレイ用キーが違えば401を返す', async () => {
      const { env } = 環境を作る()
      配信を始める(env)
      await 送る(env, { messageId: '言い間違い', text: 'えーと' })

      const response = await 呼び出す(new Request(`${サイト}/api/overlay/transcript/言い間違い?key=atezuppou`, { method: 'DELETE' }), env)

      expect(response.status).toBe(401)
      expect(行を数える(env)).toBe(1)
    })

    it('DELETE は、記録の無い発話でも204を返す（取り消しは何度届いても同じ結果にする）', async () => {
      const { env } = 環境を作る()
      const response = await 呼び出す(new Request(`${サイト}/api/overlay/transcript/知らない発話?key=${発行済みのキー}`, { method: 'DELETE' }), env)
      expect(response.status).toBe(204)
    })
  })

  it('GET /api/media/:id は、正しいキーなら素材の中身を種類付きで返す', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env)

    const response = await 呼び出す(new Request(`${サイト}/api/media/${id}?key=${発行済みのキー}`), env)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    // アップロードされたSVGなどに仕込まれたスクリプトを、このサイトの権限で動かさない
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('GET /api/media/:id は、キーがなくても配信者のセッションがあれば返す（管理画面でのプレビュー用）', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env)
    const response = await 呼び出す(await 配信者のリクエスト(env, `/api/media/${id}`), env)
    expect(response.status).toBe(200)
  })

  it('GET /api/media/:id は、キーもセッションもなければ401を返す', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env)
    expect((await 呼び出す(new Request(`${サイト}/api/media/${id}`), env)).status).toBe(401)
  })

  it('GET /api/media/:id は、存在しない素材なら404を返す', async () => {
    const { env } = 環境を作る()
    expect((await 呼び出す(new Request(`${サイト}/api/media/nai-sozai?key=${発行済みのキー}`), env)).status).toBe(404)
  })
})

describe('POST /api/admin/overlay-key（キーの再発行）', () => {
  it('新しいキーを返し、古いキーでは設定も素材も読めなくなる', async () => {
    const { env } = 環境を作る()
    const { id } = await 画像をアップロードする(env)

    const response = await 呼び出す(await 配信者のリクエスト(env, '/api/admin/overlay-key', { method: 'POST' }), env)

    expect(response.status).toBe(200)
    const { overlayKey } = (await response.json()) as { overlayKey: string }
    expect(overlayKey).not.toBe(発行済みのキー)
    expect(overlayKey.length).toBeGreaterThanOrEqual(32)
    const 接続を頼む = (key: string) => 呼び出す(new Request(`${サイト}/api/overlay/socket?key=${key}`, { headers: { Upgrade: 'websocket' } }), env)
    expect((await 接続を頼む(発行済みのキー)).status).toBe(401)
    expect((await 呼び出す(new Request(`${サイト}/api/media/${id}?key=${発行済みのキー}`), env)).status).toBe(401)
    expect((await 接続を頼む(overlayKey)).status).toBe(200)
  })
})

describe('チャンネルポイント報酬の一覧（GET /api/admin/rewards）', () => {
  const 保存済みのトークン = {
    accessToken: 'test-access-token',
    refreshToken: 'リフレッシュトークン',
    expiresAt: 現在時刻 + 60 * 60 * 1000,
    userId: 配信者のID,
    login: 'haishinsha',
    scopes: ['channel:read:redemptions'],
  }

  it('セッションがなければ401を返す', async () => {
    const { env } = 環境を作る()
    expect((await 呼び出す(new Request(`${サイト}/api/admin/rewards`), env)).status).toBe(401)
  })

  it('保管しているトークンでTwitchから報酬を取得し、管理画面で選べる形で返す', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'broadcaster', 保存済みのトークン)
    const requests: Request[] = []
    const Twitchの代役 = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push(new Request(input, init))
      return Response.json({ data: [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }] })
    }

    const response = await handleRequest(await 配信者のリクエスト(env, '/api/admin/rewards'), env, { fetch: Twitchの代役, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rewards: [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }] })
    expect(new URL(requests[0]!.url).searchParams.get('broadcaster_id')).toBe(配信者のID)
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer test-access-token')
  })

  it('Twitchが失敗を返したら、502でTwitchのメッセージを伝える', async () => {
    const { env, store } = 環境を作る()
    await saveToken(store, 'broadcaster', 保存済みのトークン)
    const 失敗するTwitch = async (): Promise<Response> => Response.json({ message: 'channel points are not available' }, { status: 403 })

    const response = await handleRequest(await 配信者のリクエスト(env, '/api/admin/rewards'), env, { fetch: 失敗するTwitch, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

    expect(response.status).toBe(502)
    expect(await エラーコード(response)).toBe('twitch-error')
  })
})
