/**
 * 意見ボードの経路（/api/admin/opinions・/api/overlay/opinions）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - 管理画面（ログイン）から、テーマを開き・締め切り、意見を隠せること。変えるたびに合成ページへ意見ボードを丸ごと押し出すこと
 * - テーマを開いたら振り分けのアラームを仕掛け、締め切ったら外すこと
 * - ほかのテーマが開いているのに開こうとした・開いていないテーマを締め切ろうとした・無い意見を指した、を見分けて返すこと
 * - 押し出しに失敗したら、保存は済んだことを添えて502にすること（黙って成功にしない）
 * - 合成ページ（オーバーレイ用キー）から、人数を含まない意見ボードを読めること
 *
 * 読み書きの中身は worker/opinion-store.test.ts、振り分けの中身は worker/opinion-run.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createTimerInstances } from './fake-timer-instances'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { MAX_THEME_LENGTH } from './opinion'
import { applySorting, openTheme, readPendingComments, readSortingBoard, recordOpinionComment } from './opinion-store'
import { OPINION_SORT_INTERVAL_MS } from './opinion-timer'
import { createSessionToken } from './session'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/**
 * テーマを1つも開いていない環境。
 *
 * @param failPush 配送先が失敗を返すようにする（押し出しの失敗を確かめるとき）
 */
const setupEnv = (failPush = false) => {
  const channel = createFakeAlertChannel({ shouldFail: failPush })
  const env = {
    STORE: createFakeStore({ 'overlay-key': ISSUED_KEY }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: channel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  const timers = createTimerInstances(() => env, { fetch: noTwitchFetch, now: () => NOW, wait: async () => {} }, () => {})
  env.AD_BREAKS = timers.namespace
  return { env, channel, timers }
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, {
    fetch: noTwitchFetch,
    now: () => NOW,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = SITE
  return callHandler(new Request(`${SITE}${path}`, { ...init, headers }), env)
}

const postTheme = (env: Env, body: unknown) => callAsBroadcaster(env, '/api/admin/opinions/themes', { method: 'POST', body: JSON.stringify(body) })
const closeThemeRoute = (env: Env, id: number | string) => callAsBroadcaster(env, `/api/admin/opinions/themes/${id}/close`, { method: 'POST' })
const putOpinion = (env: Env, id: number | string, body: unknown) => callAsBroadcaster(env, `/api/admin/opinions/items/${id}`, { method: 'PUT', body: JSON.stringify(body) })

/** テーマを開き、1件の意見を作っておく */
const prepareOpinion = async (db: Env['DB']) => {
  const theme = await openTheme(db, '配信中にAIをどこまで使っていい？', NOW)
  if (theme === null) throw new Error('テーマを開けませんでした')
  await recordOpinionComment(db, { messageId: 'm1', userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しは寂しい', replyName: null, replyText: null, dropReason: null }, NOW)
  const [comment] = await readPendingComments(db, theme.id)
  if (comment === undefined) throw new Error('コメントが貯まっていません')
  await applySorting(db, theme.id, [{ type: 'new', commentIds: [comment.id], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: 'AIの返事は寂しい' }], NOW)
  const opinionId = (await readSortingBoard(db, theme.id))[0]?.opinions[0]?.id
  if (opinionId === undefined) throw new Error('意見を作れませんでした')
  return { theme, opinionId }
}

describe('POST /api/admin/opinions/themes', () => {
  it('テーマを開き、振り分けのアラームを仕掛けて、意見ボードを押し出す', async () => {
    const { env, channel, timers } = setupEnv()

    const response = await postTheme(env, { title: '配信中にAIをどこまで使っていい？' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ theme: { id: expect.any(Number), title: '配信中にAIをどこまで使っていい？', openedAt: new Date(NOW).toISOString(), closedAt: null } })
    expect(timers.alarmOf('opinions')).toBe(NOW + OPINION_SORT_INTERVAL_MS)
    expect(channel.pushedOpinions.map(({ theme }) => theme?.title)).toEqual(['配信中にAIをどこまで使っていい？'])
  })

  it('ほかのテーマが開いていれば409にする', async () => {
    const { env } = setupEnv()
    await postTheme(env, { title: '最初のテーマ' })

    const response = await postTheme(env, { title: '次のテーマ' })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'opinion-theme-open' } })
  })

  it('テーマが上限を超えていれば400にする', async () => {
    const { env } = setupEnv()
    const response = await postTheme(env, { title: 'あ'.repeat(MAX_THEME_LENGTH + 1) })
    expect(response.status).toBe(400)
  })

  it('押し出しに失敗したら、開いたことを添えて502にする', async () => {
    const { env } = setupEnv(true)
    const response = await postTheme(env, { title: '配信中にAIをどこまで使っていい？' })
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'opinion-push-failed' } })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = setupEnv()
    const response = await callHandler(new Request(`${SITE}/api/admin/opinions/themes`, { method: 'POST', body: '{}', headers: { Origin: SITE } }), env)
    expect(response.status).toBe(401)
  })
})

describe('POST /api/admin/opinions/themes/:id/close', () => {
  it('テーマを締め切り、振り分けのアラームを外して、意見ボードを押し出す', async () => {
    const { env, channel, timers } = setupEnv()
    const opened = (await (await postTheme(env, { title: '配信中にAIをどこまで使っていい？' })).json()) as { theme: { id: number } }

    const response = await closeThemeRoute(env, opened.theme.id)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ theme: { id: opened.theme.id, closedAt: new Date(NOW).toISOString() } })
    expect(timers.alarmOf('opinions')).toBeNull()
    expect(channel.pushedOpinions.at(-1)?.theme?.closedAt).toBe(new Date(NOW).toISOString())
  })

  it('開いていないテーマなら404にする', async () => {
    const { env } = setupEnv()
    expect((await closeThemeRoute(env, 99)).status).toBe(404)
    expect((await closeThemeRoute(env, 'abc')).status).toBe(404)
  })
})

describe('GET /api/admin/opinions', () => {
  it('人数ともとのコメントを添えた意見ボードを返す', async () => {
    const { env } = setupEnv()
    await prepareOpinion(env.DB)

    const response = await callAsBroadcaster(env, '/api/admin/opinions')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { topics: { opinions: unknown[] }[] }
    expect(body.topics[0]?.opinions[0]).toMatchObject({ text: 'AIの返事は寂しい', people: 1, hidden: false, sources: [{ userName: 'aoi', text: 'AIのコメ返しは寂しい' }] })
  })
})

describe('PUT /api/admin/opinions/items/:id', () => {
  it('意見を隠し、隠したあとの意見ボードを押し出す', async () => {
    const { env, channel } = setupEnv()
    const { opinionId } = await prepareOpinion(env.DB)

    const response = await putOpinion(env, opinionId, { hidden: true })

    expect(response.status).toBe(204)
    expect(channel.pushedOpinions.at(-1)?.topics[0]?.opinions).toEqual([])
  })

  it('hidden が真偽値でなければ400、無い意見なら404にする', async () => {
    const { env } = setupEnv()
    const { opinionId } = await prepareOpinion(env.DB)
    expect((await putOpinion(env, opinionId, { hidden: 'yes' })).status).toBe(400)
    expect((await putOpinion(env, opinionId + 100, { hidden: true })).status).toBe(404)
  })
})

describe('GET /api/overlay/opinions', () => {
  it('オーバーレイ用キーで、人数を含まない意見ボードを読める', async () => {
    const { env } = setupEnv()
    await prepareOpinion(env.DB)

    const response = await callHandler(new Request(`${SITE}/api/overlay/opinions?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { topics: { opinions: Record<string, unknown>[] }[] }
    expect(body.topics[0]?.opinions[0]).toEqual({ id: expect.any(Number), kind: 'issue', text: 'AIの返事は寂しい', author: 'aoi', createdAt: new Date(NOW).toISOString() })
  })

  it('キーが違えば401にする', async () => {
    const { env } = setupEnv()
    const response = await callHandler(new Request(`${SITE}/api/overlay/opinions?key=wrong-key`), env)
    expect(response.status).toBe(401)
  })
})
