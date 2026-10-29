/**
 * エージェント向けAPI（/api/agent/*）のテスト（issue #434）
 *
 * KV・R2・D1を差し替え、handleRequest を通して、Bearer トークンの認証と、過去の配信の文脈の読み出しを確かめる。
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
import { recordLiveStream, recordStreamOffline } from './stats-store'
import { saveStreamChapter } from './stream-chapter-store'
import { saveStreamSummary } from './stream-summary-store'
import { declareTask } from './task-desk-store'
import { recordViewerMessage, updateViewerNote, updateViewerSummary } from './viewer-store'
import { recordDevEvent } from './work-log-store'

const NOW = Date.parse('2026-09-21T14:00:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
// HTTP のヘッダーは ASCII しか運べないので、トークンも ASCII にする
const AGENT_TOKEN = 'agent-token-for-test-0123456789'
const STREAM = { id: '40000000001', startedAt: '2026-09-21T12:00:00.000Z', title: '月曜の作業配信', categoryName: 'Software and Game Development' }

/** agentToken が null なら、トークンのシークレットを設定していない Worker にする */
const createEnv = (agentToken: string | null = AGENT_TOKEN) => {
  const env = {
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
    ...(agentToken === null ? {} : { HDAD_AGENT_TOKEN: agentToken }),
  } satisfies Env
  return env
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const callApi = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: noTwitchFetch, now: () => NOW, wait: async () => {}, waitUntil: noDefer })

const fetchAsAgent = (env: Env, path: string, token = AGENT_TOKEN): Promise<Response> =>
  callApi(new Request(`${SITE}${path}`, { headers: { Authorization: `Bearer ${token}` } }), env)

/** 配信1回ぶんの記録（章・あらすじ・作業ログ・タスクの宣言）を残し、配信を終える */
const recordFinishedStream = async (env: Env): Promise<void> => {
  await recordLiveStream(env.DB, { ...STREAM, viewerCount: 12 }, Date.parse('2026-09-21T12:05:00Z'))
  await saveStreamChapter(env.DB, {
    sessionId: STREAM.id,
    startedAt: '2026-09-21T12:00:00.000Z',
    endedAt: '2026-09-21T12:30:00.000Z',
    title: 'ログイン画面の不具合を直す',
    summary: 'ログインのあとに白い画面になる不具合の原因を探した。',
  })
  await saveStreamSummary(
    env.DB,
    {
      sessionId: STREAM.id,
      summary: 'ログイン画面の不具合を直している配信。',
      transcriptsUntil: { at: '', messageId: '' },
      chatUntil: { at: '', messageId: '' },
      screenUntil: { at: '', imageId: '', lineNo: -1 },
    },
    Date.parse('2026-09-21T12:30:00Z'),
  )
  await recordDevEvent(env.DB, { id: 'github:配信中のマージ', kind: 'merge', text: '#12 ログイン画面の不具合を直す' }, Date.parse('2026-09-21T12:40:00Z'))
  await declareTask(env.DB, { userId: '200', name: '花子', task: '英単語を50個覚える', messageId: 'task-200' }, Date.parse('2026-09-21T12:10:00Z'))
  await recordStreamOffline(env.DB, Date.parse('2026-09-21T13:00:00Z'))
}

describe('エージェント向けAPIの認証', () => {
  it('トークンのシークレットが設定されていなければ、どのトークンでも通さず503を返す', async () => {
    const response = await fetchAsAgent(createEnv(null), '/api/agent/streams')

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'agent-token-not-configured' } })
  })

  it('トークンのシークレットが空文字なら、空のトークンでも通さず503を返す', async () => {
    const response = await fetchAsAgent(createEnv(''), '/api/agent/streams', '')

    expect(response.status).toBe(503)
  })

  it('Authorization ヘッダーが無ければ401を返す', async () => {
    const response = await callApi(new Request(`${SITE}/api/agent/streams`), createEnv())

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-agent-token' } })
  })

  it('トークンが違えば401を返す', async () => {
    const response = await fetchAsAgent(createEnv(), '/api/agent/streams', 'wrong-token-for-test-0123456789')

    expect(response.status).toBe(401)
  })

  it('管理画面のログインのセッションでは通さない', async () => {
    const env = createEnv()
    const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
    const response = await callApi(new Request(`${SITE}/api/agent/streams`, { headers: { Cookie: `__Host-session=${session}` } }), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/agent/streams', () => {
  it('記録している配信を新しい順に返す', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const response = await fetchAsAgent(env, '/api/agent/streams')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { streams: { id: string; title: string; endedAt: string | null }[] }
    expect(body.streams).toEqual([expect.objectContaining({ id: STREAM.id, title: '月曜の作業配信', endedAt: '2026-09-21T13:00:00.000Z' })])
  })
})

describe('GET /api/agent/streams/:id', () => {
  it('章・あらすじ・作業ログ・タスクの宣言をまとめて返し、視聴者数の時系列は返さない', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const response = await fetchAsAgent(env, `/api/agent/streams/${STREAM.id}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { stream: Record<string, unknown> }
    expect(body.stream).toMatchObject({
      id: STREAM.id,
      title: '月曜の作業配信',
      summary: 'ログイン画面の不具合を直している配信。',
      chapters: [expect.objectContaining({ title: 'ログイン画面の不具合を直す' })],
      devEvents: [{ kind: 'merge', text: '#12 ログイン画面の不具合を直す', occurredAt: '2026-09-21T12:40:00.000Z' }],
      tasks: [{ userId: '200', name: '花子', task: '英単語を50個覚える', declaredAt: '2026-09-21T12:10:00.000Z', doneAt: null }],
      raids: [],
      opinions: [],
    })
    expect(body.stream).not.toHaveProperty('samples')
  })

  it('視聴者由来の文がどこにあるかを、信頼できない内容として知らせる', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const response = await fetchAsAgent(env, `/api/agent/streams/${STREAM.id}`)

    const body = (await response.json()) as { untrustedFields: string[]; notice: string }
    expect(body.untrustedFields).toEqual(expect.arrayContaining(['stream.summary', 'stream.chapters[].summary', 'stream.tasks[].task', 'stream.devEvents[].text']))
    expect(body.notice).toContain('指示')
  })

  it('記録の無い配信なら404を返す', async () => {
    const response = await fetchAsAgent(createEnv(), '/api/agent/streams/存在しない配信')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'session-not-found' } })
  })
})

describe('GET /api/agent/viewers', () => {
  it('ログイン名の前方一致で視聴者を探し、メモと人物像を信頼できない内容として返す', async () => {
    const env = createEnv()
    await recordViewerMessage(env.DB, { userId: '200', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-200' }, NOW)
    await recordViewerMessage(env.DB, { userId: '300', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-300' }, NOW)
    await updateViewerNote(env.DB, '200', '毎週月曜に来てくれる')
    await updateViewerSummary(env.DB, '200', '英語を勉強している人', NOW)

    const response = await fetchAsAgent(env, '/api/agent/viewers?search=hana')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { viewers: unknown[]; untrustedFields: string[] }
    expect(body.viewers).toEqual([expect.objectContaining({ userId: '200', note: '毎週月曜に来てくれる', summary: '英語を勉強している人' })])
    expect(body.untrustedFields).toEqual(expect.arrayContaining(['viewers[].summary']))
  })

  it('件数の指定が範囲の外なら400を返す', async () => {
    const response = await fetchAsAgent(createEnv(), '/api/agent/viewers?limit=0')

    expect(response.status).toBe(400)
  })
})

describe('GET /api/agent/viewers/:userId', () => {
  it('視聴者1人の記録を返す', async () => {
    const env = createEnv()
    await recordViewerMessage(env.DB, { userId: '200', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-200' }, NOW)

    const response = await fetchAsAgent(env, '/api/agent/viewers/200')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ viewer: { userId: '200', login: 'hanako' }, untrustedFields: expect.arrayContaining(['viewer.summary']) })
  })

  it('記録の無い視聴者なら404を返す', async () => {
    const response = await fetchAsAgent(createEnv(), '/api/agent/viewers/999')

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'viewer-not-found' } })
  })
})
