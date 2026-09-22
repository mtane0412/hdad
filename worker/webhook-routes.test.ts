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
import { saveBotConfig } from './bot-config'
import { saveModerationConfig } from './moderation-config'
import type { ModerationConfig, ModerationRule } from './chat-moderation'
import { saveAlertConfig, type StoredTrigger } from './alert-config'
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

/** テストでは実際に待たず、待つよう求められた時間だけを記録する */
const 待たない = async (): Promise<void> => {}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchへは通信しない, wait: (milliseconds: number) => Promise<void> = 待たない) =>
  handleRequest(request, env, { fetch: fetchImpl, now: () => 現在時刻, wait })

const エラーコード = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

const レイドの通知 = {
  subscription: { type: 'channel.raid' },
  event: { from_broadcaster_user_name: 'レイド元の配信者', from_broadcaster_user_login: 'raid_moto', viewers: 30 },
}
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

  /** botを接続済みで、コマンドが1つ登録されている環境を作る */
  const bot接続済みの環境 = async (cooldownSeconds = 0) => {
    const { env, db } = 環境を作る()
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds }] })
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
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }] })
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

  it('別のチャンネルのチャットには応答しない（古い購読が残っていても、他人のチャットで反応しないため）', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()
    const 別のチャンネルの通知 = {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '99999',
        chatter_user_id: '11111',
        chatter_user_login: 'shichousha',
        message_id: 'chat-message-2',
        message: { text: '!ping' },
      },
    }

    const response = await 呼び出す(Twitchからの通知({ body: 別のチャンネルの通知 }), env, twitch.fetchImpl)

    // 受け取り自体は成功として返す（2xx以外だとTwitchが再送し続けるため）
    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
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

describe('チャットの応答の設定・連打・再送', () => {
  const botのID = '67890'

  const bot接続済みの環境 = async (commands: { name: string; reply: string; cooldownSeconds: number }[]) => {
    const { env, db } = 環境を作る()
    await saveBotConfig(env.STORE, { commands })
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

  const チャットの通知 = (text: string, messageId = 'chat-message-1') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: 配信者のID,
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      message_id: messageId,
      message: { text },
    },
  })

  const 送信に応えるTwitch = () => {
    const 送信したチャット: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        送信したチャット.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { 送信したチャット, fetchImpl }
  }

  /** 通知を1件送る。届いた時刻（通知のタイムスタンプ）も指定できる */
  const 通知を送る = (env: Env, fetchImpl: typeof fetch, body: unknown, messageId = 'chat-message-1') =>
    呼び出す(Twitchからの通知({ body, messageId }), env, fetchImpl)

  it('管理画面で登録したコマンドに応答する', async () => {
    const { env } = await bot接続済みの環境([{ name: 'discord', reply: 'Discordはこちらです', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!discord'))

    expect(await twitch.送信したチャット[0]!.json()).toMatchObject({ message: 'Discordはこちらです' })
  })

  it('コマンドを1つも登録していなければ、何にも応答しない', async () => {
    const { env } = await bot接続済みの環境([])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!discord'))

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度応答しない', async () => {
    const { env } = await bot接続済みの環境([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping'))
    const 再送 = await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping'))

    expect(再送.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('クールダウン中の連打には応答しない', async () => {
    const { env } = await bot接続済みの環境([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 60 }])
    const twitch = 送信に応えるTwitch()

    // 別々のメッセージID（別の発言）として続けて届く
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping', 'chat-message-1'), 'chat-message-1')
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping', 'chat-message-2'), 'chat-message-2')

    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('クールダウンが0なら、続けて応答する', async () => {
    const { env } = await bot接続済みの環境([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping', 'chat-message-1'), 'chat-message-1')
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping', 'chat-message-2'), 'chat-message-2')

    expect(twitch.送信したチャット).toHaveLength(2)
  })

  it('コマンドに一致しない発言では、D1に何も書かない（チャット全件を記録しないため）', async () => {
    const { env, db } = await bot接続済みの環境([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('こんばんは'))

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM replied_chat_messages').get()).toEqual({ count: 0 })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM command_uses').get()).toEqual({ count: 0 })
  })
})

describe('アラートのトリガーによるチャット送信', () => {
  const botのID = '67890'

  /** botを接続済みで、アラートのトリガーが保存されている環境を作る */
  const トリガーのある環境 = async (triggers: StoredTrigger[]) => {
    const { env, db } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers })
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

  const 送信に応えるTwitch = (
    chatResponse: Response = Response.json({ data: [{ message_id: 'sent', is_sent: true }] }),
    announcementResponse: Response = new Response(null, { status: 204 }),
  ) => {
    const 送信したチャット: Request[] = []
    const 送信したアナウンス: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        送信したチャット.push(request.clone())
        return chatResponse.clone()
      }
      if (request.url.startsWith('https://api.twitch.tv/helix/chat/announcements')) {
        送信したアナウンス.push(request.clone())
        return announcementResponse.clone()
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { 送信したチャット, 送信したアナウンス, fetchImpl }
  }

  const フォローの通知 = { subscription: { type: 'channel.follow' }, event: { user_name: '田中太郎', user_login: 'tanaka_taro' } }
  const フォローでお礼を言う: StoredTrigger = {
    event: 'channel.follow',
    conditions: [],
    actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }],
  }
  const フォローで音を鳴らす: StoredTrigger = {
    event: 'channel.follow',
    conditions: [],
    actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
  }

  it('チャットに送る動作を持つトリガーに当てはまれば、botの名前で送る', async () => {
    const { env } = await トリガーのある環境([フォローでお礼を言う])
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.送信したチャット[0]!.json()).toEqual({
      broadcaster_id: 配信者のID,
      sender_id: botのID,
      message: '田中太郎 さん、フォローありがとうございます！',
    })
  })

  it('アラートを出すだけのトリガーでは、チャットへ何も送らない（オーバーレイが再生する）', async () => {
    const { env } = await トリガーのある環境([フォローで音を鳴らす])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('件数を数えるイベント（レイド）でも、記録とチャット送信の両方を行う', async () => {
    const レイドにお礼を言う: StoredTrigger = { event: 'channel.raid', conditions: [], actions: [{ type: 'chat', message: '{user} さん、{viewers}人でのレイドありがとう！' }] }
    const { env, db } = await トリガーのある環境([レイドにお礼を言う])
    await recordLiveStream(db, 雑談配信, Date.parse('2026-09-21T12:05:00Z'))
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: レイドの通知 }), env, twitch.fetchImpl)

    expect(await twitch.送信したチャット[0]!.json()).toMatchObject({ message: 'レイド元の配信者 さん、30人でのレイドありがとう！' })
    expect((await listSessions(db, 現在時刻))[0]?.eventCounts).toEqual({ 'channel.raid': 1 })
  })

  it('フォローは件数を数えないが、購読していない種類として拒否もしない', async () => {
    const { env, db } = await トリガーのある環境([])
    await recordLiveStream(db, 雑談配信, Date.parse('2026-09-21T12:05:00Z'))

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(response.status).toBe(204)
    expect((await listSessions(db, 現在時刻))[0]?.eventCounts).toEqual({})
  })

  it('同じ通知が再送されても、二度送らない', async () => {
    const { env } = await トリガーのある環境([フォローでお礼を言う])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    const 再送 = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

    expect(再送.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('botを接続していなければ、送らずに受け取るだけにする', async () => {
    const { env } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [フォローでお礼を言う] })
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('送信に失敗しても2xxを返し、失敗として記録する（5xxだとTwitchが再送して二重投稿になるため）', async () => {
    const { env } = await トリガーのある環境([フォローでお礼を言う])
    const twitch = 送信に応えるTwitch(Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-chat-failed', message: expect.stringContaining('Missing scope') }])
  })

  it('イベントの中身が想定と違えば、黙って捨てずに400にする', async () => {
    const { env } = await トリガーのある環境([フォローでお礼を言う])
    const twitch = 送信に応えるTwitch()
    const 名前のないフォロー = { subscription: { type: 'channel.follow' }, event: { user_login: 'tanaka' } }

    const response = await 呼び出す(Twitchからの通知({ body: 名前のないフォロー }), env, twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  describe('アナウンスを送る動作', () => {
    const フォローでアナウンスする: StoredTrigger = {
      event: 'channel.follow',
      conditions: [],
      actions: [{ type: 'announce', message: '{user} さん、フォローありがとうございます！', color: 'purple' }],
    }

    it('アナウンスを送る動作を持つトリガーに当てはまれば、botがモデレーターとしてアナウンスを送る', async () => {
      const { env } = await トリガーのある環境([フォローでアナウンスする])
      const twitch = 送信に応えるTwitch()

      const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      const request = twitch.送信したアナウンス[0]!
      const url = new URL(request.url)
      expect(url.searchParams.get('broadcaster_id')).toBe(配信者のID)
      // アナウンスを送るのはbot自身なので、moderator_id はbotのID
      expect(url.searchParams.get('moderator_id')).toBe(botのID)
      expect(await request.json()).toEqual({ message: '田中太郎 さん、フォローありがとうございます！', color: 'purple' })
      // アナウンスは通常のチャット送信とは別の経路なので、両方に送らない
      expect(twitch.送信したチャット).toHaveLength(0)
    })

    it('チャットとアナウンスの両方を持つトリガーでは、どちらも送る', async () => {
      const 両方する: StoredTrigger = {
        event: 'channel.follow',
        conditions: [],
        actions: [
          { type: 'chat', message: '{user} さん、ありがとうございます' },
          { type: 'announce', message: '{user} さんがフォローしました', color: 'primary' },
        ],
      }
      const { env } = await トリガーのある環境([両方する])
      const twitch = 送信に応えるTwitch()

      await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

      expect(twitch.送信したチャット).toHaveLength(1)
      expect(twitch.送信したアナウンス).toHaveLength(1)
    })

    it('同じ通知が再送されても、アナウンスを二度送らない', async () => {
      const { env } = await トリガーのある環境([フォローでアナウンスする])
      const twitch = 送信に応えるTwitch()

      await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
      await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

      expect(twitch.送信したアナウンス).toHaveLength(1)
    })

    it('botを接続していなければ、送らずに受け取るだけにする', async () => {
      const { env } = 環境を作る()
      await saveAlertConfig(env.STORE, { triggers: [フォローでアナウンスする] })
      const twitch = 送信に応えるTwitch()

      const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(twitch.送信したアナウンス).toHaveLength(0)
    })

    it('2秒以内に続いた2件目のアナウンスは、間隔が空くまで待ってから送る（アナウンスは2秒に1回しか送れない）', async () => {
      const { env } = await トリガーのある環境([フォローでアナウンスする])
      const twitch = 送信に応えるTwitch()
      const 待った時間: number[] = []
      const 待つ = async (milliseconds: number): Promise<void> => {
        待った時間.push(milliseconds)
      }

      await 呼び出す(Twitchからの通知({ body: フォローの通知, messageId: 'message-1' }), env, twitch.fetchImpl, 待つ)
      await 呼び出す(Twitchからの通知({ body: フォローの通知, messageId: 'message-2' }), env, twitch.fetchImpl, 待つ)

      // 1件目は待たずに送り、2件目は2秒待ってから送るので、どちらも失われない
      expect(twitch.送信したアナウンス).toHaveLength(2)
      expect(待った時間).toEqual([2000])
      expect(await listFailures(env.DB)).toEqual([])
    })

    it('待ち時間の上限を超えるほど詰まっていれば、送らずに失敗として記録する', async () => {
      const { env } = await トリガーのある環境([フォローでアナウンスする])
      const twitch = 送信に応えるTwitch()

      // 同じ時刻に4件続くと、4件目の送信時刻は6秒後になり、上限（4秒）を超える
      for (const messageId of ['message-1', 'message-2', 'message-3', 'message-4']) {
        const response = await 呼び出す(Twitchからの通知({ body: フォローの通知, messageId }), env, twitch.fetchImpl)
        expect(response.status).toBe(204)
      }

      expect(twitch.送信したアナウンス).toHaveLength(3)
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-announce-failed', message: expect.stringContaining('2秒に1回') }])
    })

    it('送信に失敗しても2xxを返し、失敗として記録する（botがモデレーターでない場合など）', async () => {
      const { env } = await トリガーのある環境([フォローでアナウンスする])
      const twitch = 送信に応えるTwitch(undefined, Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

      const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-announce-failed', message: expect.stringContaining('Missing scope') }])
    })
  })
})

describe('チャットの自動モデレーション', () => {
  const botのID = '67890'
  const 荒らしのID = '11111'

  /** botが接続済みで、自動モデレーションの設定が保存されている環境を作る */
  const モデレーションの環境 = async (config: ModerationConfig) => {
    const { env, db } = 環境を作る()
    await saveModerationConfig(env.STORE, config)
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
      userId: botのID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  /** 有効で、除外をすべて有効にした設定。ルールだけを足して使う */
  const 設定 = (rules: ModerationRule[], 上書き: Partial<ModerationConfig> = {}): ModerationConfig => ({
    enabled: true,
    exemptBroadcaster: true,
    exemptVip: true,
    exemptSubscriber: true,
    rules,
    ...上書き,
  })

  const チャットの通知 = (
    text: string,
    { messageId = 'chat-message-1', badges = [] as { set_id: string }[], chatterUserId = 荒らしのID } = {},
  ) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: 配信者のID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'arashi',
      message_id: messageId,
      message: { text },
      badges,
    },
  })

  /** モデレーション操作とチャット送信に応えるTwitch。どのURLを呼んだかを記録する */
  const モデレーションに応えるTwitch = (moderationResponse?: Response) => {
    const 呼んだURL: string[] = []
    const 送信したチャット: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/helix/moderation/chat' || url.pathname === '/helix/moderation/bans') {
        呼んだURL.push(`${request.method} ${url.pathname}`)
        return moderationResponse ? moderationResponse.clone() : new Response(null, { status: 204 })
      }
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        送信したチャット.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { 呼んだURL, 送信したチャット, fetchImpl }
  }

  const 通知を送る = (env: Env, fetchImpl: typeof fetch, body: unknown, messageId = 'chat-message-1') =>
    呼び出す(Twitchからの通知({ body, messageId }), env, fetchImpl)

  it('既定（無効）では、禁止語を含む発言でも処分しない', async () => {
    const { env, db } = await モデレーションの環境({ ...設定([{ kind: 'word', word: '宣伝', punishment: { type: 'ban' } }]), enabled: false })
    const twitch = モデレーションに応えるTwitch()

    const response = await 通知を送る(env, twitch.fetchImpl, チャットの通知('宣伝です'))

    expect(response.status).toBe(204)
    expect(twitch.呼んだURL).toEqual([])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_recent_messages').get()).toEqual({ count: 0 })
  })

  it('禁止語を含む発言を削除する', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('宣伝です'))

    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat'])
  })

  it('BANの処分では、発言を削除してからBANする', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'url', punishment: { type: 'ban' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('https://example.com/spam'))

    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat', 'POST /helix/moderation/bans'])
  })

  it('モデレーターのバッジが付いた発言は処分しない', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'word', word: '宣伝', punishment: { type: 'ban' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('宣伝です', { badges: [{ set_id: 'moderator' }] }))

    expect(twitch.呼んだURL).toEqual([])
  })

  it('bot自身の発言は処分しない（自分の応答を処分して止まらなくなるのを防ぐ）', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('Discordはこちらです https://example.com/discord', { chatterUserId: botのID }))

    expect(twitch.呼んだURL).toEqual([])
  })

  it('処分した発言には、コマンドの応答をしない', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'url', punishment: { type: 'delete' } }]))
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }] })
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!ping https://example.com/spam'))

    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat'])
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度処分しない', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('https://example.com/spam'))
    const 再送 = await 通知を送る(env, twitch.fetchImpl, チャットの通知('https://example.com/spam'))

    expect(再送.status).toBe(204)
    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat'])
  })

  it('同じ文面の連投が回数に達したら処分する', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'timeout', durationSeconds: 600 } }]))
    const twitch = モデレーションに応えるTwitch()

    // 同じ文面を3回。3回目で連投とみなす
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-1' }), 'chat-message-1')
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-3' }), 'chat-message-3')

    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat', 'POST /helix/moderation/bans'])
  })

  it('同じ通知が再送されても、連投とみなさない（1回の発言が2件に数えられないため）', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-1' }), 'chat-message-1')
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')
    // Twitchが2通目を再送してきた。実際の発言は2回なので、3回目の連投にはならない
    await 通知を送る(env, twitch.fetchImpl, チャットの通知('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')

    expect(twitch.呼んだURL).toEqual([])
  })

  it('連投のルールが無ければ、直近の発言をD1に記録しない（チャット全件を書かないため）', async () => {
    const { env, db } = await モデレーションの環境(設定([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('こんばんは'))

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_recent_messages').get()).toEqual({ count: 0 })
  })

  it('処分に失敗しても204を返し、収集の失敗として記録する（2xx以外だと再送されて二重に処分される）', async () => {
    const { env } = await モデレーションの環境(設定([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = モデレーションに応えるTwitch(Response.json({ message: 'User is not a moderator' }, { status: 401 }))

    const response = await 通知を送る(env, twitch.fetchImpl, チャットの通知('https://example.com/spam'))

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'moderation-failed', message: expect.stringContaining('401') }])
  })
})
