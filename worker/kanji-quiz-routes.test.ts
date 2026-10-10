/**
 * 漢字クイズの経路（kanji-quiz-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/kanji-quiz/socket）は、漢字クイズを受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/kanji-quiz/demo）は、ログインした配信者にだけ、本文の級の問題を1問選んで押し出す。
 *   級が無い・知らない値なら400にして押し出さない。配送先の失敗は502にする。同じ配信で選べる問題が尽きたら409にする
 * - 出題を開く（POST /api/overlay/kanji-quiz/open）は、合成ページが流しはじめたときに呼び、Worker が選んだ出題の行に受付期限を書く。
 *   選んでいない出題の識別子なら404にする（合成ページから熟語を受け取って作らない）
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage } from '../src/kanji-quiz/call'
import { GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
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
import { createFakeTokenVault } from './fake-token-vault'
import { answerKanjiQuiz, recordKanjiQuiz } from './kanji-quiz-store'
import { recordStreamOnline } from './stats-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-06T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const BROADCASTER_ID = '12345'

const createEnv = (alertChannel = createFakeAlertChannel(), store = createFakeStore({ 'overlay-key': overlayKey })) =>
  ({
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: BROADCASTER_ID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi({ response: '' }),
  }) satisfies Env

/** 漢字クイズの経路は Twitch へ通信しない */
const noFetch: typeof fetch = async () => {
  throw new Error('このテストでは外へ通信しません')
}

const invoke = (path: string, env: Env, init: RequestInit = {}) =>
  handleRequest(new Request(`${site}${path}`, init), env, {
    fetch: noFetch,
    now: () => now,
    wait: async () => {},
    waitUntil: () => undefined,
  })

describe('GET /api/overlay/kanji-quiz/socket', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await invoke('/api/overlay/kanji-quiz/socket?key=wrong-key-0123456789abcdefghijklmn', createEnv(), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/kanji-quiz/socket?key=${overlayKey}`, createEnv())

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、漢字クイズを受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke(`/api/overlay/kanji-quiz/socket?key=${overlayKey}`, createEnv(alertChannel), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['kanjiQuiz'])
  })
})

describe('POST /api/admin/kanji-quiz/demo', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, body?: unknown): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/kanji-quiz/demo', env, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/kanji-quiz/demo', createEnv(alertChannel), { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedKanjiQuizzes).toEqual([])
  })

  it('本文の級の問題を1問選んで押し出し、押し出したものを返す（出題させた人は持たない）', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv(alertChannel), { grade: '1' })

    expect(response.status).toBe(200)
    expect(alertChannel.pushedKanjiQuizzes).toHaveLength(1)
    const call = alertChannel.pushedKanjiQuizzes[0]
    expect(call?.problem.grade).toBe('1')
    expect(call?.requesterName).toBeNull()
    // 合成ページの読み取りがそのまま読める形で押し出す
    expect(parseKanjiQuizMessage(JSON.stringify(call))).toEqual({ type: 'call', call })
    expect(await response.json()).toEqual(call)
  })

  it('級が無い・知らない値なら、押し出さずに400にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)

    expect((await callAsBroadcaster(env)).status).toBe(400)
    expect((await callAsBroadcaster(env, { grade: '準2級' })).status).toBe(400)
    expect(alertChannel.pushedKanjiQuizzes).toEqual([])
  })

  it('配送先が失敗したら502にする', async () => {
    const response = await callAsBroadcaster(createEnv(createFakeAlertChannel({ shouldFail: true })), { grade: '6' })

    expect(response.status).toBe(502)
  })

  it('同じ配信で選べる問題が尽きたら、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: now - 60_000 })

    // 1級の問題を出しきるまで試し再生する（問題集の1級の問題数は変わりうるので、409が返るまで続ける）
    const statuses: number[] = []
    for (let attempt = 0; attempt < 100 && !statuses.includes(409); attempt++) statuses.push((await callAsBroadcaster(env, { grade: '1' })).status)

    expect(statuses.at(-1)).toBe(409)
    const words = alertChannel.pushedKanjiQuizzes.map(({ problem }) => problem.word)
    expect(new Set(words).size).toBe(words.length)
  })
})

describe('POST /api/overlay/kanji-quiz/open', () => {
  const open = (env: Env, body: unknown, key = overlayKey) =>
    invoke(`/api/overlay/kanji-quiz/open?key=${key}`, env, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await open(createEnv(), { quizId: 'quiz-keidai' }, 'wrong-key-0123456789abcdefghijklmn')

    expect(response.status).toBe(401)
  })

  it('選んだ出題を開き、熟語が出てから回答を受け付けるようにする', async () => {
    const env = createEnv()
    await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内' }, now - 1000)

    const response = await open(env, { quizId: 'quiz-keidai' })

    expect(response.status).toBe(204)
    expect(await answerKanjiQuiz(env.DB, { words: ['境内'], userName: '山田花子' }, now + GRADE_INTRO_MS + 1000)).toEqual(['quiz-keidai'])
  })

  it('選んでいない出題の識別子なら404にする', async () => {
    const response = await open(createEnv(), { quizId: 'quiz-unknown' })

    expect(response.status).toBe(404)
  })

  it('本文に出題の識別子が無ければ400にする', async () => {
    const response = await open(createEnv(), {})

    expect(response.status).toBe(400)
  })
})
