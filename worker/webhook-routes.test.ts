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
import { createFakeWorkersAi } from './fake-ai'
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
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'

interface EnvOptions {
  /** アラートの配送先（Durable Object）が失敗を返す場合 */
  channelShouldFail?: boolean
  /** オーバーレイ用キー。null なら未発行（一度もログインしていない状態） */
  overlayKey?: string | null
  /** LLM（Workers AI）が失敗を返す場合（無料枠を使い切ったときなど） */
  llmShouldFail?: boolean
  /** LLMが返す文面。省略すると代役の既定の文面になる */
  llmText?: string
  /** コメントビューアーの配送先（Durable Object）が失敗を返す場合 */
  commentChannelShouldFail?: boolean
}

const NOW = Date.parse('2026-09-21T12:30:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const SECRET = 'テスト用のWebhookシークレット'

const ISSUED_OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'

const createEnv = ({ channelShouldFail = false, overlayKey = ISSUED_OVERLAY_KEY, llmShouldFail = false, llmText, commentChannelShouldFail = false }: EnvOptions = {}) => {
  const db = createFakeDatabase()
  const commentChannel = createFakeCommentChannel({ shouldFail: commentChannelShouldFail })
  const alertChannel = createFakeAlertChannel({ shouldFail: channelShouldFail })
  const adBreakTimer = createFakeAdBreakTimer()
  const ai = createFakeWorkersAi({ shouldFail: llmShouldFail, ...(llmText === undefined ? {} : { response: llmText }) })
  const env = {
    STORE: createFakeStore(overlayKey === null ? {} : { 'overlay-key': overlayKey }),
    MEDIA: createFakeBucket(),
    DB: db,
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: SECRET,
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    COMMENTS: commentChannel.namespace,
    AD_BREAKS: adBreakTimer.namespace,
    AI: ai,
  } satisfies Env
  return { env, db, alertChannel, ai, adBreakTimer, commentChannel }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

interface NotificationOptions {
  messageType?: string
  messageId?: string
  timestamp?: string
  secret?: string
  body: unknown
}

/** Twitchが送ってくるのと同じ形の、署名付きのリクエストを作る */
const createNotification = ({
  messageType = 'notification',
  messageId = 'message-1',
  timestamp = '2026-09-21T12:29:50.123456789Z',
  secret = SECRET,
  body,
}: NotificationOptions): Request => {
  const text = JSON.stringify(body)
  const signature = createHmac('sha256', secret).update(messageId + timestamp + text).digest('hex')
  return new Request(`${SITE}/api/eventsub/webhook`, {
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
const noWait = async (): Promise<void> => {}

/**
 * waitUntil で後回しにされた処理を集める。
 *
 * LLMに文面を作らせる動作は、Twitchへ2xxを返したあとに送る（応答が遅れると再送されるため）。
 * テストではその「あとで走る処理」を取りこぼさないよう、ここへ集めて 後回しの処理を待つ() でまとめて待つ。
 */
let deferredTasks: Promise<unknown>[] = []

const flushDeferredTasks = async (): Promise<void> => {
  const pending = deferredTasks
  deferredTasks = []
  await Promise.all(pending)
}

const callWebhook = (request: Request, env: Env, fetchImpl: typeof fetch = noTwitchFetch, wait: (milliseconds: number) => Promise<void> = noWait) =>
  handleRequest(request, env, {
    fetch: fetchImpl,
    now: () => NOW,
    wait,
    waitUntil: (promise) => {
      deferredTasks.push(promise)
    },
  })

const errorCode = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

const RAID_NOTIFICATION = {
  subscription: { type: 'channel.raid' },
  event: {
    from_broadcaster_user_id: 'レイド元の配信者のユーザーID',
    from_broadcaster_user_name: 'レイド元の配信者',
    from_broadcaster_user_login: 'raid_moto',
    viewers: 30,
  },
}
const CHAT_STREAM = { id: '40000000001', startedAt: '2026-09-21T12:00:00.000Z', title: '月曜の雑談配信', categoryName: 'Just Chatting', viewerCount: 10 }

describe('通知の検証', () => {
  it('署名が正しくなければ403にし、何も記録しない', async () => {
    const { env, db } = createEnv()
    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION, secret: '攻撃者が推測したシークレット' }), env)

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('invalid-signature')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  it('Twitchのヘッダーが欠けていたら400にする', async () => {
    const { env } = createEnv()
    const response = await callWebhook(new Request(`${SITE}/api/eventsub/webhook`, { method: 'POST', body: '{}' }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-webhook')
  })

  it('10分より古い通知は、署名が正しくても受け付けない（使い回しへの備え）', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION, timestamp: '2026-09-21T12:19:00Z' }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('stale-message')
  })

  it('EVENTSUB_SECRET が設定されていなければ500にする', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), { ...env, EVENTSUB_SECRET: '' })

    expect(response.status).toBe(500)
    expect(await errorCode(response)).toBe('misconfigured')
  })
})

describe('広告の通知（channel.ad_break.begin）', () => {
  /** Twitchから届く広告の開始の通知。自動で入った3分の広告 */
  const AD_BREAK_NOTIFICATION = {
    subscription: { type: 'channel.ad_break.begin' },
    event: {
      duration_seconds: 180,
      started_at: '2026-09-21T12:29:50.000Z',
      is_automatic: true,
      broadcaster_user_id: BROADCASTER_ID,
      broadcaster_user_login: 'tanenobu',
      broadcaster_user_name: 'たねのぶ',
      requester_user_id: BROADCASTER_ID,
      requester_user_login: 'tanenobu',
      requester_user_name: 'たねのぶ',
    },
  }

  /** 広告のトリガーを1件だけ持ち、botを接続済みにした環境を作る */
  const envWithAdTrigger = async (trigger: StoredTrigger) => {
    const { env, db, adBreakTimer } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [trigger] })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: '67890',
      login: 'haishinsha_bot',
    })
    return { env, db, adBreakTimer }
  }

  /** チャット送信に応える Twitch の代役 */
  const fakeTwitchAcceptingSends = () => {
    const sentChats: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, fetchImpl }
  }

  it('広告が始まったら、当てはまるトリガーの文言をbotの名前で送る', async () => {
    const { env } = await envWithAdTrigger({
      kind: 'adBreakBegin', automatic: null,
      actions: [{ type: 'chat', message: 'ここで{duration}秒の広告が入ります' }],
    })
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: AD_BREAK_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.sentChats[0]?.json()).toMatchObject({ message: 'ここで180秒の広告が入ります' })
  })

  it('自動で入った広告だけを選ぶ条件（automatic）を満たさなければ、何も送らない', async () => {
    const { env } = await envWithAdTrigger({
      kind: 'adBreakBegin', automatic: false,
      actions: [{ type: 'chat', message: '手動で広告を打ちました' }],
    })
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: AD_BREAK_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toEqual([])
  })

  it('広告の終了のトリガーがあれば、広告が終わる時刻（開始 + 長さ）に予約する', async () => {
    const { env, adBreakTimer } = await envWithAdTrigger({
      kind: 'adBreakEnd', automatic: null,
      actions: [{ type: 'chat', message: '広告が終わりました' }],
    })

    const response = await callWebhook(createNotification({ body: AD_BREAK_NOTIFICATION }), env, fakeTwitchAcceptingSends().fetchImpl)

    expect(response.status).toBe(204)
    expect(adBreakTimer.scheduledEnds).toEqual([
      { event: AD_BREAK_NOTIFICATION.event, messageId: 'message-1', endsAt: Date.parse('2026-09-21T12:29:50.000Z') + 180 * 1000 },
    ])
  })

  it('広告の終了のトリガーが1件もなければ、予約しない（タイマーを無駄に起こさない）', async () => {
    const { env, adBreakTimer } = await envWithAdTrigger({
      kind: 'adBreakBegin', automatic: null,
      actions: [{ type: 'chat', message: 'ここで広告が入ります' }],
    })

    await callWebhook(createNotification({ body: AD_BREAK_NOTIFICATION }), env, fakeTwitchAcceptingSends().fetchImpl)

    expect(adBreakTimer.scheduledEnds).toEqual([])
  })

  it('予約に失敗しても、Twitchへは成功を返して収集の失敗として記録する（再送されても広告の告知は二度送らない）', async () => {
    const { env, db } = await envWithAdTrigger({
      kind: 'adBreakEnd', automatic: null,
      actions: [{ type: 'chat', message: '広告が終わりました' }],
    })
    const envWithFailingSchedule: Env = { ...env, AD_BREAKS: createFakeAdBreakTimer({ shouldFail: true }).namespace }

    const response = await callWebhook(createNotification({ body: AD_BREAK_NOTIFICATION }), envWithFailingSchedule, fakeTwitchAcceptingSends().fetchImpl)

    expect(response.status).toBe(204)
    expect((await listFailures(db)).map((failure) => failure.code)).toEqual(['ad-break-end-schedule-failed'])
  })
})

describe('購読の確認', () => {
  it('challenge をそのままテキストで返す', async () => {
    const { env } = createEnv()
    const response = await callWebhook(
      createNotification({ messageType: 'webhook_callback_verification', body: { challenge: 'Twitchが決めた文字列', subscription: { type: 'channel.raid' } } }),
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
      const { env, db } = createEnv()
      await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
      const response = await callWebhook(createNotification({ body: { subscription: { type }, event: {} } }), env)

      expect(response.status).toBe(204)
      expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({ [type]: 1 })
    },
  )

  it('同じメッセージIDの通知が再送されても、二重に数えない', async () => {
    const { env, db } = createEnv()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)
    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({ 'channel.raid': 1 })
  })

  it('購読していない種類の通知は400にする（黙って捨てない）', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createNotification({ body: { subscription: { type: 'channel.ban' }, event: {} } }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('unexpected-event')
  })
})

describe('配信の開始と終了', () => {
  it('stream.online でセッションを開始し、stream.offline で通知の時刻に閉じる', async () => {
    const { env, db } = createEnv()
    await callWebhook(
      createNotification({ body: { subscription: { type: 'stream.online' }, event: { id: '40000000001', type: 'live', started_at: '2026-09-21T12:00:00Z' } } }),
      env,
    )
    expect(await getSession(db, '40000000001')).toMatchObject({ startedAt: '2026-09-21T12:00:00.000Z', endedAt: null })

    const response = await callWebhook(
      createNotification({ messageId: 'message-2', timestamp: '2026-09-21T12:29:55.5Z', body: { subscription: { type: 'stream.offline' }, event: {} } }),
      env,
    )
    expect(response.status).toBe(204)
    expect((await getSession(db, '40000000001'))?.endedAt).toBe('2026-09-21T12:29:55.500Z')
  })

  it('stream.online の通知に配信IDや開始日時が無ければ400にする', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createNotification({ body: { subscription: { type: 'stream.online' }, event: { type: 'live' } } }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-webhook')
  })
})

describe('購読の失効', () => {
  it('失効の通知は、収集の失敗として記録する（管理画面から気づけるように）', async () => {
    const { env, db } = createEnv()
    const response = await callWebhook(
      createNotification({ messageType: 'revocation', body: { subscription: { type: 'channel.raid', status: 'authorization_revoked' } } }),
      env,
    )

    expect(response.status).toBe(204)
    expect(await listFailures(db)).toMatchObject([{ code: 'subscription-revoked', message: expect.stringContaining('channel.raid') }])
  })
})

describe('チャットの通知（channel.chat.message）', () => {
  const BOT_ID = '67890'

  /** botを接続済みで、コマンドが1つ登録されている環境を作る */
  const envWithBotConnected = async (cooldownSeconds = 0) => {
    const { env, db } = createEnv()
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds }] })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  /** 視聴者の発言としての通知 */
  const createChatNotification = (text: string, chatterUserId = '11111') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'chat-message-1',
      message: { text, fragments: [{ type: 'text', text }] },
    },
  })

  /** チャット送信に応える Twitch の代役 */
  const fakeTwitchAcceptingSends = (chatResponse: Response = Response.json({ data: [{ message_id: 'sent', is_sent: true }] })) => {
    const sentChats: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return chatResponse.clone()
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, fetchImpl }
  }

  it('コマンドに一致する発言には、botの名前で応答する', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createChatNotification('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.sentChats[0]!.json()).toEqual({
      broadcaster_id: BROADCASTER_ID,
      sender_id: BOT_ID,
      message: '@shichousha pong',
    })
  })

  it('コマンドではない発言には、Twitchへ何も送らない', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createChatNotification('こんばんは') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('bot自身の発言には応答しない（応答し続けて止まらなくなるため）', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createChatNotification('!ping', BOT_ID) }), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('チャットは配信の記録（D1）に書かない（件数の桁が違い、書き込みの枠を食い合うため）', async () => {
    const { env, db } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createChatNotification('!ping') }), env, twitch.fetchImpl)

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  it('発言した人を視聴者の記録に残す（発言そのものは貯めず、人だけを貯める）', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createChatNotification('こんばんは') }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toMatchObject([{ userId: '11111', login: 'shichousha', displayName: '視聴者さん', messageCount: 1 }])
  })

  it('配信中の発言は、人物像の材料として本文も貯める', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()
    env.DB.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run('haishin-1', new Date(NOW - 60 * 1000).toISOString(), '雑談配信', 'Just Chatting')

    await callWebhook(createNotification({ body: createChatNotification('こんばんは') }), env, twitch.fetchImpl)

    expect(env.DB.sqlite.prepare('SELECT user_id, text FROM stream_chat_messages').all()).toEqual([{ user_id: '11111', text: 'こんばんは' }])
  })

  it('配信していないときは、人物像の材料を貯めない', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createChatNotification('こんばんは') }), env, twitch.fetchImpl)

    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('bot自身の発言は視聴者の記録に残さない', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createChatNotification('こんばんは', BOT_ID) }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toEqual([])
  })

  it('別のチャンネルのチャットは視聴者の記録に残さない（古い購読が残っていても、他人のチャンネルの人を貯めないため）', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()
    const otherChannelNotification = {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '99999',
        chatter_user_id: '11111',
        chatter_user_login: 'shichousha',
        chatter_user_name: '視聴者さん',
        message_id: 'chat-message-3',
        message: { text: 'こんばんは', fragments: [{ type: 'text', text: 'こんばんは' }] },
      },
    }

    await callWebhook(createNotification({ body: otherChannelNotification }), env, twitch.fetchImpl)

    expect(await listViewers(env.DB, {})).toEqual([])
  })

  it('botを接続していなければ、応答せずに受け取るだけにする', async () => {
    const { env } = createEnv()
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }] })
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createChatNotification('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('応答の送信に失敗しても2xxを返し、失敗として記録する（5xxだとTwitchが再送して二重投稿になるため）', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends(Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

    const response = await callWebhook(createNotification({ body: createChatNotification('!ping') }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-reply-failed', message: expect.stringContaining('Missing scope') }])
  })

  it('別のチャンネルのチャットには応答しない（古い購読が残っていても、他人のチャットで反応しないため）', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()
    const otherChannelNotification = {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: '99999',
        chatter_user_id: '11111',
        chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
        message_id: 'chat-message-2',
        message: { text: '!ping', fragments: [{ type: 'text', text: '!ping' }] },
      },
    }

    const response = await callWebhook(createNotification({ body: otherChannelNotification }), env, twitch.fetchImpl)

    // 受け取り自体は成功として返す（2xx以外だとTwitchが再送し続けるため）
    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('通知の中身が想定と違えば、黙って捨てずに400にする', async () => {
    const { env } = await envWithBotConnected()
    const twitch = fakeTwitchAcceptingSends()
    const emptyBodyNotification = { subscription: { type: 'channel.chat.message' }, event: { chatter_user_id: '11111' } }

    const response = await callWebhook(createNotification({ body: emptyBodyNotification }), env, twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(twitch.sentChats).toHaveLength(0)
  })
})

describe('チャットの応答の設定・連打・再送', () => {
  const BOT_ID = '67890'

  const envWithBotConnected = async (commands: { name: string; reply: string; cooldownSeconds: number }[]) => {
    const { env, db } = createEnv()
    await saveBotConfig(env.STORE, { commands })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  const createChatNotification = (text: string, messageId = 'chat-message-1') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
    },
  })

  const fakeTwitchAcceptingSends = () => {
    const sentChats: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, fetchImpl }
  }

  /** 通知を1件送る。届いた時刻（通知のタイムスタンプ）も指定できる */
  const sendNotification = (env: Env, fetchImpl: typeof fetch, body: unknown, messageId = 'chat-message-1') =>
    callWebhook(createNotification({ body, messageId }), env, fetchImpl)

  it('管理画面で登録したコマンドに応答する', async () => {
    const { env } = await envWithBotConnected([{ name: 'discord', reply: 'Discordはこちらです', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!discord'))

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'Discordはこちらです' })
  })

  it('コマンドを1つも登録していなければ、何にも応答しない', async () => {
    const { env } = await envWithBotConnected([])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!discord'))

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度応答しない', async () => {
    const { env } = await envWithBotConnected([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping'))
    const resent = await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping'))

    expect(resent.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(1)
  })

  it('クールダウン中の連打には応答しない', async () => {
    const { env } = await envWithBotConnected([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 60 }])
    const twitch = fakeTwitchAcceptingSends()

    // 別々のメッセージID（別の発言）として続けて届く
    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping', 'chat-message-1'), 'chat-message-1')
    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping', 'chat-message-2'), 'chat-message-2')

    expect(twitch.sentChats).toHaveLength(1)
  })

  it('クールダウンが0なら、続けて応答する', async () => {
    const { env } = await envWithBotConnected([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping', 'chat-message-1'), 'chat-message-1')
    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping', 'chat-message-2'), 'chat-message-2')

    expect(twitch.sentChats).toHaveLength(2)
  })

  it('{summary} を含むコマンドには、貯めてある配信中のあらすじを差し込んで応答する', async () => {
    const { env, db } = await envWithBotConnected([{ name: 'summary', reply: 'これまでのあらすじ: {summary}', cooldownSeconds: 0 }])
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    await saveStreamSummary(
      db,
      { sessionId: CHAT_STREAM.id, summary: '配信者は新しいゲームを遊んでいます', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' }, screenUntil: { at: '', imageId: '', lineNo: -1 } },
      NOW - 30 * 1000,
    )
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!summary'))

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'これまでのあらすじ: 配信者は新しいゲームを遊んでいます' })
  })

  it('あらすじがまだ無くても、コマンドは無応答にならない', async () => {
    const { env } = await envWithBotConnected([{ name: 'summary', reply: 'これまでのあらすじ: {summary}', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!summary'))

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'これまでのあらすじ: まだあらすじがありません' })
  })

  it('コマンドに一致しない発言では、D1に何も書かない（チャット全件を記録しないため）', async () => {
    const { env, db } = await envWithBotConnected([{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('こんばんは'))

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM replied_chat_messages').get()).toEqual({ count: 0 })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM command_uses').get()).toEqual({ count: 0 })
  })
})

describe('アラートのトリガーによるチャット送信', () => {
  const BOT_ID = '67890'

  /** botを接続済みで、アラートのトリガーが保存されている環境を作る */
  const envWithTriggers = async (triggers: StoredTrigger[]) => {
    const { env, db } = createEnv()
    await saveAlertConfig(env.STORE, { triggers })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  const fakeTwitchAcceptingSends = (
    chatResponse: Response = Response.json({ data: [{ message_id: 'sent', is_sent: true }] }),
    announcementResponse: Response = new Response(null, { status: 204 }),
    shoutoutResponse: Response = new Response(null, { status: 204 }),
  ) => {
    const sentChats: Request[] = []
    const sentAnnouncements: Request[] = []
    const sentShoutouts: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return chatResponse.clone()
      }
      if (request.url.startsWith('https://api.twitch.tv/helix/chat/announcements')) {
        sentAnnouncements.push(request.clone())
        return announcementResponse.clone()
      }
      if (request.url.startsWith('https://api.twitch.tv/helix/chat/shoutouts')) {
        sentShoutouts.push(request.clone())
        return shoutoutResponse.clone()
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, sentAnnouncements, sentShoutouts, fetchImpl }
  }

  const createFollowNotification = { subscription: { type: 'channel.follow' }, event: { user_id: '22222', user_name: '田中太郎', user_login: 'tanaka_taro' } }
  const followThanksTrigger: StoredTrigger = {
    kind: 'follow',
    actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }],
  }
  const followSoundTrigger: StoredTrigger = {
    kind: 'follow',
    actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
  }

  it('チャットに送る動作を持つトリガーに当てはまれば、botの名前で送る', async () => {
    const { env } = await envWithTriggers([followThanksTrigger])
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.sentChats[0]!.json()).toEqual({
      broadcaster_id: BROADCASTER_ID,
      sender_id: BOT_ID,
      message: '田中太郎 さん、フォローありがとうございます！',
    })
  })

  it('当てはまるトリガーが2件あれば、どちらも送る（一覧の下にある行が黙って動かないことがない）', async () => {
    const otherThanks: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'これからよろしくお願いします' }] }
    const { env } = await envWithTriggers([followThanksTrigger, otherThanks])
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    // 鍵に並びの位置を混ぜているので、同じ通知でも2通とも送信の枠を取れる
    expect(await Promise.all(twitch.sentChats.map(async (request) => ((await request.json()) as { message: string }).message))).toEqual([
      '田中太郎 さん、フォローありがとうございます！',
      'これからよろしくお願いします',
    ])
  })

  it('当てはまるトリガーが2件あっても、同じ通知が再送されたら二度送らない', async () => {
    const otherThanks: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'これからよろしくお願いします' }] }
    const { env } = await envWithTriggers([followThanksTrigger, otherThanks])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    const resent = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(resent.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(2)
  })

  it('文言に {summary} があれば、貯めてある配信中のあらすじを差し込んで送る', async () => {
    const summaryTrigger: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'chat', message: '{user} さん、いま「{summary}」って話をしてます' }],
    }
    const { env, db } = await envWithTriggers([summaryTrigger])
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    await saveStreamSummary(
      db,
      { sessionId: CHAT_STREAM.id, summary: '配信者は新しいゲームを遊んでいます', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' }, screenUntil: { at: '', imageId: '', lineNo: -1 } },
      NOW - 30 * 1000,
    )
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(await twitch.sentChats[0]!.json()).toMatchObject({
      message: '田中太郎 さん、いま「配信者は新しいゲームを遊んでいます」って話をしてます',
    })
  })

  it('あらすじがまだ無くても、文言は欠けずにその旨が入る', async () => {
    const summaryTrigger: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'chat', message: 'これまでのあらすじ: {summary}' }],
    }
    const { env } = await envWithTriggers([summaryTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'これまでのあらすじ: まだあらすじがありません' })
  })

  it('アラートを出すだけのトリガーでは、チャットへ何も送らない（オーバーレイが再生する）', async () => {
    const { env } = await envWithTriggers([followSoundTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('件数を数えるイベント（レイド）でも、記録とチャット送信の両方を行う', async () => {
    const raidThanksTrigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'chat', message: '{user} さん、{viewers}人でのレイドありがとう！' }] }
    const { env, db } = await envWithTriggers([raidThanksTrigger])
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'レイド元の配信者 さん、30人でのレイドありがとう！' })
    expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({ 'channel.raid': 1 })
  })

  it('フォローは件数を数えないが、購読していない種類として拒否もしない', async () => {
    const { env, db } = await envWithTriggers([])
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(response.status).toBe(204)
    expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({})
  })

  it('同じ通知が再送されても、二度送らない', async () => {
    const { env } = await envWithTriggers([followThanksTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    const resent = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(resent.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(1)
  })

  it('botを接続していなければ、送らずに受け取るだけにする', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [followThanksTrigger] })
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('送信に失敗しても2xxを返し、失敗として記録する（5xxだとTwitchが再送して二重投稿になるため）', async () => {
    const { env } = await envWithTriggers([followThanksTrigger])
    const twitch = fakeTwitchAcceptingSends(Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-chat-failed', message: expect.stringContaining('Missing scope') }])
  })

  it('イベントの中身が想定と違えば、黙って捨てずに400にする', async () => {
    const { env } = await envWithTriggers([followThanksTrigger])
    const twitch = fakeTwitchAcceptingSends()
    const followWithoutName = { subscription: { type: 'channel.follow' }, event: { user_login: 'tanaka' } }

    const response = await callWebhook(createNotification({ body: followWithoutName }), env, twitch.fetchImpl)

    expect(response.status).toBe(400)
    expect(twitch.sentChats).toHaveLength(0)
  })

  describe('シャウトアウトを送る動作', () => {
    const raidShoutoutTrigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'shoutout' }] }

    it('レイドのトリガーに当てはまれば、botがモデレーターとしてシャウトアウトを送る', async () => {
      const { env } = await envWithTriggers([raidShoutoutTrigger])
      const twitch = fakeTwitchAcceptingSends()

      const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      const url = new URL(twitch.sentShoutouts[0]!.url)
      expect(url.searchParams.get('from_broadcaster_id')).toBe(BROADCASTER_ID)
      // 紹介する相手はレイドしてきた配信者で、送るのはbot自身
      expect(url.searchParams.get('to_broadcaster_id')).toBe('レイド元の配信者のユーザーID')
      expect(url.searchParams.get('moderator_id')).toBe(BOT_ID)
    })

    it('同じ通知が再送されても、シャウトアウトを二度送らない', async () => {
      const { env } = await envWithTriggers([raidShoutoutTrigger])
      const twitch = fakeTwitchAcceptingSends()

      await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)
      await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

      expect(twitch.sentShoutouts).toHaveLength(1)
    })

    it('botを接続していなければ、送らずに受け取るだけにする', async () => {
      const { env } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [raidShoutoutTrigger] })
      const twitch = fakeTwitchAcceptingSends()

      const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(twitch.sentShoutouts).toHaveLength(0)
    })

    it('Twitchが間隔の制限（429）で拒んでも2xxを返し、失敗として記録する', async () => {
      const { env } = await envWithTriggers([raidShoutoutTrigger])
      const twitch = fakeTwitchAcceptingSends(
        undefined,
        undefined,
        Response.json({ status: 429, message: 'shoutout ratelimit exceeded' }, { status: 429 }),
      )

      const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(await listFailures(env.DB)).toMatchObject([
        { code: 'alert-shoutout-failed', message: expect.stringContaining('ratelimit') },
      ])
    })
  })

  describe('アナウンスを送る動作', () => {
    const followAnnounceTrigger: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'announce', message: '{user} さん、フォローありがとうございます！', color: 'purple' }],
    }

    it('アナウンスを送る動作を持つトリガーに当てはまれば、botがモデレーターとしてアナウンスを送る', async () => {
      const { env } = await envWithTriggers([followAnnounceTrigger])
      const twitch = fakeTwitchAcceptingSends()

      const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      const request = twitch.sentAnnouncements[0]!
      const url = new URL(request.url)
      expect(url.searchParams.get('broadcaster_id')).toBe(BROADCASTER_ID)
      // アナウンスを送るのはbot自身なので、moderator_id はbotのID
      expect(url.searchParams.get('moderator_id')).toBe(BOT_ID)
      expect(await request.json()).toEqual({ message: '田中太郎 さん、フォローありがとうございます！', color: 'purple' })
      // アナウンスは通常のチャット送信とは別の経路なので、両方に送らない
      expect(twitch.sentChats).toHaveLength(0)
    })

    it('チャットとアナウンスの両方を持つトリガーでは、どちらも送る', async () => {
      const both: StoredTrigger = {
        kind: 'follow',
        actions: [
          { type: 'chat', message: '{user} さん、ありがとうございます' },
          { type: 'announce', message: '{user} さんがフォローしました', color: 'primary' },
        ],
      }
      const { env } = await envWithTriggers([both])
      const twitch = fakeTwitchAcceptingSends()

      await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

      expect(twitch.sentChats).toHaveLength(1)
      expect(twitch.sentAnnouncements).toHaveLength(1)
    })

    it('同じ通知が再送されても、アナウンスを二度送らない', async () => {
      const { env } = await envWithTriggers([followAnnounceTrigger])
      const twitch = fakeTwitchAcceptingSends()

      await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
      await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

      expect(twitch.sentAnnouncements).toHaveLength(1)
    })

    it('botを接続していなければ、送らずに受け取るだけにする', async () => {
      const { env } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [followAnnounceTrigger] })
      const twitch = fakeTwitchAcceptingSends()

      const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(twitch.sentAnnouncements).toHaveLength(0)
    })

    it('2秒以内に続いた2件目のアナウンスは、間隔が空くまで待ってから送る（アナウンスは2秒に1回しか送れない）', async () => {
      const { env } = await envWithTriggers([followAnnounceTrigger])
      const twitch = fakeTwitchAcceptingSends()
      const waitedMilliseconds: number[] = []
      const recordWait = async (milliseconds: number): Promise<void> => {
        waitedMilliseconds.push(milliseconds)
      }

      await callWebhook(createNotification({ body: createFollowNotification, messageId: 'message-1' }), env, twitch.fetchImpl, recordWait)
      await callWebhook(createNotification({ body: createFollowNotification, messageId: 'message-2' }), env, twitch.fetchImpl, recordWait)

      // 1件目は待たずに送り、2件目は2秒待ってから送るので、どちらも失われない
      expect(twitch.sentAnnouncements).toHaveLength(2)
      expect(waitedMilliseconds).toEqual([2000])
      expect(await listFailures(env.DB)).toEqual([])
    })

    it('待ち時間の上限を超えるほど詰まっていれば、送らずに失敗として記録する', async () => {
      const { env } = await envWithTriggers([followAnnounceTrigger])
      const twitch = fakeTwitchAcceptingSends()

      // 同じ時刻に4件続くと、4件目の送信時刻は6秒後になり、上限（4秒）を超える
      for (const messageId of ['message-1', 'message-2', 'message-3', 'message-4']) {
        const response = await callWebhook(createNotification({ body: createFollowNotification, messageId }), env, twitch.fetchImpl)
        expect(response.status).toBe(204)
      }

      expect(twitch.sentAnnouncements).toHaveLength(3)
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-announce-failed', message: expect.stringContaining('2秒に1回') }])
    })

    it('送信に失敗しても2xxを返し、失敗として記録する（botがモデレーターでない場合など）', async () => {
      const { env } = await envWithTriggers([followAnnounceTrigger])
      const twitch = fakeTwitchAcceptingSends(undefined, Response.json({ status: 401, message: 'Missing scope' }, { status: 401 }))

      const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)

      expect(response.status).toBe(204)
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-announce-failed', message: expect.stringContaining('Missing scope') }])
    })
  })
})

describe('チャットの発言によるアラートのトリガー', () => {
  const BOT_ID = '67890'

  /** botを接続済みで、チャットの発言のトリガーが保存されている環境を作る */
  const envWithChatTriggers = async (triggers: StoredTrigger[], commands: { name: string; reply: string; cooldownSeconds: number }[] = []) => {
    const { env, db } = createEnv()
    await saveAlertConfig(env.STORE, { triggers })
    if (commands.length > 0) await saveBotConfig(env.STORE, { commands })
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat', 'moderator:manage:chat_messages'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  const createMessageNotification = (text: string, { chatterUserId = '11111', messageId = 'chat-message-1' } = {}) => ({
    body: {
      subscription: { type: 'channel.chat.message' },
      event: {
        broadcaster_user_id: BROADCASTER_ID,
        chatter_user_id: chatterUserId,
        chatter_user_login: 'shichousha',
        chatter_user_name: '視聴者さん',
        message_id: messageId,
        message: { text, fragments: [{ type: 'text', text }] },
        badges: [],
      },
    },
    messageId,
  })

  /** チャット送信とモデレーション操作に応えるTwitchの代役 */
  const fakeTwitchAcceptingSends = () => {
    const sentChats: Request[] = []
    const calledUrls: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/helix/chat/messages') {
        sentChats.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      if (url.pathname === '/helix/moderation/chat' || url.pathname === '/helix/moderation/bans') {
        calledUrls.push(`${request.method} ${url.pathname}`)
        return new Response(null, { status: 204 })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, calledUrls, fetchImpl }
  }

  const greetingTrigger: StoredTrigger = {
    kind: 'keyword', contains: 'おはよう',
    actions: [{ type: 'chat', message: '{user} さん、おはようございます！' }],
  }

  it('文面の条件に当てはまる発言に、botの名前で送る', async () => {
    const { env } = await envWithChatTriggers([greetingTrigger])
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification(createMessageNotification('みなさんおはようございます')), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(await twitch.sentChats[0]!.json()).toEqual({
      broadcaster_id: BROADCASTER_ID,
      sender_id: BOT_ID,
      message: '視聴者さん さん、おはようございます！',
    })
  })

  it('文面の条件に当てはまらない発言には、何も送らない', async () => {
    const { env } = await envWithChatTriggers([greetingTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('bot自身の発言では決してトリガーを引かない（応答し続けて止まらなくなるため）', async () => {
    const { env } = await envWithChatTriggers([greetingTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('おはようございます', { chatterUserId: BOT_ID })), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('自動モデレーションで処分した発言では、トリガーを引かない', async () => {
    const { env } = await envWithChatTriggers([greetingTrigger])
    await saveModerationConfig(env.STORE, {
      enabled: true,
      exemptBroadcaster: true,
      exemptVip: true,
      exemptSubscriber: true,
      rules: [{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }],
    })
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('おはよう、宣伝です')), env, twitch.fetchImpl)

    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat'])
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度送らない', async () => {
    const { env } = await envWithChatTriggers([greetingTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('おはよう')), env, twitch.fetchImpl)
    await callWebhook(createNotification(createMessageNotification('おはよう')), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(1)
  })

  it('コマンドにもトリガーにも当てはまる発言では、どちらも送る（鍵を取り合わない）', async () => {
    const trigger: StoredTrigger = {
      kind: 'keyword', contains: '!ping',
      actions: [{ type: 'chat', message: '{user} さんが ping しました' }],
    }
    const { env } = await envWithChatTriggers([trigger], [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('!ping')), env, twitch.fetchImpl)

    const sentText = await Promise.all(twitch.sentChats.map(async (request) => ((await request.json()) as { message: string }).message))
    expect(sentText).toEqual(['視聴者さん さんが ping しました', '@shichousha pong'])
  })

  it('アラートを出すだけのトリガーでは、チャットへ何も送らない（オーバーレイが再生する）', async () => {
    const soundTrigger: StoredTrigger = {
      kind: 'fromUser', login: 'shichousha',
      actions: [{ type: 'alert', mediaId: '素材ID-拍手の音', mediaKind: 'audio', durationSeconds: 5, volume: 0.5, message: '' }],
    }
    const { env, db } = await envWithChatTriggers([soundTrigger])
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification(createMessageNotification('こんばんは')), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
    // チャットは件数の桁が違うため、トリガーを引いても配信の記録には書かない
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_events').get()).toEqual({ count: 0 })
  })

  /** このチャンネルで初めての発言に応えるトリガー */
  const firstTimeTrigger: StoredTrigger = {
    kind: 'newViewer',
    actions: [{ type: 'chat', message: '{user} さん、はじめまして！' }],
  }

  /** すでに視聴者の記録がある人を作る。日数は現在時刻から何日前に発言していたか */
  const recordPastMessage = async (db: ReturnType<typeof createFakeDatabase>, daysAgo: number) => {
    await recordViewerMessage(
      db,
      { userId: '11111', login: 'shichousha', displayName: '視聴者さん', badges: [], messageId: 'chat-message-0' },
      NOW - daysAgo * 24 * 60 * 60 * 1000,
    )
  }

  it('記録のない人の発言では、このチャンネルで初めての発言の条件に当てはまる', async () => {
    const { env } = await envWithChatTriggers([firstTimeTrigger])
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('はじめまして')), env, twitch.fetchImpl)

    expect(await twitch.sentChats[0]?.json()).toMatchObject({ message: '視聴者さん さん、はじめまして！' })
  })

  it('すでに記録のある人の発言では、このチャンネルで初めての発言の条件に当てはまらない', async () => {
    const { env, db } = await envWithChatTriggers([firstTimeTrigger])
    await recordPastMessage(db, 3)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('最後の発言から指定した日数以上空いていれば、空いた日数の条件に当てはまる', async () => {
    const returningTrigger: StoredTrigger = {
      kind: 'comeback', days: 30,
      actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }],
    }
    const { env, db } = await envWithChatTriggers([returningTrigger])
    await recordPastMessage(db, 40)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('おひさしぶりです')), env, twitch.fetchImpl)

    expect(await twitch.sentChats[0]?.json()).toMatchObject({ message: '視聴者さん さん、お久しぶりです！' })
  })

  it('最後の発言から日数が足りなければ、空いた日数の条件に当てはまらない', async () => {
    const returningTrigger: StoredTrigger = {
      kind: 'comeback', days: 30,
      actions: [{ type: 'chat', message: '{user} さん、お久しぶりです！' }],
    }
    const { env, db } = await envWithChatTriggers([returningTrigger])
    await recordPastMessage(db, 3)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification(createMessageNotification('こんばんは')), env, twitch.fetchImpl)

    expect(twitch.sentChats).toHaveLength(0)
  })

  it('botを接続していなければ、トリガーを引かずに受け取るだけにする', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [greetingTrigger] })

    const response = await callWebhook(createNotification(createMessageNotification('おはよう')), env)

    expect(response.status).toBe(204)
  })
})

describe('チャットの自動モデレーション', () => {
  const BOT_ID = '67890'
  const TROLL_ID = '11111'

  /** botが接続済みで、自動モデレーションの設定が保存されている環境を作る */
  const moderationEnv = async (config: ModerationConfig) => {
    const { env, db } = createEnv()
    await saveModerationConfig(env.STORE, config)
    await saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'moderator:manage:banned_users', 'moderator:manage:chat_messages'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return { env, db }
  }

  /** 有効で、除外をすべて有効にした設定。ルールだけを追加して使う */
  const createConfig = (rules: ModerationRule[], overrides: Partial<ModerationConfig> = {}): ModerationConfig => ({
    enabled: true,
    exemptBroadcaster: true,
    exemptVip: true,
    exemptSubscriber: true,
    rules,
    ...overrides,
  })

  const createChatNotification = (
    text: string,
    { messageId = 'chat-message-1', badges = [] as { set_id: string }[], chatterUserId = TROLL_ID } = {},
  ) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'arashi',
      chatter_user_name: '荒らしさん',
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
      badges,
    },
  })

  /** モデレーション操作とチャット送信に応えるTwitch。どのURLを呼んだかを記録する */
  const fakeTwitchForModeration = (moderationResponse?: Response) => {
    const calledUrls: string[] = []
    const sentChats: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/helix/moderation/chat' || url.pathname === '/helix/moderation/bans') {
        calledUrls.push(`${request.method} ${url.pathname}`)
        return moderationResponse ? moderationResponse.clone() : new Response(null, { status: 204 })
      }
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { calledUrls, sentChats, fetchImpl }
  }

  const sendNotification = (env: Env, fetchImpl: typeof fetch, body: unknown, messageId = 'chat-message-1') =>
    callWebhook(createNotification({ body, messageId }), env, fetchImpl)

  it('既定（無効）では、禁止語を含む発言でも処分しない', async () => {
    const { env, db } = await moderationEnv({ ...createConfig([{ kind: 'word', word: '宣伝', punishment: { type: 'ban' } }]), enabled: false })
    const twitch = fakeTwitchForModeration()

    const response = await sendNotification(env, twitch.fetchImpl, createChatNotification('宣伝です'))

    expect(response.status).toBe(204)
    expect(twitch.calledUrls).toEqual([])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_recent_messages').get()).toEqual({ count: 0 })
  })

  it('禁止語を含む発言を削除する', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('宣伝です'))

    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat'])
  })

  it('BANの処分では、発言を削除してからBANする', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'url', punishment: { type: 'ban' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('https://example.com/spam'))

    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat', 'POST /helix/moderation/bans'])
  })

  it('モデレーターのバッジが付いた発言は処分しない', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'word', word: '宣伝', punishment: { type: 'ban' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('宣伝です', { badges: [{ set_id: 'moderator' }] }))

    expect(twitch.calledUrls).toEqual([])
  })

  it('bot自身の発言は処分しない（自分の応答を処分して止まらなくなるのを防ぐ）', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('Discordはこちらです https://example.com/discord', { chatterUserId: BOT_ID }))

    expect(twitch.calledUrls).toEqual([])
  })

  it('処分した発言には、コマンドの応答をしない', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'url', punishment: { type: 'delete' } }]))
    await saveBotConfig(env.STORE, { commands: [{ name: 'ping', reply: '@{user} pong', cooldownSeconds: 0 }] })
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!ping https://example.com/spam'))

    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat'])
    expect(twitch.sentChats).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度処分しない', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('https://example.com/spam'))
    const resent = await sendNotification(env, twitch.fetchImpl, createChatNotification('https://example.com/spam'))

    expect(resent.status).toBe(204)
    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat'])
  })

  it('同じ文面の連投が回数に達したら処分する', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'timeout', durationSeconds: 600 } }]))
    const twitch = fakeTwitchForModeration()

    // 同じ文面を3回。3回目で連投とみなす
    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-1' }), 'chat-message-1')
    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')
    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-3' }), 'chat-message-3')

    expect(twitch.calledUrls).toEqual(['DELETE /helix/moderation/chat', 'POST /helix/moderation/bans'])
  })

  it('同じ通知が再送されても、連投とみなさない（1回の発言が2件に数えられないため）', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-1' }), 'chat-message-1')
    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')
    // Twitchが2通目を再送してきた。実際の発言は2回なので、3回目の連投にはならない
    await sendNotification(env, twitch.fetchImpl, createChatNotification('かいます', { messageId: 'chat-message-2' }), 'chat-message-2')

    expect(twitch.calledUrls).toEqual([])
  })

  it('連投のルールが無ければ、直近の発言をD1に記録しない（チャット全件を書かないため）', async () => {
    const { env, db } = await moderationEnv(createConfig([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('こんばんは'))

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM chat_recent_messages').get()).toEqual({ count: 0 })
  })

  it('処分に失敗しても204を返し、収集の失敗として記録する（2xx以外だと再送されて二重に処分される）', async () => {
    const { env } = await moderationEnv(createConfig([{ kind: 'url', punishment: { type: 'delete' } }]))
    const twitch = fakeTwitchForModeration(Response.json({ message: 'User is not a moderator' }, { status: 401 }))

    const response = await sendNotification(env, twitch.fetchImpl, createChatNotification('https://example.com/spam'))

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'moderation-failed', message: expect.stringContaining('401') }])
  })
})

describe('オーバーレイへのアラートの押し出し', () => {
  const BOT_ID = '67890'

  const alertTrigger = (kind: 'follow' | 'everyMessage'): StoredTrigger => ({
    kind,
    actions: [{ type: 'alert', mediaId: 'media-kanpai', mediaKind: 'video', durationSeconds: 5, volume: 0.5, message: '{user} さん、ありがとう！' }],
  })

  const createFollowNotification = { subscription: { type: 'channel.follow' }, event: { user_id: '22222', user_name: '田中太郎', user_login: 'tanaka_taro' } }

  const createMessageNotification = (chatterUserId = '11111', messageId = 'chat-message-1') => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: messageId,
      message: { text: 'おはようございます', fragments: [{ type: 'text', text: 'おはようございます' }] },
      badges: [],
    },
  })

  const connectBot = (env: Env) =>
    saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })

  it('当てはまるトリガーのアラートを、素材のURLにオーバーレイ用キーを付けて押し出す', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('follow')] })

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedAlerts).toEqual([
      {
        media: { kind: 'video', url: `/api/media/media-kanpai?key=${ISSUED_OVERLAY_KEY}` },
        durationSeconds: 5,
        volume: 0.5,
        text: '田中太郎 さん、ありがとう！',
      },
    ])
  })

  it('当てはまるトリガーが2件あれば、どちらのアラートも押し出す（オーバーレイが順に再生する）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, {
      triggers: [
        { kind: 'follow', actions: [{ type: 'alert', mediaId: 'media-kanpai', mediaKind: 'video', durationSeconds: 5, volume: 0.5, message: '1つ目' }] },
        { kind: 'follow', actions: [{ type: 'alert', mediaId: 'media-kanpai', mediaKind: 'video', durationSeconds: 5, volume: 0.5, message: '2つ目' }] },
      ],
    })

    await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(alertChannel.pushedAlerts.map((alert) => alert.text)).toEqual(['1つ目', '2つ目'])
  })

  it('アラートの文言の {summary} に、貯めてある配信中のあらすじを差し込んで押し出す（OBSの画面に出す）', async () => {
    const { env, db, alertChannel } = createEnv()
    const summaryAction: StoredTrigger = {
      kind: 'follow',
      actions: [{ type: 'alert', mediaId: 'media-kanpai', mediaKind: 'video', durationSeconds: 5, volume: 0.5, message: 'これまでのあらすじ: {summary}' }],
    }
    await saveAlertConfig(env.STORE, { triggers: [summaryAction] })
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    await saveStreamSummary(
      db,
      { sessionId: CHAT_STREAM.id, summary: '配信者は新しいゲームを遊んでいます', transcriptsUntil: { at: '', messageId: '' }, chatUntil: { at: '', messageId: '' }, screenUntil: { at: '', imageId: '', lineNo: -1 } },
      NOW - 30 * 1000,
    )

    await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(alertChannel.pushedAlerts[0]?.text).toBe('これまでのあらすじ: 配信者は新しいゲームを遊んでいます')
  })

  it('当てはまるトリガーがなければ、何も押し出さない', async () => {
    const { env, alertChannel } = createEnv()

    await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(alertChannel.pushedAlerts).toHaveLength(0)
  })

  it('botが未接続でも、チャットの発言でアラートを押し出す（アラートの再生にbotは要らない）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('everyMessage')] })

    const response = await callWebhook(createNotification({ body: createMessageNotification() }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedAlerts).toMatchObject([{ text: '視聴者さん さん、ありがとう！' }])
  })

  it('bot自身の発言ではアラートを押し出さない（自分の応答に反応して止まらなくなるため）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('everyMessage')] })
    await connectBot(env)

    await callWebhook(createNotification({ body: createMessageNotification(BOT_ID) }), env)

    expect(alertChannel.pushedAlerts).toHaveLength(0)
  })

  it('同じ通知が再送されても、二度は押し出さない', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('follow')] })

    await callWebhook(createNotification({ body: createFollowNotification }), env)
    await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(alertChannel.pushedAlerts).toHaveLength(1)
  })

  it('配送先が失敗しても、Twitchへは2xxを返して失敗として記録する（再送で二重に鳴らさないため）', async () => {
    const { env } = createEnv({ channelShouldFail: true })
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('follow')] })

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-push-failed' }])
  })

  it('オーバーレイ用キーが未発行なら押し出さず、失敗として記録する（素材のURLを作れないため）', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [alertTrigger('follow')] })

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedAlerts).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-push-failed' }])
  })
})

describe('LLMに文面を作らせる動作（aiChat）', () => {
  const BOT_ID = '67890'
  const createFollowNotification = { subscription: { type: 'channel.follow' }, event: { user_id: '22222', user_name: '田中太郎', user_login: 'tanaka_taro' } }

  /** まだ記録のない人からのチャットの発言 */
  const firstTimerMessage = {
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: '22222',
      chatter_user_login: 'hatsumi',
      chatter_user_name: 'はつみ',
      message_id: 'chat-message-hatsumi',
      message: { text: 'はじめまして！', fragments: [{ type: 'text', text: 'はじめまして！' }] },
    },
  }

  const generatedTextTrigger: StoredTrigger = {
    kind: 'follow',
    actions: [{ type: 'aiChat', instruction: 'フォローしてくれた人にお礼を言ってください' }],
  }

  const connectBot = (env: Env) =>
    saveToken(env.STORE, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })

  /** チャット送信に応える Twitch の代役 */
  const fakeTwitchAcceptingSends = (chatResponse: Response = Response.json({ data: [{ message_id: 'sent', is_sent: true }] })) => {
    const sentChats: Request[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
        sentChats.push(request.clone())
        return chatResponse.clone()
      }
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { sentChats, fetchImpl }
  }

  it('当てはまったトリガーの指示でLLMに文面を作らせ、botの名前で送る', async () => {
    const { env } = createEnv({ llmText: '太郎さん、フォローありがとうございます！' })
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(response.status).toBe(204)
    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: '太郎さん、フォローありがとうございます！' })
  })

  it('LLMの応答を待たずにTwitchへ2xxを返す（応答が遅れると再送されるため）', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()
    // 文面ができあがるまで終わらないLLM。テストが合図するまで応答を返さない
    let returnText: (message: string) => void = () => {}
    // 呼ばれるのを待ってから合図する（設定（llm-settings）の読み出しを挟むので、Twitchへの応答より後に呼ばれることがある）
    let notifyCalled: () => void = () => {}
    const untilLlmCalled = new Promise<void>((resolve) => (notifyCalled = resolve))
    const slowAi = {
      run: () =>
        new Promise<unknown>((resolve) => {
          returnText = (message) => resolve({ response: message })
          notifyCalled()
        }),
    }

    const response = await callWebhook(createNotification({ body: createFollowNotification }), { ...env, AI: slowAi }, twitch.fetchImpl)

    // LLMがまだ文面を返していないのに、Twitchへの応答は返っている
    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)

    await untilLlmCalled
    returnText('太郎さん、ありがとう！')
    await flushDeferredTasks()
    expect(twitch.sentChats).toHaveLength(1)
  })

  it('発言した人の記録（メモ・発言数）を材料としてLLMへ渡す', async () => {
    const { env, ai } = createEnv()
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'aiChat', instruction: '一言返してください' }] }],
    })
    await connectBot(env)
    await recordViewerMessage(env.DB, { userId: '11111', login: 'shichousha', displayName: '視聴者さん', badges: [], messageId: '古い発言' }, NOW - 60 * 60 * 1000)
    await updateViewerNote(env.DB, '11111', 'ギターの話が好き')
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(
      createNotification({
        body: {
          subscription: { type: 'channel.chat.message' },
          event: {
            broadcaster_user_id: BROADCASTER_ID,
            chatter_user_id: '11111',
            chatter_user_login: 'shichousha',
            chatter_user_name: '視聴者さん',
            message_id: 'chat-message-1',
            message: { text: 'こんばんは', fragments: [{ type: 'text', text: 'こんばんは' }] },
          },
        },
      }),
      env,
      twitch.fetchImpl,
    )
    await flushDeferredTasks()

    expect(JSON.stringify(ai.calls[0]?.input)).toContain('ギターの話が好き')
  })

  it('条件を持たないトリガーでも、来訪の別（初めて・お久しぶり）を材料に渡す', async () => {
    const { env, ai } = createEnv()
    // 条件は1件もない。それでも文面づくりには来訪の別が要るので、Workerは視聴者の記録を読む
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'aiChat', instruction: '一言返してください' }] }],
    })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: firstTimerMessage }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(JSON.stringify(ai.calls[0]?.input)).toContain('このチャンネルで初めての発言')
  })

  it('いま進んでいる配信のあらすじを材料に渡す（トリガーの文言に書かれていなくても読む）', async () => {
    const { env, db, ai } = createEnv()
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'everyMessage', actions: [{ type: 'aiChat', instruction: '話の流れに合わせて一言返してください' }] }],
    })
    await connectBot(env)
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    await saveStreamSummary(
      db,
      {
        sessionId: CHAT_STREAM.id,
        summary: '配信者はギターの弦を張り替えています',
        transcriptsUntil: { at: '', messageId: '' },
        chatUntil: { at: '', messageId: '' },
        screenUntil: { at: '', imageId: '', lineNo: -1 },
      },
      NOW - 30 * 1000,
    )
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: firstTimerMessage }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(JSON.stringify(ai.calls[0]?.input)).toContain('配信者はギターの弦を張り替えています')
  })

  it('鍵の確保そのものが失敗しても、取りこぼさずに記録する（2xxを返したあとなので再送では取り返せない）', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()
    // 鍵を持つテーブルを落として、reserveChatReply（送信の前に呼ぶ）を失敗させる
    env.DB.sqlite.prepare('DROP TABLE replied_chat_messages').run()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed' }])
  })

  it('LLMが失敗したら（無料枠切れなど）送らず、2xxを返したうえで記録する', async () => {
    const { env } = createEnv({ llmShouldFail: true })
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed' }])
  })

  it('500文字を超えた文面は、切り詰めずに送るのをやめて記録する', async () => {
    const { env } = createEnv({ llmText: 'あ'.repeat(501) })
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(twitch.sentChats).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed', message: expect.stringContaining('500文字') }])
  })

  it('同じ通知が再送されても、2通は送らない', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
    await connectBot(env)
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()
    await callWebhook(createNotification({ body: createFollowNotification }), env, twitch.fetchImpl)
    await flushDeferredTasks()

    expect(twitch.sentChats).toHaveLength(1)
  })

  it('botを接続していなければ、LLMも呼ばずに何もしない（送る先がないため）', async () => {
    const { env, ai } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })

    const response = await callWebhook(createNotification({ body: createFollowNotification }), env)
    await flushDeferredTasks()

    expect(response.status).toBe(204)
    expect(ai.calls).toHaveLength(0)
  })
})

describe('コメントビューアーへの配送', () => {
  /** 本文の断片まで揃った、視聴者の発言の通知 */
  const viewerMessage = {
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: '11111',
      chatter_user_login: 'shichousha',
      chatter_user_name: '視聴者さん',
      message_id: 'chat-message-1',
      message: { text: 'こんばんは', fragments: [{ type: 'text', text: 'こんばんは' }] },
      color: '#1E90FF',
      badges: [],
      cheer: null,
      reply: null,
    },
  }

  it('チャットの発言を、コメントビューアーへ1件として押し出す', async () => {
    const { env, commentChannel } = createEnv()

    const response = await callWebhook(createNotification({ messageId: 'eventsub-1', body: viewerMessage }), env)

    expect(response.status).toBe(204)
    expect(commentChannel.pushedItems).toMatchObject([
      { kind: 'chat', id: 'eventsub-1', messageId: 'chat-message-1', user: { name: '視聴者さん' }, fragments: [{ text: 'こんばんは', emoteId: null }] },
    ])
  })

  it('別のチャンネルのチャットは押し出さない（古い購読が残っていても、他人のチャットを並べないため）', async () => {
    const { env, commentChannel } = createEnv()
    const otherChannel = { ...viewerMessage, event: { ...viewerMessage.event, broadcaster_user_id: '別の配信者のID' } }

    await callWebhook(createNotification({ body: otherChannel }), env)

    expect(commentChannel.pushedItems).toEqual([])
  })

  it('チャットのお知らせ（サブスクなど）は押し出すだけで、配信の記録にもトリガーにもかけない', async () => {
    const { env, db, commentChannel } = createEnv()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const subscribeNotice = {
      subscription: { type: 'channel.chat.notification' },
      event: {
        broadcaster_user_id: BROADCASTER_ID,
        chatter_user_id: '11111',
        chatter_user_login: 'shichousha',
        chatter_user_name: '視聴者さん',
        chatter_is_anonymous: false,
        color: '',
        badges: [],
        system_message: 'shichousha subscribed at Tier 1.',
        message_id: 'notice-1',
        message: { text: '', fragments: [] },
        notice_type: 'sub',
        sub: { sub_tier: '1000', is_prime: false, duration_months: 1 },
      },
    }

    const response = await callWebhook(createNotification({ body: subscribeNotice }), env)

    expect(response.status).toBe(204)
    expect(commentChannel.pushedItems).toMatchObject([{ kind: 'notice', notice: { type: 'sub', tier: '1000' } }])
    // サブスクは channel.subscribe でも届いて数えられるので、お知らせのほうでは数えない
    expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({})
  })

  it.each([
    ['channel.chat.message_delete', { broadcaster_user_id: BROADCASTER_ID, target_user_id: '11111', target_user_login: 'shichousha', target_user_name: '視聴者さん', message_id: 'chat-message-1' }, 'delete'],
    ['channel.chat.clear_user_messages', { broadcaster_user_id: BROADCASTER_ID, target_user_id: '11111', target_user_login: 'shichousha', target_user_name: '視聴者さん' }, 'clearUser'],
    ['channel.chat.clear', { broadcaster_user_id: BROADCASTER_ID }, 'clear'],
  ])('モデレーターの操作（%s）を押し出す', async (type, event, kind) => {
    const { env, commentChannel } = createEnv()

    const response = await callWebhook(createNotification({ body: { subscription: { type }, event } }), env)

    expect(response.status).toBe(204)
    expect(commentChannel.pushedItems).toMatchObject([{ kind }])
  })

  it('フォローは押し出したうえで、これまでどおりトリガーにもかける', async () => {
    const { env, commentChannel } = createEnv()
    const follow = { subscription: { type: 'channel.follow' }, event: { broadcaster_user_id: BROADCASTER_ID, user_id: '22222', user_login: 'tanaka_taro', user_name: '田中太郎' } }

    const response = await callWebhook(createNotification({ body: follow }), env)

    expect(response.status).toBe(204)
    expect(commentChannel.pushedItems).toMatchObject([{ kind: 'follow', user: { name: '田中太郎' } }])
  })

  it('配送に失敗しても2xxを返し、失敗として記録する（コメントビューアーのためにトリガーや応答を止めない）', async () => {
    const { env, db } = createEnv({ commentChannelShouldFail: true })

    const response = await callWebhook(createNotification({ body: viewerMessage }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(db)).toMatchObject([{ code: 'comment-feed-failed' }])
  })

  it('中身が足りずに1件へ直せなくても2xxを返し、失敗として記録する', async () => {
    const { env, db, commentChannel } = createEnv()
    const messageWithoutFragments = { ...viewerMessage, event: { ...viewerMessage.event, message: { text: 'こんばんは' } } }

    const response = await callWebhook(createNotification({ body: messageWithoutFragments }), env)

    expect(response.status).toBe(204)
    expect(commentChannel.pushedItems).toEqual([])
    expect(await listFailures(db)).toMatchObject([{ code: 'comment-feed-failed', message: expect.stringContaining('fragments') }])
  })
})
