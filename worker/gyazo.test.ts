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
import { TimeoutError } from './timeout'

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

describe('fetchOcr', () => {
  /** 覚えるfetch と違い、こちらは要求のURLだけを覚える（本文を持たない GET のため） */
  const 覚えるfetchGet = (応答: Response) => {
    const 受け取った: { url: string; headers: HeadersInit | undefined }[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      受け取った.push({ url: String(input), headers: init?.headers })
      return 応答
    }) as typeof fetch
    return { fetchImpl, 受け取った }
  }

  it('画像IDを指して読み取りを求める', async () => {
    const { fetchImpl, 受け取った } = 覚えるfetchGet(Response.json({ metadata: { ocr: { description: '読み取った文字' } } }))
    await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    expect(受け取った[0]?.url).toBe('https://api.gyazo.com/api/images/abcdef0123456789abcdef0123456789?access_token=%E3%83%86%E3%82%B9%E3%83%88%E7%94%A8%E3%81%AE%E3%83%88%E3%83%BC%E3%82%AF%E3%83%B3')
  })

  it('metadata.ocr.description から読み取った文字を取り出す', async () => {
    const { fetchImpl } = 覚えるfetchGet(Response.json({ metadata: { ocr: { locale: 'ja', description: '岩手17歳女性殺害事件' } } }))
    const 文字 = await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    expect(文字).toBe('岩手17歳女性殺害事件')
  })

  it('トップレベルの ocr は見ない（実際の応答は metadata の下にあるため）', async () => {
    const { fetchImpl } = 覚えるfetchGet(Response.json({ ocr: { description: 'ここは読まない' }, metadata: {} }))
    const 文字 = await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    expect(文字).toBeNull()
  })

  it('まだ生成されていなければ null を返す（呼び出し側が次の収集へ回せるように）', async () => {
    const { fetchImpl } = 覚えるfetchGet(Response.json({ metadata: { ocr: { locale: 'ja', description: '' } } }))
    const 文字 = await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    expect(文字).toBeNull()
  })

  it('空白だけの読み取りも、まだ生成されていないものとして扱う', async () => {
    const { fetchImpl } = 覚えるfetchGet(Response.json({ metadata: { ocr: { description: '  \n ' } } }))
    const 文字 = await createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    expect(文字).toBeNull()
  })

  it('成功と返ってきたのに本文を読めなければ GyazoApiError にする（未生成と取り違えないため）', async () => {
    const { fetchImpl } = 覚えるfetchGet(new Response('<html>メンテナンス中</html>', { headers: { 'content-type': 'text/html' } }))
    const 取りに行く = createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('abcdef0123456789abcdef0123456789')

    await expect(取りに行く).rejects.toBeInstanceOf(GyazoApiError)
  })

  it('Gyazo が失敗を返したら GyazoApiError にする', async () => {
    const { fetchImpl } = 覚えるfetchGet(Response.json({ message: 'not found' }, { status: 404 }))
    const 取りに行く = createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl }).fetchOcr('存在しない画像')

    await expect(取りに行く).rejects.toBeInstanceOf(GyazoApiError)
    await expect(取りに行く).rejects.toThrow(/404/)
  })
})

describe('時間制限（issue #126）', () => {
  it('Gyazo が応答を返さないと、待ち続けずに TimeoutError にする', async () => {
    const fetchImpl = (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    const gyazo = createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl, timeoutMs: 10 })

    await expect(gyazo.fetchOcr('abcdef0123456789abcdef0123456789')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('アップロードにも同じ時間制限をかける', async () => {
    const fetchImpl = (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    const gyazo = createGyazoClient({ accessToken: 'テスト用のトークン', fetch: fetchImpl, timeoutMs: 10 })

    await expect(gyazo.upload(画像, 'screen.png')).rejects.toBeInstanceOf(TimeoutError)
  })
})
