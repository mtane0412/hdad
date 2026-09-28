/**
 * Gyazo への画像のアップロード（worker/gyazo.ts）のテスト
 *
 * fetch を差し替えて確かめる。特に重要なのは次の3点である。
 * - 人に見せないための指定（access_policy=only_me）を必ず付けること
 * - 指定されたコレクションに入れること、指定がなければその項目を送らないこと
 * - 応答から画像IDを取り出せること（このあとのOCRの取得が画像IDだけを頼りにするため）
 * - Gyazo が失敗を返したときや応答に画像IDが無いとき、黙って成功扱いにせず GyazoApiError にすること
 */
import { describe, expect, it } from 'vitest'
import { createGyazoClient, GyazoApiError } from './gyazo'

const 画像 = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })

/** 押し込まれた要求を覚えたうえで、決めておいた応答を返す fetch を作る */
const 覚えるfetch = (応答: Response) => {
  const 受け取った: { url: string; body: FormData }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    受け取った.push({ url: String(input), body: init?.body as FormData })
    return 応答
  }) as typeof fetch
  return { fetchImpl, 受け取った }
}

const 成功の応答 = () =>
  Response.json({ image_id: 'abcdef0123456789abcdef0123456789', permalink_url: 'https://gyazo.com/abcdef0123456789abcdef0123456789' })

describe('createGyazoClient', () => {
  it('アクセストークンと画像を、人に見せない指定とともに送る', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(成功の応答())
    await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).upload(画像, 'screen.png')

    expect(受け取った[0]?.url).toBe('https://upload.gyazo.com/api/upload')
    const body = 受け取った[0]?.body
    expect(body?.get('access_token')).toBe('テスト用のトークン')
    expect(body?.get('access_policy')).toBe('only_me')
    expect(body?.get('metadata_is_public')).toBe('false')
    expect(body?.get('imagedata')).toBeInstanceOf(Blob)
  })

  it('コレクションを指定されたら、その指定を添えて送る', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(成功の応答())
    await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).upload(画像, 'screen.png', {
      collectionId: 'f19e74cebe47c9cadad31b6790098eac',
    })

    expect(受け取った[0]?.body?.get('collection_id')).toBe('f19e74cebe47c9cadad31b6790098eac')
  })

  it('コレクションの指定がなければ、その項目は送らない', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetch(成功の応答())
    await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).upload(画像, 'screen.png', { collectionId: '' })

    expect(受け取った[0]?.body?.has('collection_id')).toBe(false)
  })

  it('応答から画像IDと閲覧用のURLを取り出す', async () => {
    const { fetchImpl } = 覚えるfetch(成功の応答())
    const 上げたもの = await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).upload(画像, 'screen.png')

    expect(上げたもの).toEqual({
      imageId: 'abcdef0123456789abcdef0123456789',
      permalinkUrl: 'https://gyazo.com/abcdef0123456789abcdef0123456789',
    })
  })

  it('Gyazo が失敗を返したら GyazoApiError にする', async () => {
    const { fetchImpl } = 覚えるfetch(Response.json({ message: 'unauthorized' }, { status: 401 }))
    const 上げる = createGyazoClient({ accessToken: '誤ったトークン', fetch: fetchImpl }).upload(画像, 'screen.png')

    await expect(上げる).rejects.toBeInstanceOf(GyazoApiError)
    await expect(上げる).rejects.toThrow(/401/)
  })

  it('応答に画像IDが無ければ GyazoApiError にする（黙って成功扱いにしない）', async () => {
    const { fetchImpl } = 覚えるfetch(Response.json({ permalink_url: 'https://gyazo.com/xxxx' }))
    const 上げる = createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).upload(画像, 'screen.png')

    await expect(上げる).rejects.toThrow(/image_id/)
  })
})
