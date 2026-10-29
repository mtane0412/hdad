/**
 * エージェント向けAPIの MCP の入口（POST /mcp）のテスト（issue #435）
 *
 * KV・R2・D1を差し替え、handleRequest を通して、JSON-RPC の受け答え（初期化・ツールの一覧・ツールの呼び出し）と、
 * REST と同じ Bearer トークンの認証・同じ読み出しの中身を確かめる。
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
import { recordLiveStream, recordStreamOffline } from './stats-store'
import { saveStreamSummary } from './stream-summary-store'
import { recordViewerMessage, updateViewerSummary } from './viewer-store'

const NOW = Date.parse('2026-09-21T14:00:00Z')
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
    TWITCH_BROADCASTER_ID: '12345',
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

/** /mcp へ JSON-RPC のメッセージ（本文の文字列）を送る */
const postRaw = (env: Env, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  callApi(
    new Request(`${SITE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    }),
    env,
  )

const postMessage = (env: Env, message: unknown, headers?: Record<string, string>): Promise<Response> => postRaw(env, JSON.stringify(message), headers)

interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}

/** tools/call を送り、結果（result）を返す */
const callTool = async (env: Env, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const response = await postMessage(env, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { result: ToolResult }
  return body.result
}

/** ツールの結果の本文（JSON の文字列）を読む */
const readToolJson = (result: ToolResult): Record<string, unknown> => JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>

/** あらすじのある配信を1回ぶん残し、配信を終える */
const recordFinishedStream = async (env: Env): Promise<void> => {
  await recordLiveStream(env.DB, { ...STREAM, viewerCount: 12 }, Date.parse('2026-09-21T12:05:00Z'))
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
  await recordStreamOffline(env.DB, Date.parse('2026-09-21T13:00:00Z'))
}

describe('POST /mcp の認証', () => {
  it('トークンのシークレットが設定されていなければ503を返す', async () => {
    const response = await postMessage(createEnv(null), { jsonrpc: '2.0', id: 1, method: 'ping' })

    expect(response.status).toBe(503)
  })

  it('トークンが違えば401を返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 1, method: 'ping' }, { Authorization: 'Bearer wrong-token-for-test-0123456789' })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid-agent-token' } })
  })

  it('別のサイトのページから送られた要求（Origin が違う）は403で断る', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example.com' })

    expect(response.status).toBe(403)
  })

  it('GET では受けない（通知の流れは持たない）', async () => {
    const response = await callApi(new Request(`${SITE}/mcp`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }), createEnv())

    expect(response.status).toBe(405)
  })
})

describe('POST /mcp の JSON-RPC', () => {
  it('initialize には、求められた版とツールを持つことを返す', async () => {
    const response = await postMessage(createEnv(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'テスト用のクライアント', version: '1.0.0' } },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hdad' } },
    })
  })

  it('知らない版を求められたら、こちらの最新の版を返す', async () => {
    const response = await postMessage(createEnv(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'テスト用のクライアント', version: '1.0.0' } },
    })

    const body = (await response.json()) as { result: { protocolVersion: string } }
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('通知（id の無いメッセージ）には本文なしの202を返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', method: 'notifications/initialized' })

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it('ping には空の結果を返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 'ping-1', method: 'ping' })

    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 'ping-1', result: {} })
  })

  it('知らないメソッドには -32601 を返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 1, method: 'resources/list' })

    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32601 } })
  })

  it('JSON として読めない本文には、400と -32700 を返す', async () => {
    const response = await postRaw(createEnv(), '{読めない')

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } })
  })

  it('JSON-RPC の形でない本文（まとめ送りを含む）には、400と -32600 を返す', async () => {
    const response = await postMessage(createEnv(), [{ jsonrpc: '2.0', id: 1, method: 'ping' }])

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: -32600 } })
  })

  it('tools/list には5つの読み取り専用のツールを返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })

    const body = (await response.json()) as { result: { tools: { name: string; inputSchema: unknown; annotations: unknown }[] } }
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['list_streams', 'get_stream', 'search_chapters', 'search_viewers', 'get_viewer'])
    for (const tool of body.result.tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
      expect(tool.annotations).toMatchObject({ readOnlyHint: true })
    }
  })

  it('知らないツールの呼び出しには -32602 を返す', async () => {
    const response = await postMessage(createEnv(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_stream', arguments: {} } })

    expect(await response.json()).toMatchObject({ error: { code: -32602 } })
  })
})

describe('MCP のツール', () => {
  it('list_streams は REST と同じ配信の一覧を返す', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const result = await callTool(env, 'list_streams')

    expect(result.isError).toBeUndefined()
    expect(readToolJson(result)).toMatchObject({ streams: [expect.objectContaining({ id: STREAM.id, title: '月曜の作業配信' })] })
  })

  it('get_stream は配信1回ぶんの文脈を、信頼できない欄の印とともに返す', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const result = await callTool(env, 'get_stream', { id: STREAM.id })

    expect(readToolJson(result)).toMatchObject({
      stream: { id: STREAM.id, summary: 'ログイン画面の不具合を直している配信。' },
      untrustedFields: expect.arrayContaining(['stream.summary']),
      notice: expect.stringContaining('指示'),
    })
  })

  it('get_stream で記録の無い配信を指したら、ツールの失敗として理由を返す', async () => {
    const result = await callTool(createEnv(), 'get_stream', { id: '存在しない配信' })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('存在しない配信')
  })

  it('get_stream の件数の上限が範囲の外なら、ツールの失敗にする', async () => {
    const result = await callTool(createEnv(), 'get_stream', { id: STREAM.id, limit: 0 })

    expect(result.isError).toBe(true)
  })

  it('引数の型が違えば、ツールの失敗としてどの引数かを返す', async () => {
    const result = await callTool(createEnv(), 'get_stream', { id: 40000000001 })

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('id')
  })

  it('search_viewers はログイン名の前方一致で視聴者を探す', async () => {
    const env = createEnv()
    await recordViewerMessage(env.DB, { userId: '200', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-200' }, NOW)
    await recordViewerMessage(env.DB, { userId: '300', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-300' }, NOW)
    await updateViewerSummary(env.DB, '200', '英語を勉強している人', NOW)

    const result = await callTool(env, 'search_viewers', { search: 'hana', limit: 10 })

    expect(readToolJson(result)).toMatchObject({
      viewers: [expect.objectContaining({ userId: '200', summary: '英語を勉強している人' })],
      untrustedFields: expect.arrayContaining(['viewers[].summary']),
    })
  })

  it('get_viewer は視聴者1人の記録を返す', async () => {
    const env = createEnv()
    await recordViewerMessage(env.DB, { userId: '200', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-200' }, NOW)

    const result = await callTool(env, 'get_viewer', { userId: '200' })

    expect(readToolJson(result)).toMatchObject({ viewer: { userId: '200', login: 'hanako' } })
  })

  it('get_viewer で必須の userId が無ければ、ツールの失敗にする', async () => {
    const result = await callTool(createEnv(), 'get_viewer', {})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('userId')
  })
})

describe('MCP のツール search_chapters', () => {
  it('あらすじからキーワードを含むものを、信頼できない欄の印とともに返す', async () => {
    const env = createEnv()
    await recordFinishedStream(env)

    const result = await callTool(env, 'search_chapters', { search: 'ログイン' })

    expect(result.isError).toBeUndefined()
    expect(readToolJson(result)).toMatchObject({
      summaries: [{ streamId: STREAM.id, summary: 'ログイン画面の不具合を直している配信。' }],
      untrustedFields: expect.arrayContaining(['summaries[].summary']),
    })
  })

  it('必須の search が無ければ、ツールの失敗にする', async () => {
    const result = await callTool(createEnv(), 'search_chapters', {})

    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('search')
  })
})
