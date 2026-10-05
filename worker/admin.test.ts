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
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeDatabase } from './fake-database'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { overlayKeyTag } from './overlay-key'
import { recordLlmUsage } from './llm-usage-store'
import { TRANSCRIPT_MAX_LENGTH } from './transcript-routes'
import { SPEECH_TEXT_MAX_LENGTH } from './speech-config'
import { DEFAULT_TOWN_TOUR_SOUND, saveTownTourSound } from './town-tour-sound'

const now = Date.UTC(2026, 8, 21, 12, 0, 0)
const broadcasterId = '12345'
const origin = 'https://hdad.example.com'
const issuedKey = 'issued-overlay-key-0123456789abcdefghij'

const createEnv = () => {
  const store = createFakeStore({ 'overlay-key': issuedKey })
  const bucket = createFakeBucket()
  const delivery = createFakeAlertChannel()
  const relay = createFakeDrawChannel()
  const tabRelay = createFakeTabChannel()
  const env = {
    STORE: store,
    MEDIA: bucket,
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: delivery.namespace,
    DRAW: relay.namespace,
    TAB: tabRelay.namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, store, bucket, delivery, relay, tabRelay }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/** アナウンスの送信間隔を空けるための待ちは、テストでは実際に待たない */
const noWait = async (): Promise<void> => {}

/**
 * これらの経路は応答のあとに続く処理（waitUntil）を使わない。
 * 黙って捨てると気づけなくなるので、預けられたら失敗させる（使うのは webhook-routes.test.ts だけ）。
 */
const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env, fetchImpl: typeof fetch = noTwitchFetch) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => now, wait: noWait, waitUntil: noDefer })

/** 配信者としてログイン済みのリクエストを作る。書き換えを伴うメソッドには、ブラウザと同じく Origin を付ける */
const broadcasterRequest = async (env: Env, path: string, init: RequestInit = {}): Promise<Request> => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  const headers = new Headers(init.headers)
  headers.set('Cookie', `__Host-session=${session}`)
  if (init.method && init.method !== 'GET' && !headers.has('Origin')) headers.set('Origin', origin)
  return new Request(`${origin}${path}`, { ...init, headers })
}

const uploadImage = async (env: Env, fileName = '乾杯.png'): Promise<{ id: string }> => {
  const response = await invoke(
    await broadcasterRequest(env, '/api/admin/media', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent(fileName) },
      body: new Uint8Array([137, 80, 78, 71]),
    }),
    env,
  )
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string }
}

const trigger = (mediaId: string) => ({
  kind: 'reward',
  rewardId: null,
  actions: [{ type: 'alert', mediaId, durationSeconds: 5, volume: 1, message: '{user} さんが「{reward}」を交換しました' }],
})

/** 保存されたあとの形（アラートの動作に素材の種類が書き足される） */
const savedTrigger = (mediaId: string, mediaKind: string) => ({
  ...trigger(mediaId),
  actions: [{ ...trigger(mediaId).actions[0], mediaKind }],
})

const errorCode = async (response: Response): Promise<unknown> => {
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
    const { env } = createEnv()
    const response = await invoke(new Request(`${origin}${path}`, { method, headers: { Origin: origin } }), env)
    expect(response.status).toBe(401)
  })

  it('別のサイトから送られた書き換え（Originが違う）は、セッションがあっても403で拒否する', async () => {
    const { env } = createEnv()
    const request = await broadcasterRequest(env, '/api/admin/overlay-key', { method: 'POST', headers: { Origin: 'https://evil.example.com' } })
    const response = await invoke(request, env)
    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('cross-origin')
  })
})

describe('素材（/api/admin/media）', () => {
  it('アップロードした素材は一覧に載り、ファイル名・種類・大きさが分かる', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env, '乾杯.png')

    const response = await invoke(await broadcasterRequest(env, '/api/admin/media'), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      media: [{ id, name: '乾杯.png', kind: 'image', contentType: 'image/png', size: 4, uploadedAt: '2026-09-21T12:00:00.000Z' }],
    })
  })

  it('画像・動画・音声以外のファイルは415で拒否する', async () => {
    const { env, bucket } = createEnv()
    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/media', {
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
    const { env, bucket } = createEnv()
    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/media', {
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
    const { env } = createEnv()
    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/media', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1]) }),
      env,
    )
    expect(response.status).toBe(400)
  })

  it('どのトリガーにも使われていない素材は削除できる', async () => {
    const { env, bucket } = createEnv()
    const { id } = await uploadImage(env)

    const response = await invoke(await broadcasterRequest(env, `/api/admin/media/${id}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(204)
    expect(bucket.entries.size).toBe(0)
  })

  it('トリガーに使われている素材は409で削除を拒否する（配信中にアラートが出なくなるのを防ぐ）', async () => {
    const { env, bucket } = createEnv()
    const { id } = await uploadImage(env)
    await invoke(await broadcasterRequest(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [trigger(id)] }) }), env)

    const response = await invoke(await broadcasterRequest(env, `/api/admin/media/${id}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
    expect(bucket.entries.size).toBe(1)
  })

  it('市町村紹介の音の枠に選ばれている素材は409で削除を拒否する（紹介が黙って無音になるのを防ぐ）', async () => {
    const { env, bucket } = createEnv()
    const { id } = await uploadImage(env)
    // 検証（音声であること）は town-tour-sound.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveTownTourSound(env.STORE, { ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, closing: id } })

    const response = await invoke(await broadcasterRequest(env, `/api/admin/media/${id}`, { method: 'DELETE' }), env)

    expect(response.status).toBe(409)
    expect(bucket.entries.size).toBe(1)
  })

  it('存在しない素材の削除は404を返す', async () => {
    const { env } = createEnv()
    const response = await invoke(await broadcasterRequest(env, '/api/admin/media/nai-sozai', { method: 'DELETE' }), env)
    expect(response.status).toBe(404)
  })
})

describe('設定（/api/admin/config）', () => {
  it('保存した設定を読み出せる。素材の種類はサーバーが書き足す', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env)

    const saved = await invoke(
      await broadcasterRequest(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [trigger(id)] }) }),
      env,
    )
    expect(saved.status).toBe(200)

    const loaded = await invoke(await broadcasterRequest(env, '/api/admin/config'), env)
    expect(await loaded.json()).toEqual({ triggers: [savedTrigger(id, 'image')] })
  })

  it('一度も保存していなければ、トリガーなしの設定を返す', async () => {
    const { env } = createEnv()
    const response = await invoke(await broadcasterRequest(env, '/api/admin/config'), env)
    expect(await response.json()).toEqual({ triggers: [] })
  })

  it('存在しない素材を指す設定は400で拒否し、問題点を返して、保存しない', async () => {
    const { env, store } = createEnv()
    const response = await invoke(
      await broadcasterRequest(env, '/api/admin/config', { method: 'PUT', body: JSON.stringify({ triggers: [trigger('nai-sozai')] }) }),
      env,
    )

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; problems: string[] } }
    expect(body.error.code).toBe('invalid-config')
    expect(body.error.problems).toEqual(['triggers[0].actions[0].mediaId: 素材「nai-sozai」が存在しません'])
    expect(store.entries.has('alert-config')).toBe(false)
  })

  it('JSONでない本文は400で拒否する', async () => {
    const { env } = createEnv()
    const response = await invoke(await broadcasterRequest(env, '/api/admin/config', { method: 'PUT', body: 'JSONではない' }), env)
    expect(response.status).toBe(400)
  })
})

describe('オーバーレイ用API', () => {
  const requestConnection = (env: Env, key: string, upgrade = true) =>
    invoke(new Request(`${origin}/api/overlay/socket?key=${key}`, { headers: upgrade ? { Upgrade: 'websocket' } : {} }), env)

  it('GET /api/overlay/socket は、正しいキーなら接続を配送先（Durable Object）へ引き渡す', async () => {
    const { env, delivery } = createEnv()

    const response = await requestConnection(env, issuedKey)

    expect(response.status).toBe(200)
    expect(delivery.forwardedConnections).toHaveLength(1)
  })

  it('GET /api/overlay/socket は、キーが違えば401を返し、配送先を呼ばない', async () => {
    const { env, delivery } = createEnv()

    const response = await requestConnection(env, 'atezuppou')

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('invalid-overlay-key')
    expect(delivery.forwardedConnections).toHaveLength(0)
  })

  it('GET /api/overlay/socket は、WebSocketの接続でなければ400を返す', async () => {
    const { env } = createEnv()

    const response = await requestConnection(env, issuedKey, false)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('expected-websocket')
  })

  describe('POST /api/admin/transcripts（アプリのページで認識した発話の受け口）', () => {
    /** 配信中の区切りを1件作る。ended_at が NULL なら配信中である */
    const startStream = (env: Env): void => {
      ;(env.DB as ReturnType<typeof createFakeDatabase>).sqlite
        .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
        .run('配信1', new Date(now - 60_000).toISOString(), '雑談配信', 'Just Chatting')
    }

    const sendAsBroadcaster = async (env: Env, body: unknown) =>
      invoke(
        await broadcasterRequest(env, '/api/admin/transcripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        env,
      )

    const readRows = (env: Env) =>
      (env.DB as ReturnType<typeof createFakeDatabase>).sqlite.prepare('SELECT message_id, text FROM transcripts').all()

    it('配信中なら、ログインした配信者が送った発話を記録して記録したと答える', async () => {
      const { env } = createEnv()
      startStream(env)

      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: ' こんばんは、配信を始めます ' })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ recorded: true })
      expect(readRows(env)).toEqual([{ message_id: 'webspeech:発話1', text: 'こんばんは、配信を始めます' }])
    })

    it('配信していなければ捨て、捨てたと答える', async () => {
      const { env } = createEnv()

      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:独り言', text: 'マイクの確認です' })

      expect(await response.json()).toEqual({ recorded: false })
      expect(readRows(env)).toEqual([])
    })

    it('ログインしていなければ401を返し、記録しない', async () => {
      const { env } = createEnv()
      startStream(env)

      const response = await invoke(
        new Request(`${origin}/api/admin/transcripts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin },
          body: JSON.stringify({ messageId: 'webspeech:発話1', text: 'こんばんは' }),
        }),
        env,
      )

      expect(response.status).toBe(401)
      expect(readRows(env)).toEqual([])
    })

    it('別のサイトから送られたら403を返し、記録しない', async () => {
      const { env } = createEnv()
      startStream(env)

      const response = await invoke(
        await broadcasterRequest(env, '/api/admin/transcripts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
          body: JSON.stringify({ messageId: 'webspeech:発話1', text: 'こんばんは' }),
        }),
        env,
      )

      expect(response.status).toBe(403)
      expect(readRows(env)).toEqual([])
    })

    it('同じメッセージIDが二度届いても行が増えない', async () => {
      const { env } = createEnv()
      startStream(env)

      await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: 'こんばんは' })
      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: 'こんばんは' })

      expect(response.status).toBe(200)
      expect(readRows(env)).toEqual([{ message_id: 'webspeech:発話1', text: 'こんばんは' }])
    })

    it('JSONでない本文は400で拒否する', async () => {
      const { env } = createEnv()
      const response = await sendAsBroadcaster(env, 'JSONではない')
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('invalid-body')
    })

    it('メッセージIDが無ければ400で拒否する', async () => {
      const { env } = createEnv()
      const response = await sendAsBroadcaster(env, { text: 'こんばんは' })
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('invalid-message-id')
    })

    it('本文が空なら400で拒否する', async () => {
      const { env } = createEnv()
      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: '   ' })
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('invalid-text')
    })

    it('本文が長すぎれば400で拒否する', async () => {
      const { env } = createEnv()
      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: 'あ'.repeat(TRANSCRIPT_MAX_LENGTH + 1) })
      expect(response.status).toBe(400)
      expect(await errorCode(response)).toBe('text-too-long')
    })

    it('前後の空白を落とせば上限に収まる本文は受け付ける（長さは保存する形で数える）', async () => {
      const { env } = createEnv()
      startStream(env)

      const response = await sendAsBroadcaster(env, { messageId: 'webspeech:発話1', text: `  ${'あ'.repeat(TRANSCRIPT_MAX_LENGTH)}  ` })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ recorded: true })
    })

    it('ゆかコネNEO の中継の受け口（POST /api/overlay/transcript）は、もう受け付けない', async () => {
      const { env } = createEnv()
      startStream(env)

      const response = await invoke(
        new Request(`${origin}/api/overlay/transcript?key=${issuedKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: '発話1', text: 'こんばんは' }),
        }),
        env,
      )

      expect(response.status).toBe(404)
      expect(readRows(env)).toEqual([])
    })
  })

  it('GET /api/media/:id は、正しいキーなら素材の中身を種類付きで返す', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env)

    const response = await invoke(new Request(`${origin}/api/media/${id}?key=${issuedKey}`), env)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))
    // アップロードされたSVGなどに仕込まれたスクリプトを、このサイトの権限で動かさない
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('GET /api/media/:id は、キーがなくても配信者のセッションがあれば返す（管理画面でのプレビュー用）', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env)
    const response = await invoke(await broadcasterRequest(env, `/api/media/${id}`), env)
    expect(response.status).toBe(200)
  })

  it('GET /api/media/:id は、キーもセッションもなければ401を返す', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env)
    expect((await invoke(new Request(`${origin}/api/media/${id}`), env)).status).toBe(401)
  })

  it('GET /api/media/:id は、存在しない素材なら404を返す', async () => {
    const { env } = createEnv()
    expect((await invoke(new Request(`${origin}/api/media/nai-sozai?key=${issuedKey}`), env)).status).toBe(404)
  })
})

describe('POST /api/admin/overlay-key（キーの再発行）', () => {
  it('新しいキーを返し、古いキーでは設定も素材も読めなくなる', async () => {
    const { env } = createEnv()
    const { id } = await uploadImage(env)

    const response = await invoke(await broadcasterRequest(env, '/api/admin/overlay-key', { method: 'POST' }), env)

    expect(response.status).toBe(200)
    const { overlayKey } = (await response.json()) as { overlayKey: string }
    expect(overlayKey).not.toBe(issuedKey)
    expect(overlayKey.length).toBeGreaterThanOrEqual(32)
    const requestConnection = (key: string) => invoke(new Request(`${origin}/api/overlay/socket?key=${key}`, { headers: { Upgrade: 'websocket' } }), env)
    expect((await requestConnection(issuedKey)).status).toBe(401)
    expect((await invoke(new Request(`${origin}/api/media/${id}?key=${issuedKey}`), env)).status).toBe(401)
    expect((await requestConnection(overlayKey)).status).toBe(200)
  })

  it('古いキーで開かれたままの接続（アラート・BGM・手書き・字幕・タブの映像）をすべて切り、新しいキーの目印を覚えさせる', async () => {
    // 接続はつないだときに一度だけキーを確かめるので、切らないと古いキーのまま受け取り続けてしまう
    const { env, delivery, relay, tabRelay } = createEnv()

    const response = await invoke(await broadcasterRequest(env, '/api/admin/overlay-key', { method: 'POST' }), env)

    expect(response.status).toBe(200)
    const { overlayKey } = (await response.json()) as { overlayKey: string }
    const newTag = await overlayKeyTag(overlayKey)
    expect(delivery.revokedKeyTags).toEqual([newTag])
    expect([...relay.revocations].sort((a, b) => a.channel.localeCompare(b.channel))).toEqual([
      { channel: 'caption', keyTag: newTag },
      { channel: 'draw', keyTag: newTag },
    ])
    expect(tabRelay.revokedKeyTags).toEqual([newTag])
  })

  it('接続を切れなかったら、新しいキーを返さずに失敗を返し、発行し直しを促す', async () => {
    // KVのキーは書き換わっているので、黙って成功にすると古いキーの接続が残ったことに気づけない
    const { env } = createEnv()
    const failingEnv = { ...env, ALERTS: createFakeAlertChannel({ shouldFail: true }).namespace }

    const response = await invoke(await broadcasterRequest(failingEnv, '/api/admin/overlay-key', { method: 'POST' }), failingEnv)

    expect(response.status).toBe(500)
    const body = (await response.json()) as { overlayKey?: string; error: { code: string; message: string } }
    expect(body.overlayKey).toBeUndefined()
    expect(body.error.code).toBe('overlay-key-revoke-failed')
    expect(body.error.message).toContain('もう一度')
  })

  it('オーバーレイ用キーで開く接続には、確かめたキーの目印を付けて Durable Object へ引き渡す', async () => {
    const { env, delivery, relay, tabRelay } = createEnv()
    const issuedTag = await overlayKeyTag(issuedKey)
    const connect = (path: string) => invoke(new Request(`${origin}${path}?key=${issuedKey}&keyTag=forged`, { headers: { Upgrade: 'websocket' } }), env)

    for (const path of ['/api/overlay/socket', '/api/overlay/bgm/socket', '/api/overlay/draw', '/api/overlay/caption', '/api/overlay/tab']) {
      expect((await connect(path)).status).toBe(200)
    }

    const tagsOf = (requests: Request[]) => requests.map((request) => new URL(request.url).searchParams.getAll('keyTag'))
    expect(tagsOf(delivery.forwardedConnections)).toEqual([[issuedTag], [issuedTag]])
    expect(tagsOf(relay.forwardedConnections)).toEqual([[issuedTag], [issuedTag]])
    expect(tagsOf(tabRelay.forwardedConnections)).toEqual([[issuedTag]])
  })
})

describe('GET /api/overlay/side-super（サイドスーパーの読み出し）', () => {
  /** 配信中の区切りを1件作る */
  const startStream = (env: Env): void => {
    ;(env.DB as ReturnType<typeof createFakeDatabase>).sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, title, category_name) VALUES (?, ?, ?, ?)')
      .run('配信1', new Date(now - 60_000).toISOString(), '雑談配信', 'Just Chatting')
  }

  /** cron が作った体でサイドスーパーを1件貯める */
  const accumulate = (env: Env, line1: string, line2: string): void => {
    ;(env.DB as ReturnType<typeof createFakeDatabase>).sqlite
      .prepare('INSERT INTO side_supers (session_id, line1, line2, updated_at) VALUES (?, ?, ?, ?)')
      .run('配信1', line1, line2, new Date(now - 30_000).toISOString())
  }

  const read = (env: Env, key = issuedKey) => invoke(new Request(`${origin}/api/overlay/side-super?key=${key}`), env)

  it('貯めてあるサイドスーパーを、作った日時とともに返す', async () => {
    const { env } = createEnv()
    startStream(env)
    accumulate(env, '新作ゲーム', '初見プレイ中')

    const response = await read(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      lines: ['新作ゲーム', '初見プレイ中'],
      updatedAt: new Date(now - 30_000).toISOString(),
    })
  })

  it('配信していない・まだ作っていないときは、空の行を返す（オーバーレイは何も映さない）', async () => {
    const { env } = createEnv()

    const response = await read(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lines: [], updatedAt: null })
  })

  it('キーが違えば401を返す', async () => {
    const { env } = createEnv()
    startStream(env)
    accumulate(env, '新作ゲーム', '')

    const response = await read(env, 'atezuppou')

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('invalid-overlay-key')
  })
})

describe('読み上げの設定（/api/admin/speech・/api/overlay/speech）', () => {
  /** 配信者が画面で組み立てた、既定とは違う設定 */
  const broadcasterConfig = {
    engine: 'local',
    host: '127.0.0.1',
    port: 50022,
    speaker: 8,
    speed: 1.2,
    volume: 0.8,
    maxLength: 80,
    readName: true,
    ignoreLogins: ['hdad_bot'],
  }

  const save = async (env: Env, settings: unknown) =>
    invoke(
      await broadcasterRequest(env, '/api/admin/speech', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
      env,
    )

  const speechPageReads = (env: Env, key = issuedKey) => invoke(new Request(`${origin}/api/overlay/speech?key=${key}`), env)

  it('セッションがなければ、取得も保存も401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/speech`), env)).status).toBe(401)
    expect((await invoke(new Request(`${origin}/api/admin/speech`, { method: 'PUT', body: '{}' }), env)).status).toBe(401)
  })

  it('保存した設定を、管理画面からも読み上げのページからも読める', async () => {
    const { env } = createEnv()

    expect((await save(env, broadcasterConfig)).status).toBe(200)

    expect(await (await invoke(await broadcasterRequest(env, '/api/admin/speech'), env)).json()).toEqual(broadcasterConfig)
    // 読み上げのページには、ミュートしているかも添えて返す（issue #238）
    expect(await (await speechPageReads(env)).json()).toEqual({ ...broadcasterConfig, muted: false })
  })

  it('まだ保存していなければ、既定の設定を返す（読み上げが止まらないようにする）', async () => {
    const { env } = createEnv()

    const response = await speechPageReads(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ engine: 'local', host: 'localhost', port: 50021, speaker: 3, volume: 1, ignoreLogins: [] })
  })

  it('値が範囲の外なら400で拒み、問題点をすべて返す（画面で一度に直せるようにする）', async () => {
    const { env } = createEnv()

    const response = await save(env, { ...broadcasterConfig, port: 0, volume: 2 })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toHaveLength(2)
  })

  it('読み上げのページのキーが違えば401を返す', async () => {
    const { env } = createEnv()

    const response = await speechPageReads(env, 'atezuppou')

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('invalid-overlay-key')
  })
})

describe('さくらのAI Engine での合成（/api/overlay/speech/check・/api/overlay/speech/synthesis）', () => {
  /** テストで使うさくらのAPIキー */
  const sakuraApiKey = 'sakura-test-api-key'

  /** 合成先にさくらを選び、話者7・速度1.2で保存した設定 */
  const sakuraSettings = {
    engine: 'sakura',
    host: 'localhost',
    port: 50021,
    speaker: 7,
    speed: 1.2,
    volume: 0.8,
    maxLength: 60,
    readName: true,
    ignoreLogins: [],
  }

  /** 設定を保存済みにした環境を作る。APIキーは既定で設定済みにし、null なら設定していないものとする */
  const createSpeechEnv = (settings: unknown, apiKey: string | null = sakuraApiKey) => {
    const { env, store } = createEnv()
    store.entries.set('speech-settings', JSON.stringify(settings))
    return { ...env, SAKURA_AI_API_KEY: apiKey ?? undefined } satisfies Env
  }

  /** さくらの代役。送られた要求のURLを記録し、audio_query には読み方を、synthesis には音声を返す */
  const createSakuraFetch = (respond: (url: URL) => Response | undefined = () => undefined) => {
    const sentUrls: URL[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      sentUrls.push(url)
      const replaced = respond(url)
      if (replaced) return replaced
      if (url.pathname === '/tts/v1/audio_query') return Response.json({ accent_phrases: [], speedScale: 1 })
      if (url.pathname === '/tts/v1/synthesis') return new Response('ずんだもんの声（WAV）', { headers: { 'Content-Type': 'audio/wav' } })
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { fetchImpl, sentUrls }
  }

  const synthesize = (env: Env, body: unknown, fetchImpl: typeof fetch = noTwitchFetch, key = issuedKey) =>
    invoke(
      new Request(`${origin}/api/overlay/speech/synthesis?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      fetchImpl,
    )

  const check = (env: Env, fetchImpl: typeof fetch = noTwitchFetch, key = issuedKey) =>
    invoke(new Request(`${origin}/api/overlay/speech/check?key=${key}`, { method: 'POST' }), env, fetchImpl)

  it('オーバーレイ用キーが違えば401を返す（さくらは呼ばない）', async () => {
    const env = createSpeechEnv(sakuraSettings)

    expect((await synthesize(env, { text: 'こんばんは' }, noTwitchFetch, 'atezuppou')).status).toBe(401)
    expect((await check(env, noTwitchFetch, 'atezuppou')).status).toBe(401)
  })

  it('合成先にさくらを選んでいなければ409で断る（選んでいない配信者に課金を起こさない）', async () => {
    const env = createSpeechEnv({ ...sakuraSettings, engine: 'local' })

    const response = await synthesize(env, { text: 'こんばんは' })

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('speech-engine-not-sakura')
    expect((await check(env)).status).toBe(409)
  })

  it('APIキーが設定されていなければ400で断る', async () => {
    const env = createSpeechEnv(sakuraSettings, null)

    const response = await synthesize(env, { text: 'こんばんは' })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('no-api-key')
  })

  it('保存済みの話者と速度で合成し、音声をそのまま返す', async () => {
    const env = createSpeechEnv(sakuraSettings)
    const { fetchImpl, sentUrls } = createSakuraFetch()

    const response = await synthesize(env, { text: 'こんばんは' }, fetchImpl)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/wav')
    expect(await response.text()).toBe('ずんだもんの声（WAV）')
    expect(sentUrls.map((url) => [url.pathname, url.searchParams.get('speaker')])).toEqual([
      ['/tts/v1/audio_query', '7'],
      ['/tts/v1/synthesis', '7'],
    ])
    expect(sentUrls[0]?.searchParams.get('text')).toBe('こんばんは')
  })

  it('読み上げ文が空か長すぎれば400で断る（さくらは呼ばない）', async () => {
    const env = createSpeechEnv(sakuraSettings)

    expect((await synthesize(env, { text: '' })).status).toBe(400)
    expect((await synthesize(env, { text: 'あ'.repeat(SPEECH_TEXT_MAX_LENGTH + 1) })).status).toBe(400)
    expect((await synthesize(env, { message: 'こんばんは' })).status).toBe(400)
  })

  it('さくらが失敗を返したら502で、さくらの理由を返す', async () => {
    const env = createSpeechEnv(sakuraSettings)
    const { fetchImpl } = createSakuraFetch(() => Response.json({ detail: 'This speaker is not available.' }, { status: 400 }))

    const response = await synthesize(env, { text: 'こんばんは' }, fetchImpl)

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('speech-synthesis-failed')
    expect(body.error.message).toContain('This speaker is not available.')
  })

  it('起動時の確認は、課金されない読み方の問い合わせだけを呼んで204を返す', async () => {
    const env = createSpeechEnv(sakuraSettings)
    const { fetchImpl, sentUrls } = createSakuraFetch()

    const response = await check(env, fetchImpl)

    expect(response.status).toBe(204)
    expect(sentUrls.map((url) => url.pathname)).toEqual(['/tts/v1/audio_query'])
  })

  it('起動時の確認で話者が使えなければ502で、さくらの理由を返す', async () => {
    const env = createSpeechEnv(sakuraSettings)
    const { fetchImpl } = createSakuraFetch(() => Response.json({ detail: 'This model is not available.' }, { status: 400 }))

    const response = await check(env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.text()).toContain('This model is not available.')
  })
})

describe('LLMの設定（/api/admin/llm）', () => {
  /** 配信者が画面で組み立てた設定。あらすじだけ OpenRouter に切り替えている */
  const broadcasterConfig = {
    usages: {
      translation: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' } },
      aiChat: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' } },
      sideSuper: { provider: 'workers-ai', models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' } },
      viewerSummary: {
        provider: 'workers-ai',
        models: { 'workers-ai': '@cf/meta/llama-3.1-8b-instruct-fp8', openrouter: 'meta-llama/llama-3.1-8b-instruct' },
      },
      streamSummary: {
        provider: 'openrouter',
        models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'anthropic/claude-3.5-haiku' },
      },
      townTour: {
        provider: 'workers-ai',
        models: { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openrouter: 'meta-llama/llama-3.3-70b-instruct' },
      },
    },
  }

  const save = async (env: Env, settings: unknown) =>
    invoke(
      await broadcasterRequest(env, '/api/admin/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
      env,
    )

  const read = async (env: Env) => invoke(await broadcasterRequest(env, '/api/admin/llm'), env)

  it('セッションがなければ、取得も保存も401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/llm`), env)).status).toBe(401)
    expect((await invoke(new Request(`${origin}/api/admin/llm`, { method: 'PUT', body: '{}' }), env)).status).toBe(401)
  })

  it('保存した設定を読み出せる', async () => {
    const { env } = createEnv()

    expect((await save(env, broadcasterConfig)).status).toBe(200)

    expect(await (await read(env)).json()).toMatchObject(broadcasterConfig)
  })

  it('まだ保存していなければ、既定の設定（すべて Workers AI）を返す', async () => {
    const { env } = createEnv()

    const response = await read(env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { usages: Record<string, { provider: string }> }
    expect(Object.values(body.usages).map(({ provider }) => provider)).toEqual(['workers-ai', 'workers-ai', 'workers-ai', 'workers-ai', 'workers-ai', 'workers-ai'])
  })

  it('OpenRouter のAPIキーが設定されているかを添えて返す（鍵そのものは返さない）', async () => {
    const { env } = createEnv()

    expect(await (await read(env)).json()).toMatchObject({ apiKeyConfigured: false })

    const withKey = { ...env, OPENROUTER_API_KEY: 'openrouter-test-key' }
    const body = await (await invoke(await broadcasterRequest(withKey, '/api/admin/llm'), withKey)).json()
    expect(body).toMatchObject({ apiKeyConfigured: true })
    expect(JSON.stringify(body)).not.toContain('openrouter-test-key')
  })

  it('知らない提供元や空のモデル名は400で拒み、問題点をすべて返す（画面で一度に直せるようにする）', async () => {
    const { env } = createEnv()

    const response = await save(env, {
      usages: {
        ...broadcasterConfig.usages,
        aiChat: { provider: 'openai', models: { 'workers-ai': '', openrouter: 'meta-llama/llama-3.1-8b-instruct' } },
      },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual([expect.stringContaining('aiChat.provider'), expect.stringContaining('aiChat.models.workers-ai')])
  })
})

describe('LLMの使用状況（/api/admin/llm/usage）', () => {
  const read = async (env: Env) => invoke(await broadcasterRequest(env, '/api/admin/llm/usage'), env)

  it('セッションがなければ401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/llm/usage`), env)).status).toBe(401)
  })

  it('記録した使用状況を、日ごとのまとめとして返す', async () => {
    const { env } = createEnv()
    await recordLlmUsage(
      env.DB,
      {
        usage: 'streamSummary',
        provider: 'openrouter',
        model: 'anthropic/claude-3.5-haiku',
        promptTokens: 900,
        completionTokens: 200,
        costUsd: 0.000_45,
        failed: false,
      },
      now,
    )

    const response = await read(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      days: [
        {
          day: '2026-09-21',
          usage: 'streamSummary',
          provider: 'openrouter',
          model: 'anthropic/claude-3.5-haiku',
          calls: 1,
          failures: 0,
          promptTokens: 900,
          completionTokens: 200,
          costUsd: 0.000_45,
        },
      ],
    })
  })

  it('まだ一度も呼んでいなければ、空の一覧を返す', async () => {
    const { env } = createEnv()

    expect(await (await read(env)).json()).toEqual({ days: [] })
  })
})

describe('OpenRouter の残高（/api/admin/llm/credits）', () => {
  const read = async (env: Env, fetchImpl?: typeof fetch) => invoke(await broadcasterRequest(env, '/api/admin/llm/credits'), env, fetchImpl)

  it('セッションがなければ401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/llm/credits`), env)).status).toBe(401)
  })

  it('鍵があれば OpenRouter へ問い合わせ、付与額・使用額・残りを返す', async () => {
    const { env } = createEnv()
    const withKey = { ...env, OPENROUTER_API_KEY: 'openrouter-test-key' }
    const called: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      called.push(String(input))
      return Response.json({ data: { total_credits: 10, total_usage: 2.5 } })
    }) as typeof fetch

    const response = await read(withKey, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ totalCredits: 10, totalUsage: 2.5, remaining: 7.5 })
    expect(called).toEqual(['https://openrouter.ai/api/v1/credits'])
  })

  it('鍵が設定されていなければ、OpenRouter へ問い合わせずに400を返す', async () => {
    const { env } = createEnv()

    const response = await read(env)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'no-api-key' } })
  })
})

describe('選べるモデルの一覧（/api/admin/llm/models）', () => {
  const read = async (env: Env, provider: string, fetchImpl?: typeof fetch) =>
    invoke(await broadcasterRequest(env, `/api/admin/llm/models?provider=${provider}`), env, fetchImpl)

  it('セッションがなければ401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/llm/models?provider=workers-ai`), env)).status).toBe(401)
  })

  it('Workers AI の候補を返す（Cloudflareへは問い合わせない）', async () => {
    const { env } = createEnv()

    const response = await read(env, 'workers-ai')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: { id: string; name: string }[] }
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models.every(({ id }) => id.startsWith('@cf/'))).toBe(true)
  })

  it('OpenRouter の候補は公開APIから取る（鍵は要らない）', async () => {
    const { env } = createEnv()
    const called: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      called.push(String(input))
      return Response.json({
        data: [{ id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku', architecture: { output_modalities: ['text'] } }],
      })
    }) as unknown as typeof fetch

    const response = await read(env, 'openrouter', fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ models: [{ id: 'anthropic/claude-3.5-haiku', name: 'Anthropic: Claude 3.5 Haiku' }] })
    expect(called).toEqual(['https://openrouter.ai/api/v1/models'])
  })

  it('知らない提供元を渡されたら400を返す', async () => {
    const { env } = createEnv()

    const response = await read(env, 'openai')

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-provider')
  })
})

describe('オーバーレイの構成（/api/admin/overlay/layout・/api/overlay/layout）', () => {
  /** 配信者が組み立てた構成。背面のオーバーレイに壁紙、前面のオーバーレイに時計とアラートを重ねたもの */
  const broadcasterLayout = {
    overlays: [
      { name: 'back', items: [{ kind: 'wallpaper', id: 'aurora', params: 'speed=2', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
      {
        name: 'front',
        items: [
          { kind: 'clock', id: 'analog', params: '', rect: { x: 78, y: 70, width: 20, height: 26 } },
          { kind: 'alerts', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } },
        ],
      },
    ],
  }

  const save = async (env: Env, layout: unknown) =>
    invoke(
      await broadcasterRequest(env, '/api/admin/overlay/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
      }),
      env,
    )

  const stagePageReads = (env: Env, key = issuedKey) => invoke(new Request(`${origin}/api/overlay/layout?key=${key}`), env)

  it('セッションがなければ、取得も保存も401を返す', async () => {
    const { env } = createEnv()

    expect((await invoke(new Request(`${origin}/api/admin/overlay/layout`), env)).status).toBe(401)
    expect((await invoke(new Request(`${origin}/api/admin/overlay/layout`, { method: 'PUT', body: '{}' }), env)).status).toBe(401)
  })

  it('保存した構成を、管理画面からも合成ページからも読める', async () => {
    const { env } = createEnv()

    expect((await save(env, broadcasterLayout)).status).toBe(200)

    expect(await (await invoke(await broadcasterRequest(env, '/api/admin/overlay/layout'), env)).json()).toEqual(broadcasterLayout)
    expect(await (await stagePageReads(env)).json()).toEqual(broadcasterLayout)
  })

  it('まだ保存していなければ、オーバーレイが1つもない構成を返す', async () => {
    const { env } = createEnv()

    const response = await stagePageReads(env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ overlays: [] })
  })

  it('形に問題があれば400で拒み、問題点をすべて返す（画面で一度に直せるようにする）', async () => {
    const { env } = createEnv()

    const response = await save(env, {
      overlays: [
        { name: 'back', items: [{ kind: 'wallpaper', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
        { name: '前面', items: [{ kind: 'clock', id: 'analog', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
      ],
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toHaveLength(2)
  })

  it('合成ページのキーが違えば401を返す', async () => {
    const { env } = createEnv()

    const response = await stagePageReads(env, 'atezuppou')

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('invalid-overlay-key')
  })
})
