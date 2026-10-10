/**
 * 漢字クイズの経路（kanji-quiz-routes.ts）のテスト
 *
 * - 合成ページの接続（GET /api/overlay/kanji-quiz/socket）は、漢字クイズを受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/kanji-quiz/demo）は、ログインした配信者にだけ、本文の級の問題を1問選んで押し出す。
 *   級が無い・知らない値なら400にして押し出さない。配送先の失敗は502にする。同じ配信でその級を出しきっても一巡して出題しつづける
 * - 出題を開く（POST /api/overlay/kanji-quiz/open）は、合成ページが流しはじめたときに呼び、Worker が選んだ出題の行に受付期限を書く。
 *   選んでいない出題の識別子なら404にする（合成ページから熟語を受け取って作らない）。開いたら、受付の締め切りに時間切れの判定を予約する（issue #302）
 * - 配信の停止の取り消し（POST /api/admin/kanji-quiz/stop/cancel）は、ログインした配信者にだけ、猶予のあいだの停止を取り消す。
 *   取り消すものが無ければ409にする
 * - 裏方のページの「配信の停止」の接続（GET /api/overlay/kanji-quiz/stop/socket）は、配信を止める命令を受け取る接続として引き渡す
 * - 停止の結果（POST /api/overlay/kanji-quiz/stop/result）は、止められなかったときだけ失敗として記録する
 */
import { describe, expect, it } from 'vitest'
import { parseKanjiQuizMessage } from '../src/kanji-quiz/call'
import { ANSWER_LIMIT_MS, GRADE_INTRO_MS } from '../src/kanji-quiz/scene'
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
import { KANJI_QUIZ_PROBLEMS } from './kanji-quiz-call'
import { DEFAULT_KANJI_QUIZ_SOUND, loadKanjiQuizSound, saveKanjiQuizSound } from './kanji-quiz-sound'
import { KANJI_QUIZ_STOP_GRACE_MS } from './kanji-quiz-stop'
import { KANJI_QUIZ_GRACE_MS, answerKanjiQuiz, beginKanjiQuizStop, openKanjiQuiz, recordKanjiQuiz } from './kanji-quiz-store'
import { listFailures, recordStreamOnline } from './stats-store'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-06T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const BROADCASTER_ID = '12345'

const createEnv = (alertChannel = createFakeAlertChannel(), store = createFakeStore({ 'overlay-key': overlayKey }), adBreakTimer = createFakeAdBreakTimer()) =>
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
    AD_BREAKS: adBreakTimer.namespace,
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

/** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
const postAsBroadcaster = async (path: string, env: Env, body?: unknown): Promise<Response> => {
  const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
  return invoke(path, env, {
    method: 'POST',
    headers: { Cookie: `__Host-session=${session}`, Origin: site, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe('POST /api/admin/kanji-quiz/demo', () => {
  const callAsBroadcaster = (env: Env, body?: unknown): Promise<Response> => postAsBroadcaster('/api/admin/kanji-quiz/demo', env, body)

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

  it('音を選んでいなければ、どの枠も鳴らさない設定のまま押し出す', async () => {
    const alertChannel = createFakeAlertChannel()

    await callAsBroadcaster(createEnv(alertChannel), { grade: '6' })

    expect(alertChannel.pushedKanjiQuizzes[0]?.sound).toEqual(DEFAULT_KANJI_QUIZ_SOUND)
  })

  it('音を選んでいれば、交換と同じく音声のURL（オーバーレイ用キーつき）と音量を添えて押し出す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    await saveKanjiQuizSound(env.STORE, { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, timeUp: 'media-buzzer' } })

    await callAsBroadcaster(env, { grade: '6' })

    expect(alertChannel.pushedKanjiQuizzes[0]?.sound.slots.timeUp).toBe(`/api/media/media-buzzer?key=${overlayKey}`)
  })

  it('音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに409にする', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel, createFakeStore())
    await saveKanjiQuizSound(env.STORE, { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, timeUp: 'media-buzzer' } })

    const response = await callAsBroadcaster(env, { grade: '6' })

    expect(response.status).toBe(409)
    expect(alertChannel.pushedKanjiQuizzes).toEqual([])
  })

  it('試し再生の出題として記録する（時間切れでも配信を止めない）', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)

    await callAsBroadcaster(env, { grade: '1' })

    const quizId = alertChannel.pushedKanjiQuizzes[0]?.id ?? ''
    const closesAt = await openKanjiQuiz(env.DB, quizId, now)
    expect(await beginKanjiQuizStop(env.DB, quizId, closesAt ?? 0, KANJI_QUIZ_STOP_GRACE_MS)).toEqual({ rehearsal: true })
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

  it('同じ配信でその級の問題を出しきっても、エラーにせず一巡して出題しつづける', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv(alertChannel)
    await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: now - 60_000 })
    const gradeOneCount = KANJI_QUIZ_PROBLEMS.filter((problem) => problem.grade === '1').length

    // 1級の問題数より1回多く試し再生する
    const statuses: number[] = []
    for (let attempt = 0; attempt <= gradeOneCount; attempt++) statuses.push((await callAsBroadcaster(env, { grade: '1' })).status)

    expect(statuses.every((status) => status === 200)).toBe(true)
    // 1巡目は重複させず、出しきったあとの1問は2巡目として出す
    const words = alertChannel.pushedKanjiQuizzes.map(({ problem }) => problem.word)
    expect(new Set(words.slice(0, gradeOneCount)).size).toBe(gradeOneCount)
    expect(words).toHaveLength(gradeOneCount + 1)
  })
})

describe('GET・PUT /api/admin/kanji-quiz/sound', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/kanji-quiz/sound', env, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }

  /** 正解の音（音声）と、背景の画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv()
    await env.MEDIA.put('media-pinpon', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'pinpon.mp3' } })
    await env.MEDIA.put('media-haikei', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'haikei.png' } })
    return env
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/kanji-quiz/sound', createEnv())

    expect(response.status).toBe(401)
  })

  it('未保存なら、どの枠も鳴らさない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_KANJI_QUIZ_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()
    const sound = { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, correct: 'media-pinpon' }, effectVolume: 0.8 }

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()
    const sound = { ...DEFAULT_KANJI_QUIZ_SOUND, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, start: 'media-haikei' } }

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['slots.start: 素材「media-haikei」は音声ではありません'])
    expect(await loadKanjiQuizSound(env.STORE)).toEqual(DEFAULT_KANJI_QUIZ_SOUND)
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
    await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内', rehearsal: false }, now - 1000)

    const response = await open(env, { quizId: 'quiz-keidai' })

    expect(response.status).toBe(204)
    expect(await answerKanjiQuiz(env.DB, { words: ['境内'], userName: '山田花子' }, now + GRADE_INTRO_MS + 1000)).toEqual(['quiz-keidai'])
  })

  it('開いたら、受付の締め切りに時間切れの判定を予約する', async () => {
    const adBreakTimer = createFakeAdBreakTimer()
    const env = createEnv(undefined, undefined, adBreakTimer)
    await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内', rehearsal: false }, now - 1000)

    await open(env, { quizId: 'quiz-keidai' })

    expect(adBreakTimer.scheduledEnds).toEqual([{ kind: 'judge', quizId: 'quiz-keidai', at: now + GRADE_INTRO_MS + ANSWER_LIMIT_MS + KANJI_QUIZ_GRACE_MS }])
  })

  it('判定を予約できなければ502にする（判定されないので配信は止まらないが、合成ページに理由を出す）', async () => {
    const env = createEnv(undefined, undefined, createFakeAdBreakTimer({ shouldFail: true }))
    await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内', rehearsal: false }, now - 1000)

    const response = await open(env, { quizId: 'quiz-keidai' })

    expect(response.status).toBe(502)
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

describe('POST /api/admin/kanji-quiz/stop/cancel', () => {
  /** 「境内」の出題が時間切れになり、配信の停止の猶予に入った環境を作る */
  const stoppingEnv = async (alertChannel = createFakeAlertChannel()) => {
    const env = createEnv(alertChannel)
    await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内', rehearsal: false }, now - 60_000)
    const closesAt = await openKanjiQuiz(env.DB, 'quiz-keidai', now - 50_000)
    await beginKanjiQuizStop(env.DB, 'quiz-keidai', closesAt ?? 0, KANJI_QUIZ_STOP_GRACE_MS)
    return env
  }

  it('ログインしていなければ401にし、取り消さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/kanji-quiz/stop/cancel', await stoppingEnv(alertChannel), { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([])
  })

  it('猶予のあいだの停止を取り消し、取り消したことを合成ページと下部バーへ知らせる', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await postAsBroadcaster('/api/admin/kanji-quiz/stop/cancel', await stoppingEnv(alertChannel))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ quizIds: ['quiz-keidai'] })
    expect(alertChannel.pushedKanjiQuizNotices).toEqual([{ type: 'stopCancelled', quizId: 'quiz-keidai' }])
  })

  it('取り消すものが無ければ409にする（もう止める命令を送った・猶予に入っていない）', async () => {
    const response = await postAsBroadcaster('/api/admin/kanji-quiz/stop/cancel', createEnv())

    expect(response.status).toBe(409)
  })
})

describe('GET /api/overlay/kanji-quiz/stop/socket', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await invoke('/api/overlay/kanji-quiz/stop/socket?key=wrong-key-0123456789abcdefghijklmn', createEnv(), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(401)
  })

  it('WebSocketの接続なら、配信を止める命令を受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke(`/api/overlay/kanji-quiz/stop/socket?key=${overlayKey}`, createEnv(alertChannel), { headers: { Upgrade: 'websocket' } })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['streamStop'])
  })
})

describe('POST /api/overlay/kanji-quiz/stop/result', () => {
  const report = (env: Env, body: unknown, key = overlayKey) =>
    invoke(`/api/overlay/kanji-quiz/stop/result?key=${key}`, env, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('オーバーレイ用キーが違えば断る', async () => {
    const response = await report(createEnv(), { quizId: 'quiz-keidai', error: null }, 'wrong-key-0123456789abcdefghijklmn')

    expect(response.status).toBe(401)
  })

  it('止められなかったら、理由を添えて失敗として記録する', async () => {
    const env = createEnv()

    const response = await report(env, { quizId: 'quiz-keidai', error: 'ws://localhost:4455 につながりませんでした' })

    expect(response.status).toBe(204)
    const failures = await listFailures(env.DB)
    expect(failures.map(({ code }) => code)).toEqual(['kanji-quiz-stop-failed'])
    expect(failures[0]?.message).toContain('ws://localhost:4455 につながりませんでした')
  })

  it('止められたら記録しない', async () => {
    const env = createEnv()

    const response = await report(env, { quizId: 'quiz-keidai', error: null })

    expect(response.status).toBe(204)
    expect(await listFailures(env.DB)).toEqual([])
  })

  it('本文の形が違えば400にする', async () => {
    const response = await report(createEnv(), { quizId: 'quiz-keidai' })

    expect(response.status).toBe(400)
  })
})
