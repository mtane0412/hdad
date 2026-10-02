/**
 * BGMの経路（/api/admin/bgm・/api/overlay/bgm）のテスト
 *
 * KV・R2を差し替え、handleRequest を通して確かめる。特に重要なのは次の点である。
 * - 流す曲や音量を変えたら、裏方のページへ「いま流している曲」を押し出すこと（配信中にすぐ切り替わるように）
 * - 検証で見つかった問題点が、400の応答に並んで返ること（画面で一度に直せるようにするため）
 * - 裏方のページ（オーバーレイ用キー）から、いま流している曲を読めること
 * - BGMの曲に使われている素材は消させないこと
 * - 手で流す曲を切り替えた時刻を記録すること（そのすぐあとに Jev が上書きしないため。issue #153）
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
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeStore } from './fake-store'
import { loadBgmPlayback, loadBgmSettings, loadBgmSwitchedAt, loadBgmTracks, saveBgmSwitchedAt, type BgmTrack } from './bgm-config'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const NOW = Date.parse('2026-09-29T12:00:00Z')
const BROADCASTER_ID = '12345'
const SITE = 'https://hdad.example.com'
const ISSUED_KEY = 'issued-overlay-key-0123456789abcdefghij'

/** 雑談のときに流したい、落ち着いた曲 */
const casualTrack: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const hypeTrack: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

const setupEnv = async () => {
  const bucket = createFakeBucket()
  // 曲の音声として、2つの音声を上げておく
  const audioOptions = { httpMetadata: { contentType: 'audio/mpeg' } }
  await bucket.put(casualTrack.mediaId, new ArrayBuffer(8), { ...audioOptions, customMetadata: { name: 'hidamari.mp3' } })
  await bucket.put(hypeTrack.mediaId, new ArrayBuffer(8), { ...audioOptions, customMetadata: { name: 'zenryoku.mp3' } })
  const alertChannel = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': ISSUED_KEY }),
    MEDIA: bucket,
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
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, alertChannel }
}

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noWait = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const noWaitUntil = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const callHandler = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: noTwitchFetch, now: () => NOW, wait: noWait, waitUntil: noWaitUntil })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const callAsBroadcaster = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(BROADCASTER_ID, env.SESSION_SECRET, NOW)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = SITE
  return callHandler(new Request(`${SITE}${path}`, { ...init, headers }), env)
}

const saveTracks = (env: Env, tracks: unknown) =>
  callAsBroadcaster(env, '/api/admin/bgm/tracks', { method: 'PUT', body: JSON.stringify({ tracks }) })

const changePlayback = (env: Env, playback: unknown) =>
  callAsBroadcaster(env, '/api/admin/bgm/playback', { method: 'PUT', body: JSON.stringify(playback) })

describe('GET /api/admin/bgm', () => {
  it('一度も保存していなければ、曲は空で何も流していない', async () => {
    const { env } = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/bgm')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tracks: [], playback: { mediaId: null, volume: 0.3, repeat: false, shuffle: false }, settings: { judgeWithJev: false } })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/bgm`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/bgm/tracks', () => {
  it('曲の一覧を保存して返す', async () => {
    const { env } = await setupEnv()

    const response = await saveTracks(env, [casualTrack, hypeTrack])

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tracks: [casualTrack, hypeTrack] })
    expect(await loadBgmTracks(env.STORE)).toEqual([casualTrack, hypeTrack])
  })

  it('問題があれば400にして、問題点を並べて返す', async () => {
    const { env } = await setupEnv()

    const response = await saveTracks(env, [{ ...casualTrack, title: '', mediaId: 'media-nai' }])

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['tracks[0].mediaId: 素材「media-nai」が存在しません', 'tracks[0].title: 1〜60文字で指定してください'])
    expect(await loadBgmTracks(env.STORE)).toEqual([])
  })

  it('流している曲は一覧から消させない', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.3, repeat: false, shuffle: false })

    const response = await saveTracks(env, [hypeTrack])

    expect(response.status).toBe(400)
    expect(await loadBgmTracks(env.STORE)).toEqual([casualTrack, hypeTrack])
  })

  it('流している曲の情報を直したら、裏方のページへ押し出す（クレジットの表示を合わせるため）', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.3, repeat: false, shuffle: false })

    await saveTracks(env, [{ ...casualTrack, title: 'ひだまりの午後（ピアノ版）' }])

    expect(alertChannel.pushedBgm.at(-1)?.track?.title).toBe('ひだまりの午後（ピアノ版）')
  })

  it('何も流していなければ、曲を直しても押し出さない', async () => {
    const { env, alertChannel } = await setupEnv()

    await saveTracks(env, [casualTrack])

    expect(alertChannel.pushedBgm).toEqual([])
  })
})

describe('PUT /api/admin/bgm/playback', () => {
  it('流す曲と音量を保存し、裏方のページへ押し出す', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])

    const response = await changePlayback(env, { mediaId: hypeTrack.mediaId, volume: 0.5, repeat: false, shuffle: false })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ playback: { mediaId: hypeTrack.mediaId, volume: 0.5, repeat: false, shuffle: false } })
    expect(await loadBgmPlayback(env.STORE)).toEqual({ mediaId: hypeTrack.mediaId, volume: 0.5, repeat: false, shuffle: false })
    expect(alertChannel.pushedBgm).toEqual([
      {
        track: {
          mediaId: hypeTrack.mediaId,
          title: '全力疾走',
          credit: '音楽: DOVA-SYNDROME',
          creditUrl: 'https://dova-s.jp/',
          url: `/api/media/media-moriagari?key=${ISSUED_KEY}`,
        },
        volume: 0.5,
        repeat: false,
        shuffle: false,
      },
    ])
  })

  it('止めたことも押し出す', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.5, repeat: false, shuffle: false })

    await changePlayback(env, { mediaId: null, volume: 0.5, repeat: false, shuffle: false })

    expect(alertChannel.pushedBgm.at(-1)).toEqual({ track: null, volume: 0.5, repeat: false, shuffle: false })
  })

  it('一覧に無い曲は400にして、保存も押し出しもしない', async () => {
    const { env, alertChannel } = await setupEnv()

    const response = await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.5, repeat: false, shuffle: false })

    expect(response.status).toBe(400)
    expect(await loadBgmPlayback(env.STORE)).toEqual({ mediaId: null, volume: 0.3, repeat: false, shuffle: false })
    expect(alertChannel.pushedBgm).toEqual([])
  })
})

describe('PUT /api/admin/bgm/playback の切り替えた時刻', () => {
  it('流す曲を変えたら、切り替えた時刻を記録する', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])

    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.3, repeat: false, shuffle: false })

    expect(await loadBgmSwitchedAt(env.STORE)).toBe(NOW)
  })

  it('音量だけを変えたときは、切り替えた時刻を動かさない（曲は変わっていないため）', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.3, repeat: false, shuffle: false })
    const previousSwitchedAt = NOW - 60 * 60 * 1000
    await saveBgmSwitchedAt(env.STORE, previousSwitchedAt)

    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.6, repeat: false, shuffle: false })

    expect(await loadBgmSwitchedAt(env.STORE)).toBe(previousSwitchedAt)
  })
})

describe('PUT /api/admin/bgm/settings', () => {
  it('Jev に曲を選ばせるかを保存して返す', async () => {
    const { env } = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/bgm/settings', { method: 'PUT', body: JSON.stringify({ judgeWithJev: true }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { judgeWithJev: true } })
    expect(await loadBgmSettings(env.STORE)).toEqual({ judgeWithJev: true })
  })

  it('問題があれば400にして、保存しない', async () => {
    const { env } = await setupEnv()

    const response = await callAsBroadcaster(env, '/api/admin/bgm/settings', { method: 'PUT', body: JSON.stringify({ judgeWithJev: 'はい' }) })

    expect(response.status).toBe(400)
    expect(await loadBgmSettings(env.STORE)).toEqual({ judgeWithJev: false })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/admin/bgm/settings`, { method: 'PUT', body: '{}' }), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/bgm', () => {
  it('オーバーレイ用キーで、いま流している曲を読める（裏方のページが開いたときとつなぎ直したときに読む）', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })

    const response = await callHandler(new Request(`${SITE}/api/overlay/bgm?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      track: {
        mediaId: casualTrack.mediaId,
        title: 'ひだまりの午後',
        credit: '音楽: 甘茶の音楽工房',
        creditUrl: 'https://amachamusic.chagasi.com/',
        url: `/api/media/media-zatsudan?key=${ISSUED_KEY}`,
      },
      volume: 0.4,
      repeat: false,
      shuffle: false,
    })
  })

  it('キーが違えば401にする', async () => {
    const { env } = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/bgm?key=chigau-key`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/bgm/socket', () => {
  it('BGMを受け取る接続として配送先へ引き渡す', async () => {
    const { env, alertChannel } = await setupEnv()

    await callHandler(new Request(`${SITE}/api/overlay/bgm/socket?key=${ISSUED_KEY}`, { headers: { Upgrade: 'websocket' } }), env)

    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['bgm'])
  })

  it('WebSocketでなければ400にする', async () => {
    const { env } = await setupEnv()

    const response = await callHandler(new Request(`${SITE}/api/overlay/bgm/socket?key=${ISSUED_KEY}`), env)

    expect(response.status).toBe(400)
  })
})

describe('POST /api/admin/bgm/skip', () => {
  const skip = (env: Env, step: unknown) => callAsBroadcaster(env, '/api/admin/bgm/skip', { method: 'POST', body: JSON.stringify({ step }) })

  it('次の曲へ進めて保存し、裏方のページへ押し出し、切り替えた時刻を記録する', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.4, repeat: true, shuffle: false })
    await saveBgmSwitchedAt(env.STORE, NOW - 60 * 60 * 1000)

    const response = await skip(env, 'next')

    expect(response.status).toBe(200)
    const playback = { mediaId: hypeTrack.mediaId, volume: 0.4, repeat: true, shuffle: false }
    expect(await response.json()).toEqual({ playback })
    expect(await loadBgmPlayback(env.STORE)).toEqual(playback)
    expect(alertChannel.pushedBgm.at(-1)?.track?.mediaId).toBe(hypeTrack.mediaId)
    expect(await loadBgmSwitchedAt(env.STORE)).toBe(NOW)
  })

  it('止めているときに次の曲へ進めると、最初の曲から流し始める', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])

    const response = await skip(env, 'next')

    expect(await response.json()).toEqual({ playback: { mediaId: casualTrack.mediaId, volume: 0.3, repeat: false, shuffle: false } })
  })

  it('前の曲へ戻せる', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: hypeTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })

    const response = await skip(env, 'previous')

    expect(await response.json()).toEqual({ playback: { mediaId: casualTrack.mediaId, volume: 0.4, repeat: false, shuffle: false } })
  })

  it('曲が1つも無ければ409にして、何も押し出さない', async () => {
    const { env, alertChannel } = await setupEnv()

    const response = await skip(env, 'next')

    expect(response.status).toBe(409)
    expect(alertChannel.pushedBgm).toEqual([])
  })

  it('進む向きが next か previous でなければ400にする', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack])

    const response = await skip(env, 'tsugi')

    expect(response.status).toBe(400)
  })
})

describe('POST /api/overlay/bgm/ended', () => {
  const ended = (env: Env, mediaId: unknown, key = ISSUED_KEY) =>
    callHandler(
      new Request(`${SITE}/api/overlay/bgm/ended?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaId }) }),
      env,
    )

  it('流している曲が終わったら次の曲へ進め、押し出したうえで、いま流している曲を返す', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })
    await saveBgmSwitchedAt(env.STORE, NOW - 60 * 60 * 1000)

    const response = await ended(env, casualTrack.mediaId)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { track: { mediaId: string } | null }
    expect(body.track?.mediaId).toBe(hypeTrack.mediaId)
    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(hypeTrack.mediaId)
    expect(alertChannel.pushedBgm.at(-1)?.track?.mediaId).toBe(hypeTrack.mediaId)
    // 自動で進んだだけなので、手で切り替えた時刻（Jev の待ち時間の起点）は動かさない
    expect(await loadBgmSwitchedAt(env.STORE)).toBe(NOW - 60 * 60 * 1000)
  })

  it('シャッフルなら、終わった曲以外から選ぶ', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: hypeTrack.mediaId, volume: 0.4, repeat: false, shuffle: true })

    await ended(env, hypeTrack.mediaId)

    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(casualTrack.mediaId)
  })

  it('もう別の曲に切り替わっていたら（別の裏方が先に知らせた・手で切り替えた）、進めずにいま流している曲を返す', async () => {
    const { env, alertChannel } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: hypeTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })
    const pushedBefore = alertChannel.pushedBgm.length

    const response = await ended(env, casualTrack.mediaId)

    const body = (await response.json()) as { track: { mediaId: string } | null }
    expect(body.track?.mediaId).toBe(hypeTrack.mediaId)
    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(hypeTrack.mediaId)
    expect(alertChannel.pushedBgm).toHaveLength(pushedBefore)
  })

  it('リピート中なら進めない（同じ曲を流し続ける）', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack, hypeTrack])
    await changePlayback(env, { mediaId: casualTrack.mediaId, volume: 0.4, repeat: true, shuffle: false })

    await ended(env, casualTrack.mediaId)

    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(casualTrack.mediaId)
  })

  it('キーが違えば401にする', async () => {
    const { env } = await setupEnv()

    const response = await ended(env, casualTrack.mediaId, 'chigau-key')

    expect(response.status).toBe(401)
  })
})

describe('DELETE /api/admin/media/:id', () => {
  it('BGMの曲に使われている素材は409で削除を拒否する（配信中に黙って無音にならないように）', async () => {
    const { env } = await setupEnv()
    await saveTracks(env, [casualTrack])

    const response = await callAsBroadcaster(env, `/api/admin/media/${casualTrack.mediaId}`, { method: 'DELETE' })

    expect(response.status).toBe(409)
    expect(await env.MEDIA.head(casualTrack.mediaId)).not.toBeNull()
  })
})
