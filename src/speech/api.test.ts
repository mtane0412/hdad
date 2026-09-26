/**
 * 読み上げの設定の読み書き（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える（transcript/api.test.ts と同じ形）。
 * 確かめること:
 * - 管理画面（セッション）と読み上げのページ（オーバーレイ用キー）が、それぞれの経路を呼ぶこと
 * - 応答が想定した形でなければエラーにすること（黙って既定に倒さない）
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createSpeechApi, createSpeechOverlayApi, type SpeechSettings } from './api'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

/** Workerが返す、保存済みの設定 */
const 保存済みの設定: SpeechSettings = {
  host: '127.0.0.1',
  port: 50022,
  speaker: 8,
  speed: 1.2,
  volume: 0.8,
  maxLength: 80,
  readName: true,
  ignoreLogins: ['hdad_bot'],
}

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const 呼び出し: { path: string; method: string; body: string }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼び出し.push({ path: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { 呼び出し, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createSpeechApi（管理画面）', () => {
  it('保存済みの設定を管理用の経路から読む', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, 保存済みの設定)

    expect(await createSpeechApi(fetchImpl).load()).toEqual(保存済みの設定)
    expect(呼び出し).toEqual([{ path: '/api/admin/speech', method: 'GET', body: '' }])
  })

  it('設定をまるごと置き換えて保存し、保存後の設定を受け取る', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, 保存済みの設定)

    expect(await createSpeechApi(fetchImpl).save(保存済みの設定)).toEqual(保存済みの設定)
    expect(呼び出し).toEqual([{ path: '/api/admin/speech', method: 'PUT', body: JSON.stringify(保存済みの設定) }])
  })

  it('Workerが問題点を返したら ApiError にする（画面が理由を並べられるようにする）', async () => {
    const { fetchImpl } = 応答を返すfetch(400, {
      error: { code: 'invalid-config', message: '読み上げの設定に問題があります', problems: ['port: 1〜65535 の整数で指定してください'] },
    })

    await expect(createSpeechApi(fetchImpl).save(保存済みの設定)).rejects.toThrow(ApiError)
  })

  it('応答に足りない項目があればエラーにする（黙って既定に倒さない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { ...保存済みの設定, volume: undefined })

    await expect(createSpeechApi(fetchImpl).load()).rejects.toThrow(/想定した形/)
  })
})

describe('createSpeechOverlayApi（読み上げのページ）', () => {
  it('オーバーレイ用キー付きの経路から設定を読む', async () => {
    const { 呼び出し, fetchImpl } = 応答を返すfetch(200, 保存済みの設定)

    expect(await createSpeechOverlayApi(fetchImpl, オーバーレイ用キー).read()).toEqual(保存済みの設定)
    expect(呼び出し).toEqual([{ path: `/api/overlay/speech?key=${encodeURIComponent(オーバーレイ用キー)}`, method: 'GET', body: '' }])
  })

  it('キーが違うとWorkerが拒んだら ApiError にする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(createSpeechOverlayApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow(ApiError)
  })

  it('読み上げない人が文字列の配列でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { ...保存済みの設定, ignoreLogins: 'hdad_bot' })

    await expect(createSpeechOverlayApi(fetchImpl, オーバーレイ用キー).read()).rejects.toThrow(/想定した形/)
  })
})
