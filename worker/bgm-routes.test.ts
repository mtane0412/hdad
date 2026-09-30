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
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { loadBgmPlayback, loadBgmSettings, loadBgmSwitchedAt, loadBgmTracks, saveBgmSwitchedAt, type BgmTrack } from './bgm-config'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const 現在時刻 = Date.parse('2026-09-29T12:00:00Z')
const 配信者のID = '12345'
const サイト = 'https://hdad.example.com'
const 発行済みのキー = 'issued-overlay-key-0123456789abcdefghij'

/** 雑談のときに流したい、落ち着いた曲 */
const 雑談の曲: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const 盛り上がる曲: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

const 環境を作る = async () => {
  const bucket = createFakeBucket()
  // 曲の音声として、2つの音声を上げておく
  const 音声 = { httpMetadata: { contentType: 'audio/mpeg' } }
  await bucket.put(雑談の曲.mediaId, new ArrayBuffer(8), { ...音声, customMetadata: { name: 'hidamari.mp3' } })
  await bucket.put(盛り上がる曲.mediaId, new ArrayBuffer(8), { ...音声, customMetadata: { name: 'zenryoku.mp3' } })
  const 配送 = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': 発行済みのキー }),
    MEDIA: bucket,
    DB: createFakeDatabase(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: 配信者のID,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: 配送.namespace,
    DRAW: createFakeDrawChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, 配送 }
}

const Twitchへは通信しない = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const 待たない = async (): Promise<void> => {}

/** これらの経路は応答のあとに続く処理（waitUntil）を使わない */
const 後回しにしない = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const 呼び出す = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: Twitchへは通信しない, now: () => 現在時刻, wait: 待たない, waitUntil: 後回しにしない })

/** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
const 配信者として呼ぶ = async (env: Env, path: string, init: RequestInit = {}): Promise<Response> => {
  const session = await createSessionToken(配信者のID, env.SESSION_SECRET, 現在時刻)
  const headers: Record<string, string> = { Cookie: `__Host-session=${session}`, 'Content-Type': 'application/json' }
  if (init.method !== undefined && init.method !== 'GET') headers.Origin = サイト
  return 呼び出す(new Request(`${サイト}${path}`, { ...init, headers }), env)
}

const 曲を保存する = (env: Env, tracks: unknown) =>
  配信者として呼ぶ(env, '/api/admin/bgm/tracks', { method: 'PUT', body: JSON.stringify({ tracks }) })

const 再生を変える = (env: Env, playback: unknown) =>
  配信者として呼ぶ(env, '/api/admin/bgm/playback', { method: 'PUT', body: JSON.stringify(playback) })

describe('GET /api/admin/bgm', () => {
  it('一度も保存していなければ、曲は空で何も流していない', async () => {
    const { env } = await 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/bgm')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tracks: [], playback: { mediaId: null, volume: 0.3 }, settings: { judgeWithJev: false } })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = await 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/bgm`), env)

    expect(response.status).toBe(401)
  })
})

describe('PUT /api/admin/bgm/tracks', () => {
  it('曲の一覧を保存して返す', async () => {
    const { env } = await 環境を作る()

    const response = await 曲を保存する(env, [雑談の曲, 盛り上がる曲])

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tracks: [雑談の曲, 盛り上がる曲] })
    expect(await loadBgmTracks(env.STORE)).toEqual([雑談の曲, 盛り上がる曲])
  })

  it('問題があれば400にして、問題点を並べて返す', async () => {
    const { env } = await 環境を作る()

    const response = await 曲を保存する(env, [{ ...雑談の曲, title: '', mediaId: 'media-nai' }])

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['tracks[0].mediaId: 素材「media-nai」が存在しません', 'tracks[0].title: 1〜60文字で指定してください'])
    expect(await loadBgmTracks(env.STORE)).toEqual([])
  })

  it('流している曲は一覧から消させない', async () => {
    const { env } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲, 盛り上がる曲])
    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.3 })

    const response = await 曲を保存する(env, [盛り上がる曲])

    expect(response.status).toBe(400)
    expect(await loadBgmTracks(env.STORE)).toEqual([雑談の曲, 盛り上がる曲])
  })

  it('流している曲の情報を直したら、裏方のページへ押し出す（クレジットの表示を合わせるため）', async () => {
    const { env, 配送 } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲])
    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.3 })

    await 曲を保存する(env, [{ ...雑談の曲, title: 'ひだまりの午後（ピアノ版）' }])

    expect(配送.pushedBgm.at(-1)?.track?.title).toBe('ひだまりの午後（ピアノ版）')
  })

  it('何も流していなければ、曲を直しても押し出さない', async () => {
    const { env, 配送 } = await 環境を作る()

    await 曲を保存する(env, [雑談の曲])

    expect(配送.pushedBgm).toEqual([])
  })
})

describe('PUT /api/admin/bgm/playback', () => {
  it('流す曲と音量を保存し、裏方のページへ押し出す', async () => {
    const { env, 配送 } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲, 盛り上がる曲])

    const response = await 再生を変える(env, { mediaId: 盛り上がる曲.mediaId, volume: 0.5 })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ playback: { mediaId: 盛り上がる曲.mediaId, volume: 0.5 } })
    expect(await loadBgmPlayback(env.STORE)).toEqual({ mediaId: 盛り上がる曲.mediaId, volume: 0.5 })
    expect(配送.pushedBgm).toEqual([
      {
        track: {
          mediaId: 盛り上がる曲.mediaId,
          title: '全力疾走',
          credit: '音楽: DOVA-SYNDROME',
          creditUrl: 'https://dova-s.jp/',
          url: `/api/media/media-moriagari?key=${発行済みのキー}`,
        },
        volume: 0.5,
      },
    ])
  })

  it('止めたことも押し出す', async () => {
    const { env, 配送 } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲])
    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.5 })

    await 再生を変える(env, { mediaId: null, volume: 0.5 })

    expect(配送.pushedBgm.at(-1)).toEqual({ track: null, volume: 0.5 })
  })

  it('一覧に無い曲は400にして、保存も押し出しもしない', async () => {
    const { env, 配送 } = await 環境を作る()

    const response = await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.5 })

    expect(response.status).toBe(400)
    expect(await loadBgmPlayback(env.STORE)).toEqual({ mediaId: null, volume: 0.3 })
    expect(配送.pushedBgm).toEqual([])
  })
})

describe('PUT /api/admin/bgm/playback の切り替えた時刻', () => {
  it('流す曲を変えたら、切り替えた時刻を記録する', async () => {
    const { env } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲, 盛り上がる曲])

    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.3 })

    expect(await loadBgmSwitchedAt(env.STORE)).toBe(現在時刻)
  })

  it('音量だけを変えたときは、切り替えた時刻を動かさない（曲は変わっていないため）', async () => {
    const { env } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲, 盛り上がる曲])
    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.3 })
    const 前に切り替えた時刻 = 現在時刻 - 60 * 60 * 1000
    await saveBgmSwitchedAt(env.STORE, 前に切り替えた時刻)

    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.6 })

    expect(await loadBgmSwitchedAt(env.STORE)).toBe(前に切り替えた時刻)
  })
})

describe('PUT /api/admin/bgm/settings', () => {
  it('Jev に曲を選ばせるかを保存して返す', async () => {
    const { env } = await 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/bgm/settings', { method: 'PUT', body: JSON.stringify({ judgeWithJev: true }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ settings: { judgeWithJev: true } })
    expect(await loadBgmSettings(env.STORE)).toEqual({ judgeWithJev: true })
  })

  it('問題があれば400にして、保存しない', async () => {
    const { env } = await 環境を作る()

    const response = await 配信者として呼ぶ(env, '/api/admin/bgm/settings', { method: 'PUT', body: JSON.stringify({ judgeWithJev: 'はい' }) })

    expect(response.status).toBe(400)
    expect(await loadBgmSettings(env.STORE)).toEqual({ judgeWithJev: false })
  })

  it('ログインしていなければ401にする', async () => {
    const { env } = await 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/admin/bgm/settings`, { method: 'PUT', body: '{}' }), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/bgm', () => {
  it('オーバーレイ用キーで、いま流している曲を読める（裏方のページが開いたときとつなぎ直したときに読む）', async () => {
    const { env } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲])
    await 再生を変える(env, { mediaId: 雑談の曲.mediaId, volume: 0.4 })

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/bgm?key=${発行済みのキー}`), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      track: {
        mediaId: 雑談の曲.mediaId,
        title: 'ひだまりの午後',
        credit: '音楽: 甘茶の音楽工房',
        creditUrl: 'https://amachamusic.chagasi.com/',
        url: `/api/media/media-zatsudan?key=${発行済みのキー}`,
      },
      volume: 0.4,
    })
  })

  it('キーが違えば401にする', async () => {
    const { env } = await 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/bgm?key=chigau-key`), env)

    expect(response.status).toBe(401)
  })
})

describe('GET /api/overlay/bgm/socket', () => {
  it('BGMを受け取る接続として配送先へ引き渡す', async () => {
    const { env, 配送 } = await 環境を作る()

    await 呼び出す(new Request(`${サイト}/api/overlay/bgm/socket?key=${発行済みのキー}`, { headers: { Upgrade: 'websocket' } }), env)

    expect(配送.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['bgm'])
  })

  it('WebSocketでなければ400にする', async () => {
    const { env } = await 環境を作る()

    const response = await 呼び出す(new Request(`${サイト}/api/overlay/bgm/socket?key=${発行済みのキー}`), env)

    expect(response.status).toBe(400)
  })
})

describe('DELETE /api/admin/media/:id', () => {
  it('BGMの曲に使われている素材は409で削除を拒否する（配信中に黙って無音にならないように）', async () => {
    const { env } = await 環境を作る()
    await 曲を保存する(env, [雑談の曲])

    const response = await 配信者として呼ぶ(env, `/api/admin/media/${雑談の曲.mediaId}`, { method: 'DELETE' })

    expect(response.status).toBe(409)
    expect(await env.MEDIA.head(雑談の曲.mediaId)).not.toBeNull()
  })
})
