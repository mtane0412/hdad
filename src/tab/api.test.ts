/**
 * タブの映像のページ（/tab/）が使うWorkerの呼び出し（src/tab/api.ts）のテスト
 *
 * fetch を差し替えて次を確かめる。
 * - 映さないサイトの一覧を読む
 * - ホスト名を URL に入れて DELETE を送り、消したあとの一覧を返す
 * - 応答の形が違えばエラーにする（黙って空の一覧にすると、登録が消えたように見える）
 */
import { describe, expect, it } from 'vitest'
import { createTabApi } from './api'

/** 押し込まれた要求を覚えたうえで、決めておいた応答を返す fetch を作る */
const recordingFetch = (body: unknown) => {
  const received: { url: string; method?: string }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received.push({ url: String(input), method: init?.method })
    return Response.json(body)
  }) as typeof fetch
  return { fetchImpl, received }
}

describe('createTabApi', () => {
  it('映さないサイトの一覧を読む', async () => {
    const { fetchImpl, received } = recordingFetch({ hosts: ['mail.google.com', 'bank.example.jp'] })

    expect(await createTabApi(fetchImpl).loadBlockedHosts()).toEqual(['mail.google.com', 'bank.example.jp'])
    expect(received).toEqual([{ url: '/api/admin/tab/blocked-hosts', method: undefined }])
  })

  it('ホスト名を一覧から消し、消したあとの一覧を返す', async () => {
    const { fetchImpl, received } = recordingFetch({ hosts: ['bank.example.jp'] })

    expect(await createTabApi(fetchImpl).removeBlockedHost('mail.google.com')).toEqual(['bank.example.jp'])
    expect(received).toEqual([{ url: '/api/admin/tab/blocked-hosts/mail.google.com', method: 'DELETE' }])
  })

  it('応答の形が違えばエラーにする', async () => {
    const { fetchImpl } = recordingFetch({ sites: [] })

    await expect(createTabApi(fetchImpl).loadBlockedHosts()).rejects.toThrow('映さないサイトの一覧の形が想定と違います')
  })
})
