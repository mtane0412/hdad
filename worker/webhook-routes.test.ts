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
import { createFakeAi } from './fake-ai'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { getSession, listFailures, listSessions, recordLiveStream } from './stats-store'
import { saveBotConfig } from './bot-config'
import { saveStreamSummary } from './stream-summary-store'
import { saveModerationConfig } from './moderation-config'
import type { ModerationConfig, ModerationRule } from './chat-moderation'
import { saveAlertConfig, type StoredTrigger } from './alert-config'
import { saveToken } from './token'
import { listViewers, recordViewerMessage, updateViewerNote } from './viewer-store'
import { createFakeAlertChannel } from './fake-alert-channel'

interface 環境の条件 {
  /** アラートの配送先（Durable Object）が失敗を返す場合 */
  配送は失敗する?: boolean
  /** オーバーレイ用キー。null なら未発行（一度もログインしていない状態） */
  オーバーレイ用キー?: string | null
  /** LLM（Workers AI）が失敗を返す場合（無料枠を使い切ったときなど） */
  LLMは失敗する?: boolean
  /** LLMが返す文面。省略すると代役の既定の文面になる */
  LLMの文面?: string
}

const 現在時刻 = Date.parse('2026-09-21T12:30:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const シークレット = 'テスト用のWebhookシークレット'

const 発行済みのオーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

const 環境を作る = ({ 配送は失敗する = false, オーバーレイ用キー = 発行済みのオーバーレイ用キー, LLMは失敗する = false, LLMの文面 }: 環境の条件 = {}) => {
  const db = createFakeDatabase()
  const 配送 = createFakeAlertChannel({ 失敗する: 配送は失敗する })
  const ai = createFakeAi({ 失敗する: LLMは失敗する, ...(LLMの文面 === undefined ? {} : { response: LLMの文面 }) })
  const env = {
    STORE: createFakeStore(オーバーレイ用キー === null ? {} : { 'overlay-key': オーバーレイ用キー }),
    MEDIA: createFakeBucket(),
    DB: db,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: シークレット,
    ALERTS: 配送.namespace,
    AI: ai,
  } satisfies Env
  return { env, db, 配送, ai }
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

/**
 * waitUntil で後回しにされた処理を集める。
 *
 * LLMに文面を作らせる動作は、Twitchへ2xxを返したあとに送る（応答が遅れると再送されるため）。
 * テストではその「あとで走る処理」を取りこぼさないよう、ここへ集めて 後回しの処理を待つ() でまとめて待つ。
 */
let 後回しの処理: Promise<unknown>[] = []

const 後回しの処理を待つ = async (): Promise<void> => {
  const 待つもの = 後回しの処理
  後回しの処理 = []
  await Promise.all(待つもの)
}

const 呼び出す = (request: Request, env: Env, fetchImpl: typeof fetch = Twitchへは通信しない, wait: (milliseconds: number) => Promise<void> = 待たない) =>
  handleRequest(request, env, {
    fetch: fetchImpl,
    now: () => 現在時刻,
    wait,
    waitUntil: (promise) => {
      後回しの処理.push(promise)
    },
  })

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
      chatter_user_name: '視聴者さん',
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

  it('発言した人を視聴者の記録に残す（発言そのものは貯めず、人だけを貯める）', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: チャットの通知('こんばんは') }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toMatchObject([{ userId: '11111', login: 'shichousha', displayName: '視聴者さん', messageCount: 1 }])
  })

  it('配信中の発言は、人物像の材料として本文も貯める', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()
    env.DB.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run('haishin-1', new Date(現在時刻 - 60 * 1000).toISOString(), '雑談配信', 'Just Chatting')

    await 呼び出す(Twitchからの通知({ body: チャットの通知('こんばんは') }), env, twitch.fetchImpl)

    expect(env.DB.sqlite.prepare('SELECT user_id, text FROM stream_chat_messages').all()).toEqual([{ user_id: '11111', text: 'こんばんは' }])
  })

  it('配信していないときは、人物像の材料を貯めない', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: チャットの通知('こんばんは') }), env, twitch.fetchImpl)

    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('bot自身の発言は視聴者の記録に残さない', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: チャットの通知('こんばんは', botのID) }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toEqual([])
  })

  it('別のチャンネルのチャットは視聴者の記録に残さない（古い購読が残っていても、他人のチャンネルの人を貯めないため）', async () => {
    const { env } = await bot接続済みの環境()
    const twitch = 送信に応えるTwitch()
    const 別のチャンネルの通知 = {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '99999',
        chatter_user_id: '11111',
        chatter_user_login: 'shichousha',
        chatter_user_name: '視聴者さん',
        message_id: 'chat-message-3',
        message: { text: 'こんばんは' },
      },
    }

    await 呼び出す(Twitchからの通知({ body: 別のチャンネルの通知 }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toEqual([])
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
      chatter_user_name: '視聴者さん',
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
      chatter_user_name: '視聴者さん',
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

  it('{summary} を含むコマンドには、貯めてある配信中のあらすじを差し込んで応答する', async () => {
    const { env, db } = await bot接続済みの環境([{ name: 'summary', reply: 'これまでのあらすじ: {summary}', cooldownSeconds: 0 }])
    await recordLiveStream(db, 雑談配信, 現在時刻 - 60 * 1000)
    await saveStreamSummary(
      db,
      { sessionId: 雑談配信.id, summary: '配信者は新しいゲームを遊んでいます', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' } },
      現在時刻 - 30 * 1000,
    )
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!summary'))

    expect(await twitch.送信したチャット[0]!.json()).toMatchObject({ message: 'これまでのあらすじ: 配信者は新しいゲームを遊んでいます' })
  })

  it('あらすじがまだ無くても、コマンドは無応答にならない', async () => {
    const { env } = await bot接続済みの環境([{ name: 'summary', reply: 'これまでのあらすじ: {summary}', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 通知を送る(env, twitch.fetchImpl, チャットの通知('!summary'))

    expect(await twitch.送信したチャット[0]!.json()).toMatchObject({ message: 'これまでのあらすじ: まだあらすじがありません' })
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

describe('チャットの発言によるアラートのトリガー', () => {
  const botのID = '67890'

  /** botを接続済みで、チャットの発言のトリガーが保存されている環境を作る */
  const チャットのトリガーのある環境 = async (triggers: StoredTrigger[], commands: { name: string; reply: string; cooldownSeconds: number }[] = []) => {
    const { env, db } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers })
    if (commands.length > 0) await saveBotConfig(env.STORE, { commands })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat', 'moderator:manage:chat_messages'],
      userId: botのID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  const 発言の通知 = (text: string, { chatterUserId = '11111', messageId = 'chat-message-1' } = {}) => ({
    body: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: 配信者のID,
        chatter_user_id: chatterUserId,
        chatter_user_login: 'shichousha',
        chatter_user_name: '視聴者さん',
        message_id: messageId,
        message: { text },
        badges: [],
      },
    },
    messageId,
  })

  /** チャット送信とモデレーション操作に応えるTwitchの代役 */
  const 送信に応えるTwitch = () => {
    const 送信したチャット: Request[] = []
    const 呼んだURL: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/helix/chat/messages') {
        送信したチャット.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      if (url.pathname === '/helix/moderation/chat' || url.pathname === '/helix/moderation/bans') {
        呼んだURL.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { 送信したチャット, 呼んだURL, fetchImpl }
  }

  const 挨拶に応える: StoredTrigger = {
    event: 'channel.chat.message',
    conditions: [{ kind: 'text', contains: 'おはよう' }],
    actions: [{ type: 'chat', message: '{user} さん、おはようございます！' }],
  }

  it('文面の条件に当てはまる発言に、botの名前で送る', async () => {
    const { env } = await チャットのトリガーのある環境([挨拶に応える])
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知(発言の通知('みなさんおはようございます')), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.送信したチャット[0]!.json()).toEqual({
      broadcaster_id: 配信者のID,
      sender_id: botのID,
      message: '視聴者さん さん、おはようございます！',
    })
  })

  it('文面の条件に当てはまらない発言には、何も送らない', async () => {
    const { env } = await チャットのトリガーのある環境([挨拶に応える])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('bot自身の発言では決してトリガーを引かない（応答し続けて止まらなくなるため）', async () => {
    const { env } = await チャットのトリガーのある環境([挨拶に応える])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('おはようございます', { chatterUserId: botのID })), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('自動モデレーションで処分した発言では、トリガーを引かない', async () => {
    const { env } = await チャットのトリガーのある環境([挨拶に応える])
    await saveModerationConfig(env.STORE, {
      enabled: true,
      exemptBroadcaster: true,
      exemptVip: true,
      exemptSubscriber: true,
      rules: [{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }],
    })
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('おはよう、宣伝です')), env, twitch.fetchImpl)

    expect(twitch.呼んだURL).toEqual(['DELETE /helix/moderation/chat'])
    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度送らない', async () => {
    const { env } = await チャットのトリガーのある環境([挨拶に応える])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('おはよう')), env, twitch.fetchImpl)
    await 呼び出す(Twitchからの通知(発言の通知('おはよう')), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('コマンドにもトリガーにも当てはまる発言では、どちらも送る（鍵を取り合わない）', async () => {
    const トリガー: StoredTrigger = {
      event: 'channel.chat.message',
      conditions: [{ kind: 'text', contains: '!ping' }],
      actions: [{ type: 'chat', message: '{user} さんが ping しました' }],
    }
    const { env } = await チャットのトリガーのある環境([トリガー], [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('!ping')), env, twitch.fetchImpl)

    const 送った文言 = await Promise.all(twitch.送信したチャット.map(async (request) => ((await request.json()) as { message: string }).message))
    expect(送った文言).toEqual(['視聴者さん さんが ping しました', '@shichousha pong'])
  })

  it('アラートを出すだけのトリガーでは、チャットへ何も送らない（オーバーレイが再生する）', async () => {
    const 音を鳴らす: StoredTrigger = {
      event: 'channel.chat.message',
      conditions: [{ kind: 'user', login: 'shichousha' }],
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }
    const { env, db } = await チャットのトリガーのある環境([音を鳴らす])
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知(発言の通知('こんばんは')), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
    // チャットは件数の桁が違うため、トリガーを引いても配信の記録には書かない
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  /** このチャンネルで初めての発言に応えるトリガー */
  const 初見に応える: StoredTrigger = {
    event: 'channel.chat.message',
    conditions: [{ kind: 'firstChatEver' }],
    actions: [{ type: 'chat', message: '{user} さん、はじめまして！' }],
  }

  /** すでに視聴者の記録がある人を作る。日数は現在時刻から何日前に発言していたか */
  const 発言の記録を残す = async (db: ReturnType<typeof createFakeDatabase>, 何日前: number) => {
    await recordViewerMessage(
      db,
      { userId: '11111', login: 'shichousha', displayName: '視聴者さん', badges: [], messageId: 'chat-message-0' },
      現在時刻 - 何日前 * 24 * 60 * 60 * 1000,
    )
  }

  it('記録のない人の発言では、このチャンネルで初めての発言の条件に当てはまる', async () => {
    const { env } = await チャットのトリガーのある環境([初見に応える])
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('はじめまして')), env, twitch.fetchImpl)

    expect(await twitch.送信したチャット[0]?.json()).toMatchObject({ message: '視聴者さん さん、はじめまして！' })
  })

  it('すでに記録のある人の発言では、このチャンネルで初めての発言の条件に当てはまらない', async () => {
    const { env, db } = await チャットのトリガーのある環境([初見に応える])
    await 発言の記録を残す(db, 3)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('最後の発言から指定した日数以上空いていれば、空いた日数の条件に当てはまる', async () => {
    const 久しぶりに応える: StoredTrigger = {
      event: 'channel.chat.message',
      conditions: [{ kind: 'returningAfter', days: 30 }],
      actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }],
    }
    const { env, db } = await チャットのトリガーのある環境([久しぶりに応える])
    await 発言の記録を残す(db, 40)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('おひさしぶりです')), env, twitch.fetchImpl)

    expect(await twitch.送信したチャット[0]?.json()).toMatchObject({ message: '視聴者さん さん、お久しぶりです！' })
  })

  it('最後の発言から日数が足りなければ、空いた日数の条件に当てはまらない', async () => {
    const 久しぶりに応える: StoredTrigger = {
      event: 'channel.chat.message',
      conditions: [{ kind: 'returningAfter', days: 30 }],
      actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }],
    }
    const { env, db } = await チャットのトリガーのある環境([久しぶりに応える])
    await 発言の記録を残す(db, 3)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知(発言の通知('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.送信したチャット).toHaveLength(0)
  })

  it('botを接続していなければ、トリガーを引かずに受け取るだけにする', async () => {
    const { env } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [挨拶に応える] })

    const response = await 呼び出す(Twitchからの通知(発言の通知('おはよう')), env)

    expect(response.status).toBe(204)
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
      chatter_user_name: '荒らしさん',
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

describe('オーバーレイへのアラートの押し出し', () => {
  const botのID = '67890'

  const アラートを出すトリガー = (event: StoredTrigger['event']): StoredTrigger => ({
    event,
    conditions: [],
    actions: [{ type: 'alert', mediaId: 'media-kanpai', mediaKind: 'video', durationSeconds: 5, volume: 0.5, message: '{user} さん、ありがとう！' }],
  })

  const フォローの通知 = { subscription: { type: 'channel.follow' }, event: { user_name: '田中太郎', user_login: 'tanaka_taro' } }

  const 発言の通知 = (chatterUserId = '11111', messageId = 'chat-message-1') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: 配信者のID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: messageId,
      message: { text: 'おはようございます' },
      badges: [],
    },
  })

  const botを接続する = (env: Env) =>
    saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: botのID,
      login: 'haishinsha_bot',
    })

  it('当てはまるトリガーのアラートを、素材のURLにオーバーレイ用キーを付けて押し出す', async () => {
    const { env, 配送 } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.follow')] })

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(response.status).toBe(204)
    expect(配送.押し出されたアラート).toEqual([
      {
        media: { kind: 'video', url: `/api/media/media-kanpai?key=${発行済みのオーバーレイ用キー}` },
        durationSeconds: 5,
        volume: 0.5,
        text: '田中太郎 さん、ありがとう！',
      },
    ])
  })

  it('当てはまるトリガーがなければ、何も押し出さない', async () => {
    const { env, 配送 } = 環境を作る()

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(配送.押し出されたアラート).toHaveLength(0)
  })

  it('botが未接続でも、チャットの発言でアラートを押し出す（アラートの再生にbotは要らない）', async () => {
    const { env, 配送 } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.chat.message')] })

    const response = await 呼び出す(Twitchからの通知({ body: 発言の通知() }), env)

    expect(response.status).toBe(204)
    expect(配送.押し出されたアラート).toMatchObject([{ text: '視聴者さん さん、ありがとう！' }])
  })

  it('bot自身の発言ではアラートを押し出さない（自分の応答に反応して止まらなくなるため）', async () => {
    const { env, 配送 } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.chat.message')] })
    await botを接続する(env)

    await 呼び出す(Twitchからの通知({ body: 発言の通知(botのID) }), env)

    expect(配送.押し出されたアラート).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度は押し出さない', async () => {
    const { env, 配送 } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.follow')] })

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)
    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(配送.押し出されたアラート).toHaveLength(1)
  })

  it('配送先が失敗しても、Twitchへは2xxを返して失敗として記録する（再送で二重に鳴らさないため）', async () => {
    const { env } = 環境を作る({ 配送は失敗する: true })
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.follow')] })

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-push-failed' }])
  })

  it('オーバーレイ用キーが未発行なら押し出さず、失敗として記録する（素材のURLを作れないため）', async () => {
    const { env, 配送 } = 環境を作る({ オーバーレイ用キー: null })
    await saveAlertConfig(env.STORE, { triggers: [アラートを出すトリガー('channel.follow')] })

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)

    expect(response.status).toBe(204)
    expect(配送.押し出されたアラート).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-push-failed' }])
  })
})

describe('LLMに文面を作らせる動作（aiChat）', () => {
  const botのID = '67890'
  const フォローの通知 = { subscription: { type: 'channel.follow' }, event: { user_name: '田中太郎', user_login: 'tanaka_taro' } }

  /** まだ記録のない人からのチャットの発言 */
  const 初めての人の発言 = {
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: 配信者のID,
      chatter_user_id: '22222',
      chatter_user_login: 'hatsumi',
      chatter_user_name: 'はつみ',
      message_id: 'chat-message-hatsumi',
      message: { text: 'はじめまして！' },
    },
  }

  const 文面を作らせるトリガー: StoredTrigger = {
    event: 'channel.follow',
    conditions: [],
    actions: [{ type: 'aiChat', instruction: 'フォローしてくれた人にお礼を言ってください' }],
  }

  const botを接続する = (env: Env) =>
    saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: 現在時刻 + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:write:chat'],
      userId: botのID,
      login: 'haishinsha_bot',
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

  it('当てはまったトリガーの指示でLLMに文面を作らせ、botの名前で送る', async () => {
    const { env } = 環境を作る({ LLMの文面: '太郎さん、フォローありがとうございます！' })
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(response.status).toBe(204)
    expect(await twitch.送信したチャット[0]!.json()).toMatchObject({ message: '太郎さん、フォローありがとうございます！' })
  })

  it('LLMの応答を待たずにTwitchへ2xxを返す（応答が遅れると再送されるため）', async () => {
    const { env } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()
    // 文面ができあがるまで終わらないLLM。テストが合図するまで応答を返さない
    let 文面を返す: (message: string) => void = () => {}
    const 待たせるAI = { run: () => new Promise<unknown>((resolve) => (文面を返す = (message) => resolve({ response: message }))) }

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), { ...env, AI: 待たせるAI }, twitch.fetchImpl)

    // LLMがまだ文面を返していないのに、Twitchへの応答は返っている
    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)

    文面を返す('太郎さん、ありがとう！')
    await 後回しの処理を待つ()
    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('発言した人の記録（メモ・発言数）を材料としてLLMへ渡す', async () => {
    const { env, ai } = 環境を作る()
    await saveAlertConfig(env.STORE, {
      triggers: [{ event: 'channel.chat.message', conditions: [], actions: [{ type: 'aiChat', instruction: '一言返してください' }] }],
    })
    await botを接続する(env)
    await recordViewerMessage(env.DB, { userId: '11111', login: 'shichousha', displayName: '視聴者さん', badges: [], messageId: '古い発言' }, 現在時刻 - 60 * 60 * 1000)
    await updateViewerNote(env.DB, '11111', 'ギターの話が好き')
    const twitch = 送信に応えるTwitch()

    await 呼び出す(
      Twitchからの通知({
        body: {
          subscription: { type: 'channel.chat.message' },
          event: {
            broadcaster_user_id: 配信者のID,
            chatter_user_id: '11111',
            chatter_user_login: 'shichousha',
            chatter_user_name: '視聴者さん',
            message_id: 'chat-message-1',
            message: { text: 'こんばんは' },
          },
        },
      }),
      env,
      twitch.fetchImpl,
    )
    await 後回しの処理を待つ()

    expect(JSON.stringify(ai.呼び出し[0]?.input)).toContain('ギターの話が好き')
  })

  it('条件を持たないトリガーでも、来訪の別（初めて・お久しぶり）を材料に渡す', async () => {
    const { env, ai } = 環境を作る()
    // 条件は1件もない。それでも文面づくりには来訪の別が要るので、Workerは視聴者の記録を読む
    await saveAlertConfig(env.STORE, {
      triggers: [{ event: 'channel.chat.message', conditions: [], actions: [{ type: 'aiChat', instruction: '一言返してください' }] }],
    })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: 初めての人の発言 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(JSON.stringify(ai.呼び出し[0]?.input)).toContain('このチャンネルで初めての発言')
  })

  it('鍵の確保そのものが失敗しても、取りこぼさずに記録する（2xxを返したあとなので再送では取り返せない）', async () => {
    const { env } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()
    // 鍵を持つテーブルを落として、reserveChatReply（送信の前に呼ぶ）を失敗させる
    env.DB.sqlite.prepare('DROP TABLE replied_chat_messages').run()

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed' }])
  })

  it('LLMが失敗したら（無料枠切れなど）送らず、2xxを返したうえで記録する', async () => {
    const { env } = 環境を作る({ LLMは失敗する: true })
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(response.status).toBe(204)
    expect(twitch.送信したチャット).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed' }])
  })

  it('500文字を超えた文面は、切り詰めずに送るのをやめて記録する', async () => {
    const { env } = 環境を作る({ LLMの文面: 'あ'.repeat(501) })
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(twitch.送信したチャット).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed', message: expect.stringContaining('500文字') }])
  })

  it('同じ通知が再送されても、2通は送らない', async () => {
    const { env } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })
    await botを接続する(env)
    const twitch = 送信に応えるTwitch()

    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()
    await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env, twitch.fetchImpl)
    await 後回しの処理を待つ()

    expect(twitch.送信したチャット).toHaveLength(1)
  })

  it('botを接続していなければ、LLMも呼ばずに何もしない（送る先がないため）', async () => {
    const { env, ai } = 環境を作る()
    await saveAlertConfig(env.STORE, { triggers: [文面を作らせるトリガー] })

    const response = await 呼び出す(Twitchからの通知({ body: フォローの通知 }), env)
    await 後回しの処理を待つ()

    expect(response.status).toBe(204)
    expect(ai.呼び出し).toHaveLength(0)
  })
})
