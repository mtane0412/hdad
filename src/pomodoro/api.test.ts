/**
 * ポモドーロの Worker の呼び出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える。合成ページの読み出し（オーバーレイ用キー）と、
 * アプリのページ（/pomodoro/）の読み書き・操作の両方を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createPomodoroApi, createPomodoroOverlayApi } from './api'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'
const startedAt = Date.parse('2026-10-03T12:00:00Z')
const running = { startedAt, anchorAt: startedAt, pausedAt: null }

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createPomodoroOverlayApi', () => {
  it('オーバーレイ用キー付きの経路から、いまのタイマーを読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { timer: running })

    expect(await createPomodoroOverlayApi(fetchImpl, OVERLAY_KEY).read()).toEqual(running)
    expect(calls.map((call) => call.path)).toEqual([`/api/overlay/pomodoro?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('止めていれば null を返す', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { timer: null })

    expect(await createPomodoroOverlayApi(fetchImpl, OVERLAY_KEY).read()).toBeNull()
  })

  it('形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { timer: { startedAt } })

    await expect(createPomodoroOverlayApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow('タイマー')
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createPomodoroOverlayApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow(ApiError)
  })
})

describe('createPomodoroApi', () => {
  it('タイマーと休憩の曲の設定を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { timer: running, settings: { breakMediaId: 'media-休憩のカフェ' } })

    expect(await createPomodoroApi(fetchImpl).read()).toEqual({ timer: running, settings: { breakMediaId: 'media-休憩のカフェ' } })
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/pomodoro'])
  })

  it('休憩の曲の設定の形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { timer: null, settings: {} })

    await expect(createPomodoroApi(fetchImpl).read()).rejects.toThrow('設定')
  })

  it('休憩の曲を保存する', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { settings: { breakMediaId: null } })

    expect(await createPomodoroApi(fetchImpl).saveSettings({ breakMediaId: null })).toEqual({ breakMediaId: null })
    expect(calls).toEqual([{ path: '/api/admin/pomodoro/settings', method: 'PUT', body: { breakMediaId: null } }])
  })

  it('タイマーを操作し、操作したあとのタイマーを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { timer: running })

    expect(await createPomodoroApi(fetchImpl).control('start')).toEqual(running)
    expect(calls).toEqual([{ path: '/api/admin/pomodoro/control', method: 'POST', body: { command: 'start' } }])
  })

  it('今の状態でできない操作の失敗は、Workerの文面のままエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(409, { error: { code: 'pomodoro-running', message: 'ポモドーロのタイマーはもう動いています' } })

    await expect(createPomodoroApi(fetchImpl).control('start')).rejects.toThrow('もう動いています')
  })
})
