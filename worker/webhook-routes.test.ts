/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）のテスト
 *
 * Twitchの代わりに署名付きのリクエストを作り、handleRequest を通して確かめる。特に重要なのは次の3点。
 * - 署名が正しくない・古い通知を受け付けないこと
 * - 購読の確認（challenge）にそのまま応答すること
 * - 同じ通知が再送されても二重に数えないこと
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { getSession, listFailures, listSessions, recordLiveStream } from './stats-store'
import { saveToken } from './token'

const 現在時刻 = Date.parse('2026-09-21T12:30:00Z')
const 配信者のID = '12345'
const サイト = 'https://stream-assets.example.com'
const シークレット = 'テスト用のWebhookシークレット'

const 環境を作る = () => {
  const db = createFakeDatabase()
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: db,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: シークレット,
  } satisfies Env
  return { env, db }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

interface 通知の内容 {
  messageType?: string
  messageId?: string
  timestamp?: string
  secret?: string
  body: unknown
}

/** Twitchが送ってくるのと同じ形の、署名付きのリクエストを作る */
const Twitchからの通知 = ({
  messageType = 'notification',
  messageId = 'message-1',
  timestamp = '2026-09-21T12:29:50.123456789Z',
  secret = シークレット,
  body,
}: 通知の内容): Request => {
  const text = JSON.stringify(body)
  const signature = createHmac('sha256', secret).update(messageId + timestamp + text).digest('hex')
  return new Request(`${サイト}/api/eventsub/webhook`, {
    method: 'POST',
    headers: {
      'Twitch-Eventsub-Message-Id': messageId,
      'Twitch-Eventsub-Message-Timestamp': timestamp,
      'Twitch-Eventsub-Message-Signature': `sha256=${signature}`,
      'Twitch-Eventsub-Message-Type': messageType,
    },
    body: text,
  })
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchへは通信しない) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻 })

const エラーコード = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

const レイドの通知 = { subscription: { type: 'channel.raid' }, event: { from_broadcaster_user_name: 'レイド元の配信者', viewers: 30 } }
const 雑談配信 = { id: '40000000001', startedAt: '2026-09-21T12:00:00.000Z', title: '月曜の雑談配信', categoryName: 'Just Chatting', viewerCount: 10 }

describe('通知の検証', () => {
  it('署名が正しくなければ403にし、何も記録しない', async () => {
    const { env, db } = 環境を作る()
    const response = await 呼び出す(Twitchからの通知({ body: レイドの通知, secret: '攻撃者が推測したシークレット' }), env)

    expect(response.status).toBe(403)
    expect(await エラーコード(response)).toBe('invalid-signature')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  it('Twitchのヘッダーが欠けていたら400にする', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(new Request(`${サイト}/api/eventsub/webhook`, { method: 'POST', body: '{}' }), env)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-webhook')
  })

  it('10分より古い通知は、署名が正しくても受け付けない（使い回しへの備え）', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(Twitchからの通知({ body: レイドの通知, timestamp: '2026-09-21T12:19:00Z' }), env)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('stale-message')
  })

  it('EVENTSUB_SECRET が設定されていなければ500にする', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(Twitchからの通知({ body: レイドの通知 }), { ...env, EVENTSUB_SECRET: '' })

    expect(response.status).toBe(500)
    expect(await エラーコード(response)).toBe('misconfigured')
  })
})

describe('購読の確認', () => {
  it('challenge をそのままテキストで返す', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(
      Twitchからの通知({ messageType: 'webhook_callback_verification', body: { challenge: 'Twitchが決めた文字列', subscription: { type: 'channel.raid' } } }),
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(await response.text()).toBe('Twitchが決めた文字列')
  })
})

describe('イベントの記録', () => {
  it.each(['channel.subscribe', 'channel.subscription.message', 'channel.channel_points_custom_reward_redemption.add', 'channel.raid'])(
    '%s を、配信中のセッションに結び付けて1件記録する',
    async (type) => {
      const { env, db } = 環境を作る()
      await recordLiveStream(db, 雑談配信, Date.parse('2026-09-21T12:05:00Z'))
      const response = await 呼び出す(Twitchからの通知({ body: { subscription: { type }, event: {} } }), env)

      expect(response.status).toBe(204)
      expect((await listSessions(db, 現在時刻))[0]?.eventCounts).toEqual({ [type]: 1 })
    },
  )

  it('同じメッセージIDの通知が再送されても、二重に数えない', async () => {
    const { env, db } = 環境を作る()
    await recordLiveStream(db, 雑談配信, Date.parse('2026-09-21T12:05:00Z'))
    await 呼び出す(Twitchからの通知({ body: レイドの通知 }), env)
    const response = await 呼び出す(Twitchからの通知({ body: レイドの通知 }), env)

    expect(response.status).toBe(204)
    expect((await listSessions(db, 現在時刻))[0]?.eventCounts).toEqual({ 'channel.raid': 1 })
  })

  it('購読していない種類の通知は400にする（黙って捨てない）', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(Twitchからの通知({ body: { subscription: { type: 'channel.ban' }, event: {} } }), env)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('unexpected-event')
  })
})

describe('配信の開始と終了', () => {
  it('stream.online でセッションを開始し、stream.offline で通知の時刻に閉じる', async () => {
    const { env, db } = 環境を作る()
    await 呼び出す(
      Twitchからの通知({ body: { subscription: { type: 'stream.online' }, event: { id: '40000000001', type: 'live', started_at: '2026-09-21T12:00:00Z' } } }),
      env,
    )
    expect(await getSession(db, '40000000001')).toMatchObject({ startedAt: '2026-09-21T12:00:00.000Z', endedAt: null })

    const response = await 呼び出す(
      Twitchからの通知({ messageId: 'message-2', timestamp: '2026-09-21T12:29:55.5Z', body: { subscription: { type: 'stream.offline' }, event: {} } }),
      env,
    )
    expect(response.status).toBe(204)
    expect((await getSession(db, '40000000001'))?.endedAt).toBe('2026-09-21T12:29:55.500Z')
  })

  it('stream.online の通知に配信IDや開始日時が無ければ400にする', async () => {
    const { env } = 環境を作る()
    const response = await 呼び出す(Twitchからの通知({ body: { subscription: { type: 'stream.online' }, event: { type: 'live' } } }), env)

    expect(response.status).toBe(400)
    expect(await エラーコード(response)).toBe('invalid-webhook')
  })
})

describe('購読の失効', () => {
  it('失効の通知は、収集の失敗として記録する（管理画面から気づけるように）', async () => {
    const { env, db } = 環境を作る()
    const response = await 呼び出す(
      Twitchからの通知({ messageType: 'revocation', body: { subscription: { type: 'channel.raid', status: 'authorization_revoked' } } }),
      env,
    )

    expect(response.status).toBe(204)
    expect(await listFailures(db)).toMatchObject([{ code: 'subscription-revoked', message: expect.stringContaining('channel.raid') }])
  })
})

describe('チャットの通知（channel.chat.message）', () => {
  const botのID = '67890'

  /** botを接続済みの環境を作る */
  const bot接続済みの環境 = async () => {
    const { env, db } = 環境を作る()
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: botのID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  /** 視聴者の発言としての通知 */
  const チャットの通知 = (text: string, chatterUserId = '11111') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: 配信者のID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'shichousha',
      message_id: 'chat-message-1',
      message: { text },
    },
  })

  /** チャット送信に応える Twitch の代役 */
  const 送信に応えるTwitch = (chatResponse: Response = Response.json({ data: [{ message_id: 'sent', is_sent: true }] })) => {
    const 送信したチャット: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        送信したチャット.push(request.clone())
        return chatResponse.clone()
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { 送信したチャット, fetchImpl }
  }

  it('コマンドに一致する発言には、botの名前で応答する', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: チャットの通知('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.送信したチャット[0]!.json()).toEqual({
      broadcaster_id: 配信者のID,
      sender_id: botのID,
      message: '@shichousha pong',
    })
  })

  it('コマンドではない発言には、Twitchへ何も送らない', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: チャットの通知('こんばんは') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('bot自身の発言には応答しない（応答し続けて止まらなくなるため）', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: チャットの通知('!ping', botのID) }), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('チャットは配信の記録（D1）に書かない（件数の桁が違い、書き込みの枠を食い合うため）', async () => {
    const { env, db } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: チャットの通知('!ping') }), env, twitch.fetchImpl)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  it('botを接続していなければ、応答せずに受け取るだけにする', async () => {
    const { env } = 環境を作る()
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: チャットの通知('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('応答の送信に失敗しても2xxを返し、失敗として記録する（5xxだとTwitchが再送して二重投稿になるため）', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch(Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

    const response = await 呼び出す(Twitchからの通知({ body: チャットの通知('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-reply-failed', message: expect.stringContaining('Missing scope') }])
  })

  it('通知の中身が想定と違えば、黙って捨てずに400にする', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()
    const 本文のない通知 = { subscription: { type: 'channel.chat.message' }, event: { chatter_user_id: '11111' } }

    const response = await 呼び出す(Twitchからの通知({ body: 本文のない通知 }), env, twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(twitch.送信したチャット).toHaveLength(0)
  })
})
