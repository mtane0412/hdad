/**
 * 作業机の経路（GET /api/overlay/task-desk・GET /api/overlay/task-desk/socket）のテスト
 *
 * KV・D1・アラートの配送先を差し替え、handleRequest を通して確かめる。特に重要なのは次の点である。
 * - オーバーレイ用キーが無ければ読めないこと（配信画面に映すものだが、URLを知らない人には読ませない）
 * - 合成ページが開き直したときに、いまの配信の作業机を取り戻せること
 * - WebSocketの接続は、作業机を受け取る接続（目印 taskDesk）として配送先へ引き渡すこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { handleRequest, type Env } from './index'
import { recordLiveStream } from './stats-store'
import { declareTask } from './task-desk-store'

const NOW = Date.parse('2026-10-03T13:00:00Z')
const SITE = 'https://hdad.example.com'
const OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'
/** いま配信中の区切り（12:00 に始めた配信） */
const LIVE_STREAM = { id: '40000000001', startedAt: '2026-10-03T12:00:00.000Z', title: '作業配信', categoryName: 'Software and Game Development', viewerCount: 10 }

const createEnv = () => {
  const db = createFakeDatabase()
  const alertChannel = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': OVERLAY_KEY }),
    MEDIA: createFakeBucket(),
    DB: db,
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のEventSubのシークレット',
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, db, alertChannel }
}

const noFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: noFetch, now: () => NOW, wait: async () => {}, waitUntil: () => {} })

describe('GET /api/overlay/task-desk', () => {
  it('いまの配信の作業机と、作業した時間の合計を返す', async () => {
    const { env, db } = createEnv()
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 60 * 1000)
    await declareTask(db, { userId: '11111', name: 'たなか', task: '英単語を50個覚える', messageId: 'chat-message-1' }, Date.parse('2026-10-03T12:40:00Z'))

    const response = await callHandler(new Request(`${SITE}/api/overlay/task-desk?key=${OVERLAY_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      entries: [{ userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:40:00.000Z', doneAt: null }],
      // たなかが 12:40 に宣言してから、いま（NOW）までの時間
      workTime: { people: 1, totalMs: NOW - Date.parse('2026-10-03T12:40:00Z'), working: 1, measuredAt: new Date(NOW).toISOString() },
    })
  })

  it('配信していなければ、失敗にせず空の一覧を返す', async () => {
    const { env } = createEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/task-desk?key=${OVERLAY_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entries: [], workTime: null })
  })

  it('オーバーレイ用キーが違えば401にする', async () => {
    const { env } = createEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/task-desk?key=chigau-key`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/task-desk/socket', () => {
  it('作業机を受け取る接続として配送先へ引き渡す', async () => {
    const { env, alertChannel } = createEnv()

    await callHandler(new Request(`${SITE}/api/overlay/task-desk/socket?key=${OVERLAY_KEY}`, { headers: { Upgrade: 'websocket' } }), env)

    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['taskDesk'])
  })

  it('WebSocketでなければ400にする', async () => {
    const { env } = createEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/task-desk/socket?key=${OVERLAY_KEY}`), env)

    expect(response.status).toBe(400)
  })
})
