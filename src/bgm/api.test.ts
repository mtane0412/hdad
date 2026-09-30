/**
 * BGMの読み書き（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（speech/api.test.ts と同じ形）。
 * 確かめること:
 * - 管理画面（セッション）と裏方のページ（オーバーレイ用キー）が、それぞれの経路を呼ぶこと
 * - 応答が想定した形でなければエラーにすること（黙って「何も流していない」に倒さない）
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createBgmApi, createBgmOverlayApi, parseBgmNowPlaying, type BgmNowPlaying, type BgmTrack } from './api'

const overlayKey = 'overlay-key_0123456789abcdefghij'

/** 雑談のときに流したい、落ち着いた曲 */
const chatTrack: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** 雑談の曲を流しているときに Worker が返すもの */
const playingChatTrack: BgmNowPlaying = {
  track: {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: 'https://amachamusic.chagasi.com/',
    url: `/api/media/media-zatsudan?key=${overlayKey}`,
  },
  volume: 0.3,
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const fetchReturning = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createBgmApi（管理画面）', () => {
  it('曲の一覧と、いま流す曲・音量と、BGMの設定を管理用の経路から読む', async () => {
    const saved = { tracks: [chatTrack], playback: { mediaId: 'media-zatsudan', volume: 0.3 }, settings: { judgeWithJev: false } }
    const { calls, fetchImpl } = fetchReturning(200, saved)

    expect(await createBgmApi(fetchImpl).load()).toEqual(saved)
    expect(calls).toEqual([{ path: '/api/admin/bgm', method: 'GET', body: '' }])
  })

  it('曲の一覧をまるごと置き換えて保存する', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { tracks: [chatTrack] })

    expect(await createBgmApi(fetchImpl).saveTracks([chatTrack])).toEqual([chatTrack])
    expect(calls).toEqual([{ path: '/api/admin/bgm/tracks', method: 'PUT', body: JSON.stringify({ tracks: [chatTrack] }) }])
  })

  it('流す曲と音量を保存する（止めるときは mediaId に null）', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { playback: { mediaId: null, volume: 0.5 } })

    expect(await createBgmApi(fetchImpl).savePlayback({ mediaId: null, volume: 0.5 })).toEqual({ mediaId: null, volume: 0.5 })
    expect(calls).toEqual([{ path: '/api/admin/bgm/playback', method: 'PUT', body: JSON.stringify({ mediaId: null, volume: 0.5 }) }])
  })

  it('Jev に曲を選ばせるかを保存する', async () => {
    const { calls, fetchImpl } = fetchReturning(200, { settings: { judgeWithJev: true } })

    expect(await createBgmApi(fetchImpl).saveSettings({ judgeWithJev: true })).toEqual({ judgeWithJev: true })
    expect(calls).toEqual([{ path: '/api/admin/bgm/settings', method: 'PUT', body: JSON.stringify({ judgeWithJev: true }) }])
  })

  it('応答の設定の形が違えばエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { tracks: [], playback: { mediaId: null, volume: 0.3 }, settings: {} })

    await expect(createBgmApi(fetchImpl).load()).rejects.toThrow('settings')
  })

  it('Worker が問題点を返したら、問題点つきの ApiError にする', async () => {
    const { fetchImpl } = fetchReturning(400, { error: { code: 'invalid-config', message: 'BGMの曲に問題があります', problems: ['tracks[0].title: 1〜100文字で指定してください'] } })

    const error: unknown = await createBgmApi(fetchImpl).saveTracks([chatTrack]).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).problems).toEqual(['tracks[0].title: 1〜100文字で指定してください'])
  })

  it('応答の曲の形が違えばエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { tracks: [{ mediaId: 'media-zatsudan' }], playback: { mediaId: null, volume: 0.3 }, settings: { judgeWithJev: false } })

    await expect(createBgmApi(fetchImpl).load()).rejects.toThrow('tracks[0]')
  })
})

describe('createBgmOverlayApi（裏方のページ）', () => {
  it('オーバーレイ用キーで、いま流している曲を読む', async () => {
    const { calls, fetchImpl } = fetchReturning(200, playingChatTrack)

    expect(await createBgmOverlayApi(fetchImpl, overlayKey).read()).toEqual(playingChatTrack)
    expect(calls).toEqual([{ path: `/api/overlay/bgm?key=${overlayKey}`, method: 'GET', body: '' }])
  })
})

describe('parseBgmNowPlaying', () => {
  it('押し出された文字列を、いま流している曲として読む', () => {
    expect(parseBgmNowPlaying(JSON.stringify(playingChatTrack))).toEqual(playingChatTrack)
  })

  it('止めているときは track が null', () => {
    expect(parseBgmNowPlaying(JSON.stringify({ track: null, volume: 0.3 }))).toEqual({ track: null, volume: 0.3 })
  })

  it('JSONとして読めない・形が違うものはエラーにする', () => {
    expect(() => parseBgmNowPlaying('ひだまりの午後')).toThrow('BGM')
    expect(() => parseBgmNowPlaying(JSON.stringify({ track: { title: 'ひだまりの午後' }, volume: 0.3 }))).toThrow('BGM')
  })
})
