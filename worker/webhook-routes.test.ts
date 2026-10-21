/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）のテスト
 *
 * Twitchの代わりに署名付きのリクエストを作り、handleRequest を通して確かめる。特に重要なのは次の3点。
 * - 署名が正しくない・古い通知を受け付けないこと
 * - 購読の確認（challenge）にそのまま応答すること
 * - 同じ通知が再送されても二重に数えないこと
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createFakeBucket } from './fake-bucket'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { handleRequest, type Env } from './index'
import { getSession, listFailures, listSessions, recordLiveStream, recordStreamOnline } from './stats-store'
import { saveBotConfig } from './bot-config'
import { saveStreamSummary } from './stream-summary-store'
import { declareTask } from './task-desk-store'
import { openTheme } from './opinion-store'
import { saveModerationConfig } from './moderation-config'
import type { ModerationConfig, ModerationRule } from './chat-moderation'
import { saveAlertConfig, type StoredTrigger } from './alert-config'
import { AI_CHAT_DAILY_LIMIT } from './ai-chat'
import { saveToken } from './token'
import { listViewers, recordViewerMessage, updateViewerNote } from './viewer-store'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { DEFAULT_TOWN_TOUR_SOUND, saveTownTourSound } from './town-tour-sound'
import { saveTwisterSound } from './twister-sound'
import { saveLickSound } from './lick-sound'
import { saveVrmModel } from './vrm-model'
import { DEFAULT_KANJI_QUIZ_SOUND, saveKanjiQuizSound } from './kanji-quiz-sound'
import { openTownTourQuiz } from './town-tour-quiz'
import { openKanjiQuiz, recordKanjiQuiz } from './kanji-quiz-store'
import { singleGradeWeights } from '../src/kanji-quiz/grade'
import { KANJI_QUIZ_PROBLEMS } from './kanji-quiz-call'
import { GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
import { saveTownTourNarration } from './town-tour-narration'
import { recordTownTourVisit } from './town-tour-visits'
import towns from '../src/town-tour/towns.json'
import { CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import { endGame, readCurrentGame, readGameStartReward, startGame } from './chat-deduction-store'
import { saveDollPrize } from './doll-prize'
import { insertDollSet, readDollHoldings, selectCurrentDollSet } from './doll-store'

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
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: SECRET,
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: commentChannel.namespace,
    AD_BREAKS: adBreakTimer.namespace,
    TOKENS: createFakeTokenVault().namespace,
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
    to_broadcaster_user_name: 'たねのぶ',
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
    await saveToken(env.TOKENS, 'bot', {
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
  it.each([
    { type: 'channel.subscribe', event: {} },
    { type: 'channel.subscription.message', event: {} },
    { type: 'channel.channel_points_custom_reward_redemption.add', event: {} },
    { type: 'channel.raid', event: RAID_NOTIFICATION.event },
  ])(
    '$type を、配信中のセッションに結び付けて1件記録する',
    async ({ type, event }) => {
      const { env, db } = createEnv()
      await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
      const response = await callWebhook(createNotification({ body: { subscription: { type }, event } }), env)

      expect(response.status).toBe(204)
      expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({ [type]: 1 })
    },
  )

  it('レイドは、レイド元のユーザーID・ログイン名・表示名と人数も残す', async () => {
    const { env, db } = createEnv()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect((await getSession(db, CHAT_STREAM.id, NOW))?.raids).toMatchObject([
      { fromUserId: 'レイド元の配信者のユーザーID', fromUserLogin: 'raid_moto', fromUserName: 'レイド元の配信者', viewers: 30 },
    ])
  })

  it('レイド元か人数が欠けたレイドの通知は400にし、何も記録しない（黙って時刻だけを残さない）', async () => {
    const { env, db } = createEnv()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const response = await callWebhook(
      createNotification({ body: { ...RAID_NOTIFICATION, event: { ...RAID_NOTIFICATION.event, viewers: '30人' } } }),
      env,
    )

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-webhook')
    expect((await listSessions(db, NOW))[0]?.eventCounts).toEqual({})
  })

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
    expect(await getSession(db, '40000000001', NOW)).toMatchObject({ startedAt: '2026-09-21T12:00:00.000Z', endedAt: null })

    const response = await callWebhook(
      createNotification({ messageId: 'message-2', timestamp: '2026-09-21T12:29:55.5Z', body: { subscription: { type: 'stream.offline' }, event: {} } }),
      env,
    )
    expect(response.status).toBe(204)
    expect((await getSession(db, '40000000001', NOW))?.endedAt).toBe('2026-09-21T12:29:55.500Z')
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
    await saveToken(env.TOKENS, 'bot', {
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

  it('Shared Chat の相手チャンネルで書かれた発言には、記録・材料・応答のどれも行わない（issue #205）', async () => {
    const { env, db } = await envWithBotConnected()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const twitch = fakeTwitchAcceptingSends()
    // 自チャンネルの購読に届くが、書かれたのは相手チャンネル（source_broadcaster_user_id）
    const sharedChatNotification = createChatNotification('!ping')
    const body = { ...sharedChatNotification, event: { ...sharedChatNotification.event, source_broadcaster_user_id: '相手チャンネルのID' } }

    const response = await callWebhook(createNotification({ body }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.sentChats).toHaveLength(0)
    expect(await listViewers(env.DB, {})).toEqual([])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
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
    await saveToken(env.TOKENS, 'bot', {
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

  it('{worktime} を含むコマンドには、いまの配信でみんなが作業した時間の合計を差し込んで応答する', async () => {
    const { env, db } = await envWithBotConnected([{ name: 'worktime', reply: 'みんなの作業時間: {worktime}', cooldownSeconds: 0 }])
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    // 配信が 12:00 に始まり、たなかが 12:10 に宣言していまも作業中（いまは 12:30）
    await declareTask(db, { userId: '11111', name: 'たなか', task: '英単語を50個覚える', messageId: 'task-message-1' }, Date.parse('2026-09-21T12:10:00Z'))
    const twitch = fakeTwitchAcceptingSends()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('!worktime'))

    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: 'みんなの作業時間: 20分（1人）' })
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
    await saveToken(env.TOKENS, 'bot', {
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
    await saveToken(env.TOKENS, 'bot', {
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
    await saveToken(env.TOKENS, 'bot', {
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

  it('自動モデレーションで処分した発言は、LLMの材料（stream_chat_messages）に貯めない（issue #202）', async () => {
    const { env, db } = await moderationEnv(createConfig([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }]))
    await recordLiveStream(db, CHAT_STREAM, NOW - 60 * 1000)
    const twitch = fakeTwitchForModeration()

    await sendNotification(env, twitch.fetchImpl, createChatNotification('宣伝です'))
    await sendNotification(env, twitch.fetchImpl, createChatNotification('こんばんは', { messageId: 'chat-message-2' }), 'notification-2')

    expect(db.sqlite.prepare('SELECT text FROM stream_chat_messages').all()).toEqual([{ text: 'こんばんは' }])
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
    saveToken(env.TOKENS, 'bot', {
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

describe('ツイスターで対戦する動作（twister）', () => {
  const raidTwisterTrigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'twister' }] }
  /** レイド元と配信者のアイコンを返す Twitch の代役。引かれたユーザーIDを控える */
  const fakeTwitchReturningIcons = () => {
    const requestedIds: string[][] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
      const url = new URL(request.url)
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users') {
        requestedIds.push(url.searchParams.getAll('id'))
        return Response.json({
          data: [
            { id: 'レイド元の配信者のユーザーID', login: 'raid_moto', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/raid_moto.png' },
            { id: BROADCASTER_ID, login: 'tanenobu', profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png' },
          ],
        })
      }
      return new Response(null, { status: 404 })
    }
    return { requestedIds, fetchImpl }
  }

  it('レイドされたら、対戦の種と、レイド元と配信者の名前・アイコンを合成ページへ押し出す（botを接続していなくても流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTwisterTrigger] })
    const twitch = fakeTwitchReturningIcons()

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.requestedIds).toEqual([['レイド元の配信者のユーザーID', BROADCASTER_ID]])
    expect(alertChannel.pushedTwisters).toHaveLength(1)
    // 種はランダムに引くので、0以上2^32未満の整数であることだけを確かめる
    const call = alertChannel.pushedTwisters[0]
    expect(Number.isInteger(call?.seed)).toBe(true)
    expect(call?.seed).toBeGreaterThanOrEqual(0)
    expect(call?.seed).toBeLessThan(2 ** 32)
    expect(call?.players).toEqual([
      { name: 'レイド元の配信者', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/raid_moto.png' },
      { name: 'たねのぶ', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png' },
    ])
    // BGM を選んでいなければ、流さない設定のまま押し出す
    expect(call?.sound).toEqual({ bgm: null, bgmVolume: 0.3 })
  })

  it('BGM を選んでいれば、音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTwisterTrigger] })
    // 検証（音声であること）は twister-sound.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveTwisterSound(env.STORE, { bgm: 'media-taisen', bgmVolume: 0.4 })

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, fakeTwitchReturningIcons().fetchImpl)

    expect(alertChannel.pushedTwisters[0]?.sound).toEqual({ bgm: `/api/media/media-taisen?key=${ISSUED_OVERLAY_KEY}`, bgmVolume: 0.4 })
  })

  it('BGM を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに失敗として記録する（黙って無音で流さない）', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [raidTwisterTrigger] })
    await saveTwisterSound(env.STORE, { bgm: 'media-taisen', bgmVolume: 0.4 })

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, fakeTwitchReturningIcons().fetchImpl)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTwisters).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'twister-push-failed' }])
  })

  it('アイコンを引けなければ押し出さず、失敗として記録する', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTwisterTrigger] })

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, async () => new Response(null, { status: 500 }))

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTwisters).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'twister-push-failed' }])
  })

  it('ツイスターを置いていなければ、Twitch にアイコンを引きに行かない', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'raid', actions: [{ type: 'townTour' }] }] })
    const twitch = fakeTwitchReturningIcons()

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env, twitch.fetchImpl)

    expect(twitch.requestedIds).toEqual([])
    expect(alertChannel.pushedTwisters).toHaveLength(0)
  })
})

describe('ペロペロの動作（lick）', () => {
  const rewardLickTrigger: StoredTrigger = { kind: 'reward', rewardId: '報酬ID-ペロペロ', actions: [{ type: 'lick' }] }
  const REDEMPTION_NOTIFICATION = {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      user_id: '田中太郎のユーザーID',
      user_name: '田中太郎',
      user_login: 'tanaka_taro',
      user_input: '',
      reward: { id: '報酬ID-ペロペロ', title: 'ペロペロされる', cost: 500 },
    },
  }
  const TANAKA_ICON = 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanaka.png'
  /** ログイン名から表示名とアイコンを返す Twitch の代役。tanaka_taro 以外はいないことにする。引かれたログイン名を控える */
  const fakeTwitchKnowingTanaka = () => {
    const requestedLogins: string[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
      const url = new URL(request.url)
      const login = url.searchParams.get('login')
      if (url.origin + url.pathname === 'https://api.twitch.tv/helix/users' && login !== null) {
        requestedLogins.push(login)
        if (login !== 'tanaka_taro') return Response.json({ data: [] })
        return Response.json({ data: [{ id: '田中太郎のユーザーID', login, display_name: '田中太郎', description: '', profile_image_url: TANAKA_ICON }] })
      }
      return new Response(null, { status: 404 })
    }
    return { requestedLogins, fetchImpl }
  }

  it('チャンネルポイントが交換されたら、種と交換した人の名前・アイコンを合成ページへ押し出す（botを接続していなくても流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardLickTrigger] })
    const twitch = fakeTwitchKnowingTanaka()

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(twitch.requestedLogins).toEqual(['tanaka_taro'])
    expect(alertChannel.pushedLicks).toHaveLength(1)
    // 種はランダムに引くので、0以上2^32未満の整数であることだけを確かめる
    const call = alertChannel.pushedLicks[0]
    expect(Number.isInteger(call?.seed)).toBe(true)
    expect(call?.seed).toBeGreaterThanOrEqual(0)
    expect(call?.seed).toBeLessThan(2 ** 32)
    expect(call?.target).toEqual({ name: '田中太郎', iconUrl: TANAKA_ICON })
    // 効果音を選んでいなければ、鳴らさない設定のまま押し出す
    expect(call?.sound).toEqual({ sound: null, volume: 0.6 })
  })

  it('効果音を選んでいれば、音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardLickTrigger] })
    // 検証（音声であること）は lick-sound.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveLickSound(env.STORE, { sound: 'media-juru', volume: 0.8 })

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, fakeTwitchKnowingTanaka().fetchImpl)

    expect(alertChannel.pushedLicks[0]?.sound).toEqual({ sound: `/api/media/media-juru?key=${ISSUED_OVERLAY_KEY}`, volume: 0.8 })
  })

  it('効果音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに失敗として記録する（黙って無音で流さない）', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [rewardLickTrigger] })
    await saveLickSound(env.STORE, { sound: 'media-juru', volume: 0.8 })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, fakeTwitchKnowingTanaka().fetchImpl)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedLicks).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'lick-push-failed' }])
  })

  it('Twitch にその人がいなければ（消えたアカウントなど）、アイコン無しで押し出す（頭文字の顔で流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardLickTrigger] })
    const renamed = { ...REDEMPTION_NOTIFICATION, event: { ...REDEMPTION_NOTIFICATION.event, user_login: 'kieta_hito' } }

    await callWebhook(createNotification({ body: renamed }), env, fakeTwitchKnowingTanaka().fetchImpl)

    expect(alertChannel.pushedLicks.map((call) => call.target)).toEqual([{ name: '田中太郎', iconUrl: null }])
  })

  it('アイコンを引けなければ押し出さず、失敗として記録する', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardLickTrigger] })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, async () => new Response(null, { status: 500 }))

    expect(response.status).toBe(204)
    expect(alertChannel.pushedLicks).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'lick-push-failed' }])
  })

  it('ペロペロを置いていなければ、Twitch にアイコンを引きに行かない', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'reward', rewardId: '報酬ID-ペロペロ', actions: [{ type: 'kanjiQuiz', weights: singleGradeWeights('6') }] }] })
    const twitch = fakeTwitchKnowingTanaka()

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, twitch.fetchImpl)

    expect(twitch.requestedLogins).toEqual([])
    expect(alertChannel.pushedLicks).toHaveLength(0)
  })
})

describe('人形を渡す動作（dollGrant）', () => {
  const REDEMPTION_NOTIFICATION = {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      user_id: '田中太郎のユーザーID',
      user_name: '田中太郎',
      user_login: 'tanaka_taro',
      user_input: '',
      reward: { id: '報酬ID-人形', title: '人形をもらう', cost: 1000 },
    },
  }
  const rewardDollTrigger: StoredTrigger = { kind: 'reward', rewardId: '報酬ID-人形', actions: [{ type: 'dollGrant', kind: 'normal', count: 2 }] }
  const bears = { normal: { name: 'クマ人形', mediaId: 'image-bear' }, super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' } }

  /** クマの人形の組を追加していまの人形にし、その組の ID を返す */
  const selectBears = async (env: Env): Promise<number> => {
    const set = await insertDollSet(env.DB, bears, Date.parse('2026-09-21T12:00:00.000Z'))
    await selectCurrentDollSet(env.DB, set.id)
    return set.id
  }

  it('チャンネルポイントが交換されたら、交換した人にいまの人形を設定の種類と個数だけ渡す（botを接続していなくても渡す）', async () => {
    // 前提: bot は接続していない。いまの人形はクマの組
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger] })
    const setId = await selectBears(env)

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 2, super: 0 }])
    expect(await listFailures(env.DB)).toEqual([])
  })

  it('渡したら、交換した人の名前と人形の名前・画像・個数を合成ページの「人形の獲得」へ押し出す。再送では押し出さない', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger] })
    await selectBears(env)

    await callWebhook(createNotification({ messageId: 'message-doll-1', body: REDEMPTION_NOTIFICATION }), env)
    await callWebhook(createNotification({ messageId: 'message-doll-1', body: REDEMPTION_NOTIFICATION }), env)

    expect(alertChannel.pushedDollAwards).toEqual([
      {
        id: 'trigger:message-doll-1:dollGrant:0',
        userName: '田中太郎',
        kind: 'normal',
        count: 2,
        doll: { name: 'クマ人形', imageUrl: `/api/media/image-bear?key=${ISSUED_OVERLAY_KEY}` },
      },
    ])
  })

  it('同じ通知が再送されても、二重に渡さない。別の通知なら、もう一度渡す', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger] })
    const setId = await selectBears(env)

    await callWebhook(createNotification({ messageId: 'message-doll-1', body: REDEMPTION_NOTIFICATION }), env)
    await callWebhook(createNotification({ messageId: 'message-doll-1', body: REDEMPTION_NOTIFICATION }), env)
    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 2, super: 0 }])

    await callWebhook(createNotification({ messageId: 'message-doll-2', body: REDEMPTION_NOTIFICATION }), env)
    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 4, super: 0 }])
  })

  it('同じ通知に当てはまった2つの行は、どちらも渡す', async () => {
    const { env } = createEnv()
    const allRewardsTrigger: StoredTrigger = { kind: 'reward', rewardId: null, actions: [{ type: 'dollGrant', kind: 'super', count: 1 }] }
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger, allRewardsTrigger] })
    const setId = await selectBears(env)

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(await readDollHoldings(env.DB)).toEqual([{ userId: '田中太郎のユーザーID', setId, normal: 2, super: 1 }])
  })

  it('台帳に、理由をトリガーとして、どのトリガーの項目で渡したかを控える', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger] })
    await selectBears(env)

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    const rows = env.DB.sqlite.prepare('SELECT user_id, kind, delta, reason, trigger_kind FROM doll_ledger').all()
    expect(rows).toEqual([{ user_id: '田中太郎のユーザーID', kind: 'normal', delta: 2, reason: 'trigger', trigger_kind: 'reward' }])
  })

  it('いまの人形が選ばれていなければ、渡さずに失敗として記録する（黙って飛ばさない）', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardDollTrigger] })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    // Twitch には受け取れたと返し（再送させない）、失敗の記録に理由を残す
    expect(response.status).toBe(204)
    expect(await readDollHoldings(env.DB)).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'doll-grant-failed', message: expect.stringContaining('いまの人形が選ばれていません') }])
  })
})

describe('VRMの演出の動作（vrm）', () => {
  const followVrmTrigger: StoredTrigger = { kind: 'follow', actions: [{ type: 'vrm' }] }
  const FOLLOW_NOTIFICATION = { subscription: { type: 'channel.follow' }, event: { user_id: '22222', user_name: '田中太郎', user_login: 'tanaka_taro' } }

  it('当てはまったら、種と選んである VRM のURL（オーバーレイ用キーつき）を合成ページへ押し出す（botを接続していなくても流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [followVrmTrigger] })
    // 検証（VRM であること）は vrm-model.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveVrmModel(env.STORE, { model: 'media-kanban' })

    const response = await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedVrms).toHaveLength(1)
    // 種はランダムに引くので、0以上2^32未満の整数であることだけを確かめる
    const call = alertChannel.pushedVrms[0]
    expect(Number.isInteger(call?.seed)).toBe(true)
    expect(call?.seed).toBeGreaterThanOrEqual(0)
    expect(call?.seed).toBeLessThan(2 ** 32)
    expect(call?.model).toBe(`/api/media/media-kanban?key=${ISSUED_OVERLAY_KEY}`)
  })

  it('VRM を選んでいなければ、押し出さずに失敗として記録する（黙って何も出さずに済ませない）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [followVrmTrigger] })

    const response = await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedVrms).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'vrm-push-failed' }])
  })

  it('オーバーレイ用キーが未発行なら、押し出さずに失敗として記録する', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [followVrmTrigger] })
    await saveVrmModel(env.STORE, { model: 'media-kanban' })

    await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env)

    expect(alertChannel.pushedVrms).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'vrm-push-failed' }])
  })
})

describe('漢字クイズを出題する動作（kanjiQuiz）', () => {
  const rewardKanjiQuizTrigger: StoredTrigger = { kind: 'reward', rewardId: '報酬ID-漢字クイズ', actions: [{ type: 'kanjiQuiz', weights: singleGradeWeights('pre2') }] }
  const REDEMPTION_NOTIFICATION = {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      user_id: '田中太郎のユーザーID',
      user_name: '田中太郎',
      user_login: 'tanaka_taro',
      user_input: '',
      reward: { id: '報酬ID-漢字クイズ', title: '漢字クイズを出す', cost: 500 },
    },
  }

  it('チャンネルポイントが交換されたら、設定の級の問題を1問選び、交換した人の名前と一緒に合成ページへ押し出す（botを接続していなくても流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardKanjiQuizTrigger] })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedKanjiQuizzes).toHaveLength(1)
    // 問題はランダムに選ぶので、設定の級の問題であることと交換した人の名前だけを確かめる
    expect(alertChannel.pushedKanjiQuizzes[0]?.problem.grade).toBe('pre2')
    expect(alertChannel.pushedKanjiQuizzes[0]?.requesterName).toBe('田中太郎')
  })

  it('配送先が失敗したら、失敗として記録する（受け取り自体は成功として返す）', async () => {
    const { env, alertChannel } = createEnv({ channelShouldFail: true })
    await saveAlertConfig(env.STORE, { triggers: [rewardKanjiQuizTrigger] })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedKanjiQuizzes).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'kanji-quiz-push-failed' }])
  })

  it('音を選んでいれば、音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardKanjiQuizTrigger] })
    // 検証（音声であること）は kanji-quiz-sound.test.ts が確かめるので、ここでは保存済みの設定として直接置く
    await saveKanjiQuizSound(env.STORE, { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, bgm: 'media-thinking' } })

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(alertChannel.pushedKanjiQuizzes[0]?.sound).toEqual({
      ...DEFAULT_KANJI_QUIZ_SOUND,
      slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, bgm: `/api/media/media-thinking?key=${ISSUED_OVERLAY_KEY}` },
    })
  })

  it('音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに失敗として記録する（黙って無音で流さない）', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [rewardKanjiQuizTrigger] })
    await saveKanjiQuizSound(env.STORE, { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, bgm: 'media-thinking' } })

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedKanjiQuizzes).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'kanji-quiz-push-failed' }])
  })

  it('同じ配信で準2級の問題を出しきっても、失敗にせず一巡して出題しつづける', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [rewardKanjiQuizTrigger] })
    await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: NOW - 60_000 })
    const pre2Count = KANJI_QUIZ_PROBLEMS.filter((problem) => problem.grade === 'pre2').length

    // 準2級の問題数より1回多く交換する
    for (let attempt = 0; attempt <= pre2Count; attempt++) {
      await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION, messageId: `notification-${attempt}` }), env)
    }

    // 1巡目は重複させず、出しきったあとの交換は2巡目として出す
    const words = alertChannel.pushedKanjiQuizzes.map(({ problem }) => problem.word)
    expect(words).toHaveLength(pre2Count + 1)
    expect(new Set(words.slice(0, pre2Count)).size).toBe(pre2Count)
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([])
    expect(await listFailures(env.DB)).toEqual([])
  })
})

describe('市町村紹介を流す動作（townTour）', () => {
  const raidTownTourTrigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'townTour' }] }

  it('レイドされたら、引いた市町村とレイド元の名前を入れた一文を合成ページへ押し出す（botを接続していなくても流す）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    // 市町村はランダムに引くので、一覧のコード（5桁）であることと、一文の形だけを確かめる
    expect(alertChannel.pushedTownTours).toHaveLength(1)
    expect(alertChannel.pushedTownTours[0]?.code).toMatch(/^\d{5}$/)
    expect(alertChannel.pushedTownTours[0]?.headline).toMatch(/^レイド元の配信者さんのレイドを記念して、本日は.+をご紹介します$/)
  })

  it('ナレーションを読み上げる設定なら、読み上げることを一緒に押し出す（issue #255）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })
    await saveTownTourNarration(env.STORE, { enabled: true, speaker: 13, speed: 1 })

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(alertChannel.pushedTownTours[0]?.narration).toBe(true)
  })

  it('紹介済みの市町村は除いて引き、これまでの記録と、流しきったら記録するきっかけと相手を一緒に押し出す（issue #252）', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })
    // 北海道石狩郡当別町（01303）だけを残して、ほかの市町村はすべて紹介済みにしておく
    const visitedCodes = towns.map(({ code }) => code).filter((code) => code !== '01303')
    for (const code of visitedCodes) await recordTownTourVisit(env.DB, { code, occasion: 'raid', userName: '過去のレイド' }, Date.UTC(2026, 8, 1))

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(alertChannel.pushedTownTours[0]?.code).toBe('01303')
    expect(alertChannel.pushedTownTours[0]?.visited).toHaveLength(visitedCodes.length)
    expect(alertChannel.pushedTownTours[0]?.visit).toEqual({ occasion: 'raid', userName: 'レイド元の配信者' })
  })

  it('1つの通知で市町村紹介を2回流すときは、同じ市町村を引かない', async () => {
    const { env, alertChannel } = createEnv()
    // レイドの行を2つ置き、どちらにも市町村紹介を置く
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger, raidTownTourTrigger] })
    // 北海道石狩郡当別町（01303）と東京都千代田区（13101）だけを残して、ほかの市町村はすべて紹介済みにしておく
    const remaining = ['01303', '13101']
    for (const code of towns.map((town) => town.code).filter((code) => !remaining.includes(code))) {
      await recordTownTourVisit(env.DB, { code, occasion: 'raid', userName: '過去のレイド' }, Date.UTC(2026, 8, 1))
    }

    // 乱数をいつも0にする（除かなければ、2回とも残りの先頭の当別町を引いてしまう）
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)
    } finally {
      random.mockRestore()
    }

    expect(alertChannel.pushedTownTours.map(({ code }) => code).sort()).toEqual(remaining)
  })

  it('保存した音の設定を、音声のURL（オーバーレイ用キーつき）にして一緒に押し出す', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })
    // BGM と始まりの音だけを選び、ほかの枠は鳴らさない
    await saveTownTourSound(env.STORE, {
      ...DEFAULT_TOWN_TOUR_SOUND,
      slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie', opening: 'media-jajean' },
    })

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(alertChannel.pushedTownTours[0]?.sound).toEqual({
      slots: {
        bgm: `/api/media/media-cookie?key=${ISSUED_OVERLAY_KEY}`,
        opening: `/api/media/media-jajean?key=${ISSUED_OVERLAY_KEY}`,
        zoom: null,
        landing: null,
        item: null,
        closing: null,
      },
      bgmVolume: DEFAULT_TOWN_TOUR_SOUND.bgmVolume,
      effectVolume: DEFAULT_TOWN_TOUR_SOUND.effectVolume,
    })
  })

  it('音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに失敗として記録する（黙って無音で流さない）', async () => {
    const { env, alertChannel } = createEnv({ overlayKey: null })
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })
    await saveTownTourSound(env.STORE, { ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie' } })

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTownTours).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'town-tour-push-failed' }])
  })

  it('同じ通知が再送されても、二度は押し出さない', async () => {
    const { env, alertChannel } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })

    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)
    await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(alertChannel.pushedTownTours).toHaveLength(1)
  })

  it('配送先が失敗しても、Twitchへは2xxを返して失敗として記録する', async () => {
    const { env } = createEnv({ channelShouldFail: true })
    await saveAlertConfig(env.STORE, { triggers: [raidTownTourTrigger] })

    const response = await callWebhook(createNotification({ body: RAID_NOTIFICATION }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'town-tour-push-failed' }])
  })
})

describe('市町村紹介の都道府県当てクイズの回答（issue #251）', () => {
  /** 北海道石狩郡当別町の出題（3秒前に合成ページが開いた） */
  const tobetsuQuiz = { id: 'quiz-tobetsu', code: '01303', prefecture: '北海道' }

  /** 視聴者の発言としての通知 */
  const chatFrom = (userName: string, chatterUserId: string, text: string, messageId: string) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: `viewer${chatterUserId}`,
      chatter_user_name: userName,
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
    },
  })

  it('出題中に正しい都道府県を書いた最初の人を、正解者として合成ページへ押し出す', async () => {
    const { env, db, alertChannel } = createEnv()
    await openTownTourQuiz(db, tobetsuQuiz, NOW - 3000)

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道！', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTownTourAnswers).toEqual([{ type: 'answer', quizId: 'quiz-tobetsu', userName: 'たなか' }])
  })

  it('違う都道府県の回答と、2人目の正解者は押し出さない', async () => {
    const { env, db, alertChannel } = createEnv()
    await openTownTourQuiz(db, tobetsuQuiz, NOW - 3000)

    await callWebhook(createNotification({ body: chatFrom('すずき', '22222', '青森県かな', 'chat-1'), messageId: 'notification-1' }), env)
    await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道', 'chat-2'), messageId: 'notification-2' }), env)
    await callWebhook(createNotification({ body: chatFrom('さとう', '33333', '北海道だ', 'chat-3'), messageId: 'notification-3' }), env)

    expect(alertChannel.pushedTownTourAnswers).toEqual([{ type: 'answer', quizId: 'quiz-tobetsu', userName: 'たなか' }])
  })

  it('2つ以上の都道府県を挙げた発言は、正解を含んでいても回答とみなさない', async () => {
    const { env, db, alertChannel } = createEnv()
    await openTownTourQuiz(db, tobetsuQuiz, NOW - 3000)

    await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道か青森', 'chat-1'), messageId: 'notification-1' }), env)

    expect(alertChannel.pushedTownTourAnswers).toEqual([])
  })

  it('クイズの照らし合わせに失敗しても、Twitchへは2xxを返して失敗として記録し、ほかの処理を止めない', async () => {
    const { env, db, alertChannel } = createEnv()
    // マイグレーション 0026 を適用する前を再現する
    db.sqlite.exec('DROP TABLE town_tour_quizzes')

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTownTourAnswers).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'town-tour-quiz-failed' }])
  })

  it('正解者を合成ページへ押し出せなくても、Twitchへは2xxを返して失敗として記録する', async () => {
    const { env, db } = createEnv({ channelShouldFail: true })
    await openTownTourQuiz(db, tobetsuQuiz, NOW - 3000)

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'town-tour-quiz-failed' }])
  })

  it('出題していなければ、都道府県を書いた発言でも何も押し出さない', async () => {
    const { env, alertChannel } = createEnv()

    await callWebhook(createNotification({ body: chatFrom('たなか', '11111', '北海道', 'chat-1'), messageId: 'notification-1' }), env)

    expect(alertChannel.pushedTownTourAnswers).toEqual([])
  })
})

describe('漢字クイズの回答（issue #301）', () => {
  /** 問題集の「草花」（読みは「くさばな」「そうか」）の出題。熟語が出てから3秒たっている */
  const kusabanaQuiz = { id: 'quiz-kusabana', word: '草花', rehearsal: false }
  const openKusabanaQuiz = async (db: Parameters<typeof recordKanjiQuiz>[0]) => {
    await recordKanjiQuiz(db, kusabanaQuiz, NOW - GRADE_INTRO_MS - 4000)
    await openKanjiQuiz(db, kusabanaQuiz.id, NOW - GRADE_INTRO_MS - 3000)
  }

  /** チャットの発言としての通知 */
  const chatFrom = (userName: string, chatterUserId: string, text: string, messageId: string) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: `viewer${chatterUserId}`,
      chatter_user_name: userName,
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
    },
  })

  it('出題中に正しい読みを書いた最初の人を、正解者として合成ページへ押し出す（カタカナ・前後の空白は直して照らす）', async () => {
    const { env, db, alertChannel } = createEnv()
    await openKusabanaQuiz(db)

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', ' ソウカ ', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: 'たなか' }])
  })

  it('配信者の発言も回答として受ける', async () => {
    const { env, db, alertChannel } = createEnv()
    await openKusabanaQuiz(db)

    await callWebhook(createNotification({ body: chatFrom('配信者', BROADCASTER_ID, 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

    expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: '配信者' }])
  })

  it('違う読み・部分一致の回答と、2人目の正解者は押し出さない', async () => {
    const { env, db, alertChannel } = createEnv()
    await openKusabanaQuiz(db)

    await callWebhook(createNotification({ body: chatFrom('すずき', '22222', 'あおぞら', 'chat-1'), messageId: 'notification-1' }), env)
    await callWebhook(createNotification({ body: chatFrom('さとう', '33333', 'くさばなかな', 'chat-2'), messageId: 'notification-2' }), env)
    await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-3'), messageId: 'notification-3' }), env)
    await callWebhook(createNotification({ body: chatFrom('やまだ', '44444', 'そうか', 'chat-4'), messageId: 'notification-4' }), env)

    expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: 'たなか' }])
  })

  it('照らし合わせに失敗したら、黙って不正解にせず失敗として記録し、Twitchへは2xxを返す', async () => {
    const { env, db, alertChannel } = createEnv()
    // マイグレーション 0031 を適用する前を再現する
    db.sqlite.exec('DROP TABLE kanji_quizzes')

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'kanji-quiz-answer-failed' }])
  })

  it('正解者を合成ページへ押し出せなくても、Twitchへは2xxを返して失敗として記録する', async () => {
    const { env, db } = createEnv({ channelShouldFail: true })
    await openKusabanaQuiz(db)

    const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'kanji-quiz-answer-failed' }])
  })

  it('問題集のどの読みとも一致しない発言では D1 を読まない（テーブルが無くても失敗にならない）', async () => {
    const { env, db } = createEnv()
    db.sqlite.exec('DROP TABLE kanji_quizzes')

    await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'こんにちは', 'chat-1'), messageId: 'notification-1' }), env)

    expect(await listFailures(env.DB)).toEqual([])
  })

  describe('正解者に渡す人形（issue #420）', () => {
    const bears = { normal: { name: 'クマ人形', mediaId: 'image-bear' }, super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' } }

    /** クマの人形の組を登録し、いまの人形に選ぶ */
    const selectBears = async (env: Env): Promise<number> => {
      const set = await insertDollSet(env.DB, bears, Date.parse('2026-09-21T12:00:00.000Z'))
      await selectCurrentDollSet(env.DB, set.id)
      return set.id
    }

    it('正解者に渡す人形を選んでいれば、最初の正解者にいまの人形を1つ渡し、理由を漢字クイズとして台帳に残す', async () => {
      // 前提: 正解者に渡すのはふつうの人形。いまの人形はクマの組
      const { env, db } = createEnv()
      await saveDollPrize(env.STORE, 'kanjiQuiz', { kind: 'normal' })
      const setId = await selectBears(env)
      await openKusabanaQuiz(db)

      await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)
      // 同じ通知の再送と、2人目の正解者には渡さない
      await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)
      await callWebhook(createNotification({ body: chatFrom('やまだ', '44444', 'そうか', 'chat-2'), messageId: 'notification-2' }), env)

      expect(await readDollHoldings(env.DB)).toEqual([{ userId: '11111', setId, normal: 1, super: 0 }])
      expect(env.DB.sqlite.prepare('SELECT reason, trigger_kind FROM doll_ledger').all()).toEqual([{ reason: 'kanjiQuiz', trigger_kind: null }])
    })

    it('正解者に渡したら、正解者の名前と人形を合成ページの「人形の獲得」へ押し出す', async () => {
      const { env, db, alertChannel } = createEnv()
      await saveDollPrize(env.STORE, 'kanjiQuiz', { kind: 'normal' })
      await selectBears(env)
      await openKusabanaQuiz(db)

      await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

      expect(alertChannel.pushedDollAwards).toEqual([
        {
          id: 'kanjiQuiz:quiz-kusabana',
          userName: 'たなか',
          kind: 'normal',
          count: 1,
          doll: { name: 'クマ人形', imageUrl: `/api/media/image-bear?key=${ISSUED_OVERLAY_KEY}` },
        },
      ])
    })

    it('試し再生の出題の正解者には渡さない（正解者は合成ページへ押し出す）', async () => {
      const { env, db, alertChannel } = createEnv()
      await saveDollPrize(env.STORE, 'kanjiQuiz', { kind: 'normal' })
      await selectBears(env)
      await recordKanjiQuiz(db, { ...kusabanaQuiz, rehearsal: true }, NOW - GRADE_INTRO_MS - 4000)
      await openKanjiQuiz(db, kusabanaQuiz.id, NOW - GRADE_INTRO_MS - 3000)

      await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

      expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: 'たなか' }])
      expect(await readDollHoldings(env.DB)).toEqual([])
    })

    it('渡す人形が「なし」（保存していない）なら、正解しても渡さない', async () => {
      const { env, db } = createEnv()
      await selectBears(env)
      await openKusabanaQuiz(db)

      await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

      expect(await readDollHoldings(env.DB)).toEqual([])
      expect(await listFailures(env.DB)).toEqual([])
    })

    it('いまの人形が選ばれていなくても、正解者は合成ページへ押し出し、渡せなかったことを失敗として残す', async () => {
      const { env, db, alertChannel } = createEnv()
      await saveDollPrize(env.STORE, 'kanjiQuiz', { kind: 'super' })
      await openKusabanaQuiz(db)

      const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

      expect(response.status).toBe(204)
      expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: 'たなか' }])
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'doll-grant-failed', message: expect.stringContaining('いまの人形が選ばれていません') }])
    })

    it('渡せなかったことを記録することにも失敗しても、正解者は合成ページへ押し出す', async () => {
      // 前提: 台帳と失敗の記録のテーブルが無い（D1 の不調を再現する）。出題の行は残っている
      const { env, db, alertChannel } = createEnv()
      await saveDollPrize(env.STORE, 'kanjiQuiz', { kind: 'normal' })
      await openKusabanaQuiz(db)
      db.sqlite.exec('DROP TABLE doll_ledger')
      db.sqlite.exec('DROP TABLE collection_failures')
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const response = await callWebhook(createNotification({ body: chatFrom('たなか', '11111', 'くさばな', 'chat-1'), messageId: 'notification-1' }), env)

      expect(response.status).toBe(204)
      expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'answer', quizId: 'quiz-kusabana', userName: 'たなか' }])
      // 記録できなかったことは、Worker のログに残す（黙って捨てない）
      expect(consoleError).toHaveBeenCalled()
      consoleError.mockRestore()
    })
  })
})

describe('意見ボードのコメント（issue #306）', () => {
  /** チャットの発言としての通知。返信なら返信先を添える */
  const chatFrom = (userName: string, chatterUserId: string, text: string, messageId: string, reply: Record<string, unknown> | null = null) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: chatterUserId,
      chatter_user_login: `viewer${chatterUserId}`,
      chatter_user_name: userName,
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
      reply,
    },
  })

  /** 貯まったコメントを読む */
  const storedComments = (db: ReturnType<typeof createEnv>['db']) =>
    db.sqlite.prepare('SELECT user_name, text, reply_name, reply_text, status, drop_reason FROM opinion_comments ORDER BY id').all()

  it('テーマを出しているあいだのコメントを貯め、短い反応は理由をつけて落とす', async () => {
    const { env, db } = createEnv()
    await openTheme(db, '配信中にAIをどこまで使っていい？', NOW - 60_000)

    await callWebhook(createNotification({ body: chatFrom('aoi', '11111', 'AIのコメ返しはちょっと寂しい', 'chat-1'), messageId: 'notification-1' }), env)
    await callWebhook(createNotification({ body: chatFrom('nekomaru', '22222', '草', 'chat-2'), messageId: 'notification-2' }), env)
    const reply = { parent_message_id: 'chat-1', parent_message_body: 'AIのコメ返しはちょっと寂しい', parent_user_id: '11111', parent_user_login: 'viewer11111', parent_user_name: 'aoi', thread_message_id: 'chat-1', thread_user_id: '11111', thread_user_login: 'viewer11111', thread_user_name: 'aoi' }
    await callWebhook(createNotification({ body: chatFrom('pon_pon', '33333', 'それな', 'chat-3', reply), messageId: 'notification-3' }), env)

    expect(storedComments(db)).toEqual([
      { user_name: 'aoi', text: 'AIのコメ返しはちょっと寂しい', reply_name: null, reply_text: null, status: 'pending', drop_reason: null },
      { user_name: 'nekomaru', text: '草', reply_name: null, reply_text: null, status: 'dropped', drop_reason: 'reaction' },
      { user_name: 'pon_pon', text: 'それな', reply_name: 'aoi', reply_text: 'AIのコメ返しはちょっと寂しい', status: 'pending', drop_reason: null },
    ])
  })

  it('テーマを出していなければ貯めない', async () => {
    const { env, db } = createEnv()

    await callWebhook(createNotification({ body: chatFrom('aoi', '11111', 'AIのコメ返しはちょっと寂しい', 'chat-1'), messageId: 'notification-1' }), env)

    expect(storedComments(db)).toEqual([])
  })

  it('貯められなくても、Twitchへは2xxを返して失敗として記録する', async () => {
    const { env, db } = createEnv()
    await openTheme(db, '配信中にAIをどこまで使っていい？', NOW - 60_000)
    // 貯める表が壊れている場合を再現する
    db.sqlite.exec('DROP TABLE opinion_comments')

    const response = await callWebhook(createNotification({ body: chatFrom('aoi', '11111', 'AIのコメ返しはちょっと寂しい', 'chat-1'), messageId: 'notification-1' }), env)

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'opinion-record-failed' }])
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
    saveToken(env.TOKENS, 'bot', {
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

  describe('呼び出しの歯止め（クールダウンと1日の上限）', () => {
    const everyMessageTrigger: StoredTrigger = { kind: 'everyMessage', actions: [{ type: 'aiChat', instruction: '一言返してください' }] }

    /** その日（UTC）の aiChat の呼び出し回数が、指定した回数になっている状態を作る */
    const recordLlmUsageCalls = async (db: ReturnType<typeof createFakeDatabase>, calls: number) => {
      db.sqlite
        .prepare(
          `INSERT INTO llm_usage (day, usage, provider, model, calls, failures, prompt_tokens, completion_tokens, cost_usd, updated_at)
           VALUES (?1, 'aiChat', 'workers-ai', 'テスト用モデル', ?2, 0, 0, 0, 0, ?3)`,
        )
        .run(new Date(NOW).toISOString().slice(0, 10), calls, new Date(NOW).toISOString())
    }

    /** 指定した人・メッセージIDの発言を、通知のIDも変えて届ける */
    const sendChatFrom = async (env: Env, fetchImpl: typeof fetch, chatterUserId: string, messageId: string) => {
      await callWebhook(
        createNotification({
          messageId: `eventsub-${messageId}`,
          body: {
            subscription: { type: 'channel.chat.message' },
            event: {
              ...firstTimerMessage.event,
              chatter_user_id: chatterUserId,
              message_id: messageId,
              message: { text: 'こんばんは', fragments: [{ type: 'text', text: 'こんばんは' }] },
            },
          },
        }),
        env,
        fetchImpl,
      )
      await flushDeferredTasks()
    }

    it('同じ人が続けて発言しても、クールダウンの間は2回目の文面を作らない', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')
      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-2')

      expect(ai.calls).toHaveLength(1)
      expect(twitch.sentChats).toHaveLength(1)
      // クールダウンは想定どおりの抑止なので、失敗としては記録しない
      expect(await listFailures(env.DB)).toEqual([])
    })

    it('別の人の発言にはクールダウンが効かない（人ごとに数える）', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')
      await sendChatFrom(env, twitch.fetchImpl, '22222', 'chat-message-2')

      expect(ai.calls).toHaveLength(2)
    })

    it('クールダウンが明けていれば、同じ人の発言にもう一度文面を作る', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')
      // 最後に作った時刻を1時間前へ戻して、クールダウンが明けた状態にする
      env.DB.sqlite.prepare('UPDATE command_uses SET used_at = ?1').run(new Date(NOW - 60 * 60 * 1000).toISOString())
      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-2')

      expect(ai.calls).toHaveLength(2)
    })

    it('その日の呼び出しが上限に達していたら、LLMを呼ばずに失敗として記録する', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()
      await recordLlmUsageCalls(env.DB, AI_CHAT_DAILY_LIMIT)

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')

      expect(ai.calls).toHaveLength(0)
      expect(twitch.sentChats).toHaveLength(0)
      expect(await listFailures(env.DB)).toMatchObject([{ code: 'alert-aichat-failed', message: expect.stringContaining('1日の上限') }])
    })

    it('上限を超えた状態が続いても、失敗の記録は一定時間に1回だけにする（ほかの失敗を押し流さないため）', async () => {
      const { env } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()
      await recordLlmUsageCalls(env.DB, AI_CHAT_DAILY_LIMIT)

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')
      await sendChatFrom(env, twitch.fetchImpl, '22222', 'chat-message-2')

      expect(await listFailures(env.DB)).toHaveLength(1)
    })

    it('上限に満たなければ、通常どおり文面を作る', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [everyMessageTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()
      await recordLlmUsageCalls(env.DB, AI_CHAT_DAILY_LIMIT - 1)

      await sendChatFrom(env, twitch.fetchImpl, '11111', 'chat-message-1')

      expect(ai.calls).toHaveLength(1)
    })

    it('チャットの発言でないイベント（フォロー）は、発言者がいないのでイベントの種類ごとにクールダウンを数える', async () => {
      const { env, ai } = createEnv()
      await saveAlertConfig(env.STORE, { triggers: [generatedTextTrigger] })
      await connectBot(env)
      const twitch = fakeTwitchAcceptingSends()

      await callWebhook(createNotification({ messageId: 'follow-1', body: createFollowNotification }), env, twitch.fetchImpl)
      await flushDeferredTasks()
      await callWebhook(createNotification({ messageId: 'follow-2', body: createFollowNotification }), env, twitch.fetchImpl)
      await flushDeferredTasks()

      expect(ai.calls).toHaveLength(1)
    })
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

  describe('その配信で初めての発言の印（挨拶の相手）', () => {
    const BOT_ID = '67890'
    /** bot をつないでおく（bot 自身の発言を見分けるため） */
    const connectBot = (env: Env) =>
      saveToken(env.TOKENS, 'bot', {
        accessToken: 'bot-access-token',
        refreshToken: 'bot-refresh-token',
        expiresAt: NOW + 60 * 60 * 1000,
        scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
        userId: BOT_ID,
        login: 'haishinsha_bot',
      })
    /** 発言者を差し替えた、同じ形の発言 */
    const messageFrom = (chatterUserId: string, messageId: string) => ({ ...viewerMessage, event: { ...viewerMessage.event, chatter_user_id: chatterUserId, message_id: messageId } })

    it('配信中に初めて発言した人の発言には印を付け、同じ人の2回目の発言には付けない', async () => {
      const { env, db, commentChannel } = createEnv()
      await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))

      await callWebhook(createNotification({ messageId: 'eventsub-1', body: messageFrom('11111', 'はじめてのこんばんは') }), env)
      await callWebhook(createNotification({ messageId: 'eventsub-2', body: messageFrom('11111', '2回目の発言') }), env)

      expect(commentChannel.pushedItems).toMatchObject([
        { messageId: 'はじめてのこんばんは', firstOfStream: true },
        { messageId: '2回目の発言', firstOfStream: false },
      ])
    })

    it('トリガーが1件も無くても、初めての発言を記録する（挨拶の管理は通知音の有無と関係ない）', async () => {
      const { env, db } = createEnv()
      await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))

      await callWebhook(createNotification({ body: messageFrom('11111', 'はじめてのこんばんは') }), env)

      expect(db.sqlite.prepare('SELECT message_id FROM first_chatters').all()).toEqual([{ message_id: 'はじめてのこんばんは' }])
    })

    it('配信していなければ印を付けない', async () => {
      const { env, commentChannel } = createEnv()

      await callWebhook(createNotification({ body: messageFrom('11111', '配信外の発言') }), env)

      expect(commentChannel.pushedItems).toMatchObject([{ messageId: '配信外の発言', firstOfStream: false }])
    })

    it('配信者自身と bot の発言には印を付けず、初めての発言としても記録しない', async () => {
      const { env, db, commentChannel } = createEnv()
      await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
      await connectBot(env)

      await callWebhook(createNotification({ messageId: 'eventsub-1', body: messageFrom(BROADCASTER_ID, '配信者の発言') }), env)
      await callWebhook(createNotification({ messageId: 'eventsub-2', body: messageFrom(BOT_ID, 'botの発言') }), env)

      expect(commentChannel.pushedItems).toMatchObject([{ firstOfStream: false }, { firstOfStream: false }])
      expect(db.sqlite.prepare('SELECT message_id FROM first_chatters').all()).toEqual([])
    })
  })

  it('bot のトークンが壊れていても、チャットの発言はコメントビューアーへ押し出す（応答の側はこれまでどおり失敗にする）', async () => {
    const created = createEnv()
    const { commentChannel } = created
    // 保管庫に、トークンとして読めない値が入っている
    const env: Env = { ...created.env, TOKENS: createFakeTokenVault({ bot: '"壊れたトークン"' }).namespace }

    const response = await callWebhook(createNotification({ messageId: 'eventsub-1', body: viewerMessage }), env)

    expect(commentChannel.pushedItems).toMatchObject([{ kind: 'chat', messageId: 'chat-message-1' }])
    expect(response.status).toBe(500)
  })

  it('別のチャンネルのチャットは押し出さない（古い購読が残っていても、他人のチャットを並べないため）', async () => {
    const { env, commentChannel } = createEnv()
    const otherChannel = { ...viewerMessage, event: { ...viewerMessage.event, broadcaster_user_id: '別の配信者のID' } }

    await callWebhook(createNotification({ body: otherChannel }), env)

    expect(commentChannel.pushedItems).toEqual([])
  })

  it('Shared Chat の相手チャンネルで書かれた発言は押し出すが、初めての発言の印は付けず記録もしない（issue #205）', async () => {
    const { env, db, commentChannel } = createEnv()
    await recordLiveStream(db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    const sharedChat = { ...viewerMessage, event: { ...viewerMessage.event, source_broadcaster_user_id: '相手チャンネルのID' } }

    await callWebhook(createNotification({ body: sharedChat }), env)

    // 自チャンネルのチャット欄にも見えている発言なので、コメントビューアーには並べる
    expect(commentChannel.pushedItems).toMatchObject([{ kind: 'chat', messageId: 'chat-message-1', firstOfStream: false }])
    expect(db.sqlite.prepare('SELECT message_id FROM first_chatters').all()).toEqual([])
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

describe('作業机の組み込みコマンド（!task・!done）', () => {
  const BOT_ID = '67890'

  /** 配信中で、botを接続済みの環境を作る。コマンドは1つも登録しない（組み込みのコマンドは登録しなくても動く） */
  const liveEnvWithBot = async () => {
    const created = createEnv()
    await recordLiveStream(created.db, CHAT_STREAM, Date.parse('2026-09-21T12:05:00Z'))
    await saveToken(created.env.TOKENS, 'bot', {
      accessToken: 'bot-access-token',
      refreshToken: 'bot-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
      userId: BOT_ID,
      login: 'haishinsha_bot',
    })
    return created
  }

  /** 視聴者「たなか」の発言としての通知 */
  const chatFromTanaka = (text: string, messageId: string) => ({
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: BROADCASTER_ID,
      chatter_user_id: '11111',
      chatter_user_login: 'tanaka',
      chatter_user_name: 'たなか',
      message_id: messageId,
      message: { text, fragments: [{ type: 'text', text }] },
    },
  })

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

  it('コマンドを登録していなくても、!task で作業机に並べて押し出す', async () => {
    const { env, alertChannel } = await liveEnvWithBot()
    const twitch = fakeTwitchAcceptingSends()

    const response = await callWebhook(createNotification({ body: chatFromTanaka('!task 英単語を50個覚える', 'chat-message-1'), messageId: 'notification-1' }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTaskDesk).toMatchObject([{ entries: [{ userId: '11111', name: 'たなか', task: '英単語を50個覚える', doneAt: null }] }])
    expect(twitch.sentChats).toEqual([])
  })

  it('!done で完了にすると、完了の時刻つきで押し出す', async () => {
    const { env, alertChannel } = await liveEnvWithBot()
    const twitch = fakeTwitchAcceptingSends()
    await callWebhook(createNotification({ body: chatFromTanaka('!task 英単語を50個覚える', 'chat-message-1'), messageId: 'notification-1' }), env, twitch.fetchImpl)

    await callWebhook(createNotification({ body: chatFromTanaka('!done', 'chat-message-2'), messageId: 'notification-2' }), env, twitch.fetchImpl)

    expect(alertChannel.pushedTaskDesk.at(-1)?.entries[0]?.doneAt).toBe(new Date(NOW).toISOString())
  })

  it('作業が長すぎれば、botが理由を返す', async () => {
    const { env, alertChannel } = await liveEnvWithBot()
    const twitch = fakeTwitchAcceptingSends()

    await callWebhook(createNotification({ body: chatFromTanaka(`!task ${'あ'.repeat(41)}`, 'chat-message-1') }), env, twitch.fetchImpl)

    expect(alertChannel.pushedTaskDesk).toEqual([])
    expect(await twitch.sentChats[0]!.json()).toMatchObject({ message: '@tanaka 作業は40文字以内で書いてください（いまは41文字です）' })
  })

  it('宣言の発言をモデレーターが消したら、作業机から外して押し出す', async () => {
    const { env, alertChannel } = await liveEnvWithBot()
    const twitch = fakeTwitchAcceptingSends()
    await callWebhook(createNotification({ body: chatFromTanaka('!task 見せたくない文言', 'chat-message-arashi'), messageId: 'notification-1' }), env, twitch.fetchImpl)
    const deletion = {
      subscription: { type: 'channel.chat.message_delete' },
      event: { broadcaster_user_id: BROADCASTER_ID, target_user_id: '11111', target_user_login: 'tanaka', target_user_name: 'たなか', message_id: 'chat-message-arashi' },
    }

    const response = await callWebhook(createNotification({ body: deletion, messageId: 'notification-2' }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedTaskDesk.at(-1)).toEqual({ entries: [], workTime: null })
  })
  describe('モデレーションで消された発言を、LLMの材料（stream_chat_messages）から外す（issue #202）', () => {
    const storedTexts = (db: ReturnType<typeof createFakeDatabase>) => db.sqlite.prepare('SELECT text FROM stream_chat_messages ORDER BY sent_at, message_id').all()

    /** たなかさんの荒らしの発言と、すずきさんの挨拶を、配信中に届けておく */
    const chatTwoMessages = async (env: Env, fetchImpl: typeof fetch) => {
      await callWebhook(createNotification({ body: chatFromTanaka('見せたくない書き込み', 'chat-message-arashi'), messageId: 'notification-1' }), env, fetchImpl)
      const fromSuzuki = chatFromTanaka('わこつ', 'chat-message-suzuki')
      await callWebhook(
        createNotification({ body: { ...fromSuzuki, event: { ...fromSuzuki.event, chatter_user_id: '22222', chatter_user_login: 'suzuki' } }, messageId: 'notification-2' }),
        env,
        fetchImpl,
      )
    }

    it('発言の削除では、その発言だけを外す', async () => {
      const { env, db } = await liveEnvWithBot()
      await chatTwoMessages(env, fakeTwitchAcceptingSends().fetchImpl)
      const deletion = {
        subscription: { type: 'channel.chat.message_delete' },
        event: { broadcaster_user_id: BROADCASTER_ID, target_user_id: '11111', target_user_login: 'tanaka', target_user_name: 'たなか', message_id: 'chat-message-arashi' },
      }

      await callWebhook(createNotification({ body: deletion, messageId: 'notification-3' }), env)

      expect(storedTexts(db)).toEqual([{ text: 'わこつ' }])
    })

    it('ある人の発言の一掃では、その人の発言を外す', async () => {
      const { env, db } = await liveEnvWithBot()
      await chatTwoMessages(env, fakeTwitchAcceptingSends().fetchImpl)
      const clearUser = {
        subscription: { type: 'channel.chat.clear_user_messages' },
        event: { broadcaster_user_id: BROADCASTER_ID, target_user_id: '11111', target_user_login: 'tanaka', target_user_name: 'たなか' },
      }

      await callWebhook(createNotification({ body: clearUser, messageId: 'notification-3' }), env)

      expect(storedTexts(db)).toEqual([{ text: 'わこつ' }])
    })

    it('チャットのクリアでは、いまの配信の発言をすべて外す', async () => {
      const { env, db } = await liveEnvWithBot()
      await chatTwoMessages(env, fakeTwitchAcceptingSends().fetchImpl)
      const clear = { subscription: { type: 'channel.chat.clear' }, event: { broadcaster_user_id: BROADCASTER_ID } }

      await callWebhook(createNotification({ body: clear, messageId: 'notification-3' }), env)

      expect(storedTexts(db)).toEqual([])
    })

    it('別のチャンネルのチャットのクリアでは、材料を消さない', async () => {
      const { env, db } = await liveEnvWithBot()
      await chatTwoMessages(env, fakeTwitchAcceptingSends().fetchImpl)
      const otherChannelClear = { subscription: { type: 'channel.chat.clear' }, event: { broadcaster_user_id: '99999' } }

      await callWebhook(createNotification({ body: otherChannelClear, messageId: 'notification-3' }), env)

      expect(storedTexts(db)).toHaveLength(2)
    })
  })

  it('別のチャンネルのチャットのクリアでは、作業机を消さない（古い購読が残っていても、他人のモデレーションで消さないため）', async () => {
    const { env, alertChannel } = await liveEnvWithBot()
    const twitch = fakeTwitchAcceptingSends()
    await callWebhook(createNotification({ body: chatFromTanaka('!task 英単語を50個覚える', 'chat-message-1'), messageId: 'notification-1' }), env, twitch.fetchImpl)
    const otherChannelClear = { subscription: { type: 'channel.chat.clear' }, event: { broadcaster_user_id: '99999' } }

    await callWebhook(createNotification({ body: otherChannelClear, messageId: 'notification-2' }), env)

    expect(alertChannel.pushedTaskDesk).toHaveLength(1)
  })
})

describe('チャットで推理を始める動作（chatDeduction）', () => {
  const START_REWARD_ID = '報酬ID-推理を始める'
  const QUESTION_REWARD_ID = '報酬ID-質問'
  const ANSWER_REWARD_ID = '報酬ID-解答'
  const REDEMPTION_NOTIFICATION = {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      id: '交換ID-推理を始める',
      user_id: '田中太郎のユーザーID',
      user_name: '田中太郎',
      user_login: 'tanaka_taro',
      user_input: '',
      reward: { id: START_REWARD_ID, title: 'チャットで推理を始める', cost: 1000 },
    },
  }
  const FOLLOW_NOTIFICATION = { subscription: { type: 'channel.follow' }, event: { user_id: '22222', user_name: '田中太郎', user_login: 'tanaka_taro' } }
  const ancientPeople = CHAT_DEDUCTION_PROBLEM_SETS.find((set) => set.id === 'ancient-people')!

  /** 報酬の切り替えまでできる配信者のトークンと、チャットで推理の2つの報酬を作り終えた状態にする */
  const prepare = async (env: Env) => {
    await saveToken(env.TOKENS, 'broadcaster', {
      accessToken: 'test-access-token',
      refreshToken: 'リフレッシュトークン',
      expiresAt: NOW + 60 * 60 * 1000,
      userId: BROADCASTER_ID,
      login: 'haishinsha',
      scopes: ['channel:read:redemptions', 'channel:manage:redemptions'],
    })
    await env.STORE.put('chat-deduction-rewards', JSON.stringify({ questionRewardId: QUESTION_REWARD_ID, answerRewardId: ANSWER_REWARD_ID }))
  }

  /**
   * Twitchの報酬の切り替え（PATCH /helix/channel_points/custom_rewards）の代役。切り替えた報酬のIDと値を順に記録する。
   *
   * @param failRewardId 切り替えを断る報酬のID（このアプリが作っていない報酬など）
   */
  const createRewardTwitch = (failRewardId: string | null = null) => {
    const toggles: { rewardId: string | null; isEnabled: unknown }[] = []
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (request.method !== 'PATCH' || url.pathname !== '/helix/channel_points/custom_rewards') throw new Error(`テストで想定していない通信です: ${request.url}`)
      const rewardId = url.searchParams.get('id')
      const { is_enabled: isEnabled } = (await request.json()) as { is_enabled: unknown }
      toggles.push({ rewardId, isEnabled })
      if (rewardId === failRewardId) return Response.json({ error: 'Forbidden', status: 403, message: 'not manageable' }, { status: 403 })
      return Response.json({
        data: [
          {
            id: rewardId,
            title: 'チャットで推理',
            cost: 100,
            prompt: '',
            is_enabled: isEnabled,
            is_user_input_required: false,
            background_color: '#1F6FEB',
            should_redemptions_skip_request_queue: false,
            max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
            max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
            global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
            image: null,
            default_image: { url_1x: 'https://example.com/1.png', url_2x: 'https://example.com/2.png', url_4x: 'https://example.com/4.png' },
          },
        ],
      })
    }
    return { toggles, fetchImpl }
  }

  it('チャンネルポイントで始めたら、問題集から1問選んでゲームを始め、質問・解答を交換できるようにし、始めた報酬は交換できないようにする', async () => {
    const { env, alertChannel } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'reward', rewardId: START_REWARD_ID, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: null }] }],
    })
    const twitch = createRewardTwitch()

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    const game = await readCurrentGame(env.DB)
    // 問題はランダムに選ぶので、選んだ問題集の問題であることだけを確かめる
    expect(ancientPeople.problems.map((problem) => problem.id)).toContain(game?.problemId)
    expect(twitch.toggles).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: true },
      { rewardId: ANSWER_REWARD_ID, isEnabled: true },
      { rewardId: START_REWARD_ID, isEnabled: false },
    ])
    // 終えたら交換できるように戻すため、始めた報酬をゲームに控える
    expect(await readGameStartReward(env.DB, game!.id)).toBe(START_REWARD_ID)
    // 合成ページへ、正解を伏せて押し出す
    expect(alertChannel.pushedChatDeductions).toHaveLength(1)
    expect(alertChannel.pushedChatDeductions[0]?.game).toMatchObject({ id: game!.id, answer: null })
  })

  it('「すべての報酬」の行で「解答」の報酬が交換されて始まったら、その報酬は始めた報酬として止めない（ゲーム中に解答できなくしない）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'reward', rewardId: null, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }] })
    const twitch = createRewardTwitch()
    const answerRedemption = { ...REDEMPTION_NOTIFICATION, event: { ...REDEMPTION_NOTIFICATION.event, user_input: '空海', reward: { id: ANSWER_REWARD_ID, title: 'チャットで推理: 解答', cost: 100 } } }

    await callWebhook(createNotification({ body: answerRedemption }), env, twitch.fetchImpl)

    const game = await readCurrentGame(env.DB)
    expect(game?.problemId).toBe('kukai')
    expect(twitch.toggles).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: true },
      { rewardId: ANSWER_REWARD_ID, isEnabled: true },
    ])
    expect(await readGameStartReward(env.DB, game!.id)).toBeNull()
  })

  it('問題を指定していれば、その問題でゲームを始める', async () => {
    const { env } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'reward', rewardId: START_REWARD_ID, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }],
    })

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, createRewardTwitch().fetchImpl)

    expect((await readCurrentGame(env.DB))?.problemId).toBe('kukai')
  })

  it('問題を指定していれば、直前のゲームと同じ問題でも始める（配信者が選んだ問題を差し替えない）', async () => {
    const { env } = createEnv()
    await prepare(env)
    const previous = await startGame(env.DB, 'kukai', NOW - 60 * 60 * 1000)
    await endGame(env.DB, previous!.id, 'stopped', NOW - 30 * 60 * 1000)
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'reward', rewardId: START_REWARD_ID, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }],
    })

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, createRewardTwitch().fetchImpl)

    expect((await readCurrentGame(env.DB))?.problemId).toBe('kukai')
  })

  it('チャンネルポイントでないトリガーで始めたら、質問・解答だけを交換できるようにする（止める報酬が無い）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'follow', actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }] })
    const twitch = createRewardTwitch()

    await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env, twitch.fetchImpl)

    const game = await readCurrentGame(env.DB)
    expect(game?.problemId).toBe('kukai')
    expect(twitch.toggles).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: true },
      { rewardId: ANSWER_REWARD_ID, isEnabled: true },
    ])
    expect(await readGameStartReward(env.DB, game!.id)).toBeNull()
  })

  it('ほかのゲームが開催中なら、始めずに失敗として記録する（受け取り自体は成功として返す）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await startGame(env.DB, 'himiko', NOW - 60 * 1000)
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'reward', rewardId: START_REWARD_ID, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }],
    })
    const twitch = createRewardTwitch()

    const response = await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, twitch.fetchImpl)

    expect(response.status).toBe(204)
    expect((await readCurrentGame(env.DB))?.problemId).toBe('himiko')
    expect(twitch.toggles).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-start-failed' }])
  })

  it('始めた報酬を交換できないようにできなければ、ゲームを始めなかったことにし、報酬を元に戻して失敗として記録する', async () => {
    const { env, alertChannel } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, {
      triggers: [{ kind: 'reward', rewardId: START_REWARD_ID, actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: 'kukai' }] }],
    })
    // HDAD が作っていない報酬は、Twitch が切り替えを断る
    const twitch = createRewardTwitch(START_REWARD_ID)

    await callWebhook(createNotification({ body: REDEMPTION_NOTIFICATION }), env, twitch.fetchImpl)

    expect(await readCurrentGame(env.DB)).toBeNull()
    // 交換できるようにした質問・解答を戻し、始めた報酬も交換できる状態へ戻す
    expect(twitch.toggles.slice(3)).toEqual([
      { rewardId: QUESTION_REWARD_ID, isEnabled: false },
      { rewardId: ANSWER_REWARD_ID, isEnabled: false },
      { rewardId: START_REWARD_ID, isEnabled: true },
    ])
    expect(alertChannel.pushedChatDeductions).toHaveLength(0)
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-start-failed' }])
  })

  it('チャットで推理の報酬をまだ作っていなければ、始めずに失敗として記録する', async () => {
    const { env } = createEnv()
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'follow', actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: null }] }] })

    await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env)

    expect(await readCurrentGame(env.DB)).toBeNull()
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-start-failed' }])
  })

  it('保存したあとで問題集から消えた問題なら、始めずに失敗として記録する（ほかの問題で黙って始めない）', async () => {
    const { env } = createEnv()
    await prepare(env)
    await saveAlertConfig(env.STORE, { triggers: [{ kind: 'follow', actions: [{ type: 'chatDeduction', setId: 'ancient-people', problemId: '消えた問題' }] }] })
    const twitch = createRewardTwitch()

    await callWebhook(createNotification({ body: FOLLOW_NOTIFICATION }), env, twitch.fetchImpl)

    expect(await readCurrentGame(env.DB)).toBeNull()
    expect(twitch.toggles).toEqual([])
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'chat-deduction-start-failed' }])
  })
})
