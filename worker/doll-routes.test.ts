/**
 * 人形の経路（/api/admin/dolls・/api/admin/doll-current・/api/admin/viewers/:userId/dolls）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - 管理画面（ログイン）から、人形の組を読み・追加し・書き換え・消し、いまの人形を選べること
 * - 検証で拒んだ（名前が空・画像でない素材）・無い組を指した・台帳に記録のある組を消そうとした、をそれぞれ見分けて返すこと
 * - 視聴者に手で人形を渡し・取り上げられ、所持数が足りない・いまの人形が無い・記録の無い視聴者、を見分けて返すこと
 * - 人形の組が使っている画像は、素材のページから消せないこと
 * - 視聴者の記録を消すと、その人の人形の台帳も消えること
 * - チャットで推理・漢字クイズの正解者に渡す人形を、ゲームごとに読み書きできること（issue #420）
 * - 視聴者1人ぶんの所持数と、ランキングを合成ページへ出せること。出せないときは理由を見分けて返すこと
 *
 * 検証の中身は worker/doll.test.ts、読み書きの中身は worker/doll-store.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import type { DollSetInput } from './doll'
import { changeDolls, insertDollSet, readDollHoldings, readDollSets, selectCurrentDollSet } from './doll-store'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { recordViewerMessage } from './viewer-store'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'

/** 視聴者「hanako」の Twitch のユーザー ID */
const HANAKO = '1001'

/** クマの人形の組（画像は setupEnv が置く） */
const bears: DollSetInput = {
  normal: { name: 'クマ人形', mediaId: 'image-bear' },
  super: { name: 'スーパークマ人形', mediaId: 'image-super-bear' },
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

/** 人形の画像2枚と効果音1つをアップロード済みの環境 */
const setupEnv = async () => {
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
    // 人形の経路はタイマーを使わない
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  const image = { httpMetadata: { contentType: 'image/png' } }
  await env.MEDIA.put('image-bear', new ArrayBuffer(8), { ...image, customMetadata: { name: 'bear.png' } })
  await env.MEDIA.put('image-super-bear', new ArrayBuffer(8), { ...image, customMetadata: { name: 'super-bear.png' } })
  await env.MEDIA.put('sound-fanfare', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'fanfare.mp3' } })
  return env
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

const send = (env: Env, method: string, path: string, body?: unknown) =>
  callAsBroadcaster(env, path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

/** 組を追加して、いまの人形にする */
const addCurrentSet = async (env: Env) => {
  const set = await insertDollSet(env.DB, bears, NOW)
  await selectCurrentDollSet(env.DB, set.id)
  return set
}

/** 視聴者「hanako」がチャットで発言した記録を作る */
const recordHanako = (env: Env) =>
  recordViewerMessage(env.DB, { userId: HANAKO, login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-1' }, NOW)

describe('GET /api/admin/dolls', () => {
  it('人形の組と、持っている人の所持数を返す', async () => {
    const env = await setupEnv()
    const set = await addCurrentSet(env)
    await changeDolls(env.DB, { userId: HANAKO, userName: '花子', kind: 'normal', delta: 2, reason: 'manual', sourceId: 'manual-1' }, NOW)

    const response = await callAsBroadcaster(env, '/api/admin/dolls')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      sets: [{ id: set.id, ...bears, current: true, updatedAt: '2026-10-21T12:00:00.000Z' }],
      holdings: [{ userId: HANAKO, setId: set.id, normal: 2, super: 0 }],
    })
  })

  it('ログインしていなければ401にする', async () => {
    const env = await setupEnv()

    expect((await callHandler(new Request(`${SITE}/api/admin/dolls`), env)).status).toBe(401)
  })
})

describe('POST・PUT・DELETE /api/admin/dolls', () => {
  it('組を追加し、書き換え、消せる', async () => {
    const env = await setupEnv()

    const created = await send(env, 'POST', '/api/admin/dolls', bears)
    expect(created.status).toBe(201)
    const [set] = await readDollSets(env.DB)
    expect(await created.json()).toEqual({ set })
    if (set === undefined) throw new Error('組が追加されていません')

    const renamed = { ...bears, normal: { name: 'ちびクマ人形', mediaId: 'image-bear' } }
    const updated = await send(env, 'PUT', `/api/admin/dolls/${set.id}`, renamed)
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ set: { id: set.id, normal: { name: 'ちびクマ人形' } } })

    expect((await send(env, 'DELETE', `/api/admin/dolls/${set.id}`)).status).toBe(204)
    expect(await readDollSets(env.DB)).toEqual([])
  })

  it('名前が空・画像でない素材を指す組は、問題点を添えて400にする', async () => {
    const env = await setupEnv()

    const response = await send(env, 'POST', '/api/admin/dolls', { normal: { name: '', mediaId: 'image-bear' }, super: { name: 'スーパークマ人形', mediaId: 'sound-fanfare' } })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toHaveLength(2)
    expect(await readDollSets(env.DB)).toEqual([])
  })

  it('無い組の書き換え・削除は404にする', async () => {
    const env = await setupEnv()

    expect((await send(env, 'PUT', '/api/admin/dolls/99', bears)).status).toBe(404)
    expect((await send(env, 'DELETE', '/api/admin/dolls/99')).status).toBe(404)
    expect((await send(env, 'DELETE', '/api/admin/dolls/abc')).status).toBe(404)
  })

  it('台帳に記録のある組は消さず、409にする', async () => {
    const env = await setupEnv()
    const set = await addCurrentSet(env)
    await changeDolls(env.DB, { userId: HANAKO, userName: '花子', kind: 'normal', delta: 1, reason: 'manual', sourceId: 'manual-1' }, NOW)

    const response = await send(env, 'DELETE', `/api/admin/dolls/${set.id}`)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'doll-set-in-use' } })
    expect(await readDollSets(env.DB)).toHaveLength(1)
  })
})

describe('PUT /api/admin/doll-current', () => {
  it('いまの人形を選び、組の一覧を返す。null で外せる', async () => {
    const env = await setupEnv()
    const set = await insertDollSet(env.DB, bears, NOW)

    const selected = await send(env, 'PUT', '/api/admin/doll-current', { setId: set.id })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toEqual({ sets: [{ ...set, current: true }] })

    const cleared = await send(env, 'PUT', '/api/admin/doll-current', { setId: null })
    expect(await cleared.json()).toEqual({ sets: [{ ...set, current: false }] })
  })

  it('無い組は404、ID でも null でもない指定は400にする', async () => {
    const env = await setupEnv()

    expect((await send(env, 'PUT', '/api/admin/doll-current', { setId: 99 })).status).toBe(404)
    expect((await send(env, 'PUT', '/api/admin/doll-current', { setId: 'クマ' })).status).toBe(400)
  })
})

describe('GET・PUT /api/admin/doll-prizes/:game', () => {
  it('保存する前は、どのゲームも正解者に人形を渡さない（なし）', async () => {
    const env = await setupEnv()

    const response = await send(env, 'GET', '/api/admin/doll-prizes/chatDeduction')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kind: null })
  })

  it('ゲームごとに保存し、保存したものを返す（片方を保存しても、もう片方は変わらない）', async () => {
    const env = await setupEnv()

    const saved = await send(env, 'PUT', '/api/admin/doll-prizes/kanjiQuiz', { kind: 'super' })

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ kind: 'super' })
    expect(await (await send(env, 'GET', '/api/admin/doll-prizes/kanjiQuiz')).json()).toEqual({ kind: 'super' })
    expect(await (await send(env, 'GET', '/api/admin/doll-prizes/chatDeduction')).json()).toEqual({ kind: null })
  })

  it('知らない種類は問題点を添えて400、知らないゲームは404にする', async () => {
    const env = await setupEnv()

    const invalid = await send(env, 'PUT', '/api/admin/doll-prizes/chatDeduction', { kind: 'golden' })
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as { error: { problems: string[] } }).error.problems).toHaveLength(1)
    expect((await send(env, 'GET', '/api/admin/doll-prizes/bingo')).status).toBe(404)
    expect((await send(env, 'PUT', '/api/admin/doll-prizes/bingo', { kind: 'normal' })).status).toBe(404)
  })

  it('ログインしていなければ401にする', async () => {
    const env = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/doll-prizes/chatDeduction`), env)

    expect(response.status).toBe(401)
  })
})

describe('POST /api/admin/viewers/:userId/dolls', () => {
  it('視聴者にいまの人形を渡し・取り上げ、増減したあとの所持数を返す', async () => {
    const env = await setupEnv()
    const set = await addCurrentSet(env)
    await recordHanako(env)

    const given = await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'super', delta: 1 })
    expect(given.status).toBe(200)
    expect(await given.json()).toEqual({ holding: { userId: HANAKO, setId: set.id, normal: 0, super: 1 } })

    const taken = await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'super', delta: -1 })
    expect(await taken.json()).toEqual({ holding: { userId: HANAKO, setId: set.id, normal: 0, super: 0 } })
  })

  it('台帳には、視聴者の記録の表示名を控える', async () => {
    const env = await setupEnv()
    await addCurrentSet(env)
    await recordHanako(env)

    await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'normal', delta: 1 })

    expect(env.DB.sqlite.prepare('SELECT user_name FROM doll_ledger').all()).toEqual([{ user_name: '花子' }])
  })

  it('持っている数より多く取り上げようとしたら409にし、記録しない', async () => {
    const env = await setupEnv()
    await addCurrentSet(env)
    await recordHanako(env)

    const response = await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'normal', delta: -1 })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'not-enough' } })
    expect(await readDollHoldings(env.DB)).toEqual([])
  })

  it('いまの人形を選んでいなければ409にする', async () => {
    const env = await setupEnv()
    await insertDollSet(env.DB, bears, NOW)
    await recordHanako(env)

    const response = await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'normal', delta: 1 })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'no-current-set' } })
  })

  it('記録の無い視聴者は404、形の違う増減は400にする', async () => {
    const env = await setupEnv()
    await addCurrentSet(env)
    await recordHanako(env)

    expect((await send(env, 'POST', '/api/admin/viewers/9999/dolls', { kind: 'normal', delta: 1 })).status).toBe(404)
    expect((await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls`, { kind: 'normal', delta: 0 })).status).toBe(400)
    expect(await readDollHoldings(env.DB)).toEqual([])
  })
})

describe('ほかの経路とのつながり', () => {
  it('人形の組が使っている画像は、素材のページから消せない', async () => {
    const env = await setupEnv()
    await insertDollSet(env.DB, bears, NOW)

    const response = await send(env, 'DELETE', '/api/admin/media/image-super-bear')

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'media-in-use' } })
    expect(env.MEDIA.entries.has('image-super-bear')).toBe(true)
  })

  it('視聴者の記録を消すと、その人の人形の台帳も消える', async () => {
    const env = await setupEnv()
    await addCurrentSet(env)
    await recordHanako(env)
    await changeDolls(env.DB, { userId: HANAKO, userName: '花子', kind: 'normal', delta: 1, reason: 'manual', sourceId: 'manual-1' }, NOW)

    expect((await send(env, 'DELETE', `/api/admin/viewers/${HANAKO}`)).status).toBe(204)
    expect(await readDollHoldings(env.DB)).toEqual([])
  })
})

describe('GET /api/overlay/doll-award/socket', () => {
  /** オーバーレイ用キー（合成ページのURLに入っているもの） */
  const OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'

  /** 合成ページとして接続する（ログインはしない） */
  const connect = (env: Env, key: string, headers: Record<string, string> = { Upgrade: 'websocket' }) =>
    callHandler(new Request(`${SITE}/api/overlay/doll-award/socket?key=${key}`, { headers }), env)

  it('オーバーレイ用キーが違えば断る', async () => {
    const env = await setupEnv()
    await env.STORE.put('overlay-key', OVERLAY_KEY)

    const response = await connect(env, 'wrong-key-0123456789abcdefghijklmn')

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続でなければ400にする', async () => {
    const env = await setupEnv()
    await env.STORE.put('overlay-key', OVERLAY_KEY)

    const response = await connect(env, OVERLAY_KEY, {})

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、人形の獲得を受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = { ...(await setupEnv()), ALERTS: alertChannel.namespace }
    await env.STORE.put('overlay-key', OVERLAY_KEY)

    const response = await connect(env, OVERLAY_KEY)

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['dollAward'])
  })
})

/** 押し出しを確かめられる配送先と、発行済みのオーバーレイ用キーを持つ環境 */
const setupShowEnv = async (options: { shouldFail?: boolean } = {}) => {
  const alerts = createFakeAlertChannel(options)
  const env = { ...(await setupEnv()), ALERTS: alerts.namespace }
  await env.STORE.put('overlay-key', 'secret')
  return { env, alerts }
}

describe('POST /api/admin/viewers/:userId/dolls/show', () => {
  it('その視聴者のいまの人形の所持数を、視聴者の記録の表示名で合成ページへ出し、204を返す', async () => {
    // 前提: 花子はふつうの人形を2つ持っている
    const { env, alerts } = await setupShowEnv()
    await addCurrentSet(env)
    await recordHanako(env)
    await changeDolls(env.DB, { userId: HANAKO, userName: '花子', kind: 'normal', delta: 2, reason: 'manual', sourceId: 'manual-1' }, NOW)

    const response = await send(env, 'POST', `/api/admin/viewers/${HANAKO}/dolls/show`)

    expect(response.status).toBe(204)
    expect(alerts.pushedDollAwards).toEqual([
      expect.objectContaining({ type: 'standing', userName: '花子', normal: expect.objectContaining({ count: 2 }), super: expect.objectContaining({ count: 0 }) }),
    ])
  })

  it('記録の無い視聴者は404、いまの人形が無ければ409、配送先が失敗したら502にする', async () => {
    const empty = await setupShowEnv()
    await addCurrentSet(empty.env)
    expect((await send(empty.env, 'POST', `/api/admin/viewers/${HANAKO}/dolls/show`)).status).toBe(404)

    const noCurrent = await setupShowEnv()
    await recordHanako(noCurrent.env)
    const conflict = await send(noCurrent.env, 'POST', `/api/admin/viewers/${HANAKO}/dolls/show`)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'no-current-set' } })

    const failing = await setupShowEnv({ shouldFail: true })
    await addCurrentSet(failing.env)
    await recordHanako(failing.env)
    const badGateway = await send(failing.env, 'POST', `/api/admin/viewers/${HANAKO}/dolls/show`)
    expect(badGateway.status).toBe(502)
    expect(await badGateway.json()).toMatchObject({ error: { code: 'doll-show-failed' } })
  })
})

describe('POST /api/admin/doll-ranking/show', () => {
  it('いまの人形のランキングを合成ページへ出し、204を返す', async () => {
    const { env, alerts } = await setupShowEnv()
    await addCurrentSet(env)
    await changeDolls(env.DB, { userId: HANAKO, userName: '花子', kind: 'super', delta: 1, reason: 'manual', sourceId: 'manual-1' }, NOW)

    const response = await send(env, 'POST', '/api/admin/doll-ranking/show')

    expect(response.status).toBe(204)
    expect(alerts.pushedDollAwards).toEqual([
      expect.objectContaining({ type: 'ranking', entries: [{ rank: 1, userName: '花子', normal: 0, super: 1, points: 3 }] }),
    ])
  })

  it('いまの人形が無ければ409にする', async () => {
    const { env } = await setupShowEnv()

    const response = await send(env, 'POST', '/api/admin/doll-ranking/show')

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'no-current-set' } })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = await setupShowEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/doll-ranking/show`, { method: 'POST', headers: { Origin: SITE } }), env)

    expect(response.status).toBe(401)
  })
})
