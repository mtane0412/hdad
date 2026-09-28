/**
 * 画面の取り込みのWorkerの呼び出し（src/screen/api.ts）のテスト
 *
 * fetch を差し替えて確かめる。特に重要なのは次の3点である。
 * - 設定の応答が想定した形でなければエラーにすること（黙って既定の設定に倒さない）
 * - 撮った1枚を、画像として（JSONに包まずに）送ること
 * - 記録されたかどうかを呼び出し側へ返すこと（配信外に撮ったものは記録されない）
 * - 管理画面からの保存が、設定を本文にして PUT を送ること
 */
import { describe, expect, it } from 'vitest'
import { createScreenAdminApi, createScreenApi, readScreenConnection, readScreenSettings } from './api'

/** 裏方のページが受け取る、撮るのに要る設定 */
const つなぎ先 = { host: 'localhost', port: 4455, password: 'obsのパスワード', intervalSeconds: 60 }
/** 管理画面が読み書きする設定（上げ先のコレクションを含む） */
const 設定 = { ...つなぎ先, collectionId: 'f19e74cebe47c9cadad31b6790098eac' }
const 画像 = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

/** 押し込まれた要求を覚えたうえで、決めておいた応答を返す fetch を作る */
const 覚えるfetch = (応答: () => Response) => {
  const 受け取った: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    受け取った.push({ url: String(input), init })
    return 応答()
  }) as typeof fetch
  return { fetchImpl, 受け取った }
}

describe('readScreenSettings', () => {
  it('想定した形の応答を設定として読む', () => {
    expect(readScreenSettings(設定)).toEqual(設定)
  })

  it('項目が欠けていればエラーにする（黙って既定の設定に倒さない）', () => {
    expect(() => readScreenSettings({ host: 'localhost', port: 4455 })).toThrow(/想定した形/)
  })
})

describe('readScreenConnection', () => {
  it('撮るのに要る設定だけを読む（上げ先のコレクションは渡ってこない）', () => {
    expect(readScreenConnection(つなぎ先)).toEqual(つなぎ先)
  })

  it('項目が欠けていればエラーにする', () => {
    expect(() => readScreenConnection({ host: 'localhost', port: 4455 })).toThrow(/想定した形/)
  })
})

describe('createScreenApi', () => {
  it('オーバーレイ用キーを添えてつなぎ先を読む', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(() => Response.json(つなぎ先))

    expect(await createScreenApi(fetchImpl, 'テスト用のキー').read()).toEqual(つなぎ先)
    expect(受け取った[0]?.url).toBe('/api/overlay/screen?key=%E3%83%86%E3%82%B9%E3%83%88%E7%94%A8%E3%81%AE%E3%82%AD%E3%83%BC')
  })

  it('撮った1枚を、画像そのものとして送る', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(() => Response.json({ recorded: true, imageId: 'abcdef' }))

    expect(await createScreenApi(fetchImpl, 'テスト用のキー').send(画像)).toBe(true)
    expect(受け取った[0]?.init?.method).toBe('POST')
    expect(受け取った[0]?.init?.body).toBe(画像)
    expect(new Headers(受け取った[0]?.init?.headers).get('Content-Type')).toBe('image/png')
  })

  it('配信していなくて記録されなかったことを、そのまま返す', async () => {
    const { fetchImpl } = 覚えるfetch(() => Response.json({ recorded: false, imageId: null }))

    expect(await createScreenApi(fetchImpl, 'テスト用のキー').send(画像)).toBe(false)
  })

  it('応答に recorded が無ければエラーにする', async () => {
    const { fetchImpl } = 覚えるfetch(() => Response.json({ imageId: 'abcdef' }))

    await expect(createScreenApi(fetchImpl, 'テスト用のキー').send(画像)).rejects.toThrow(/recorded/)
  })
})

describe('createScreenAdminApi', () => {
  it('管理用の経路から設定を読む（オーバーレイ用キーは付けない）', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(() => Response.json(設定))

    expect(await createScreenAdminApi(fetchImpl).load()).toEqual(設定)
    expect(受け取った[0]?.url).toBe('/api/admin/screen')
  })

  it('設定を本文にして保存し、保存された設定を返す', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(() => Response.json(設定))

    expect(await createScreenAdminApi(fetchImpl).save(設定)).toEqual(設定)
    expect(受け取った[0]?.init?.method).toBe('PUT')
    expect(受け取った[0]?.init?.body).toBe(JSON.stringify(設定))
  })
})
