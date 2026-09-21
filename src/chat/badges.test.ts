/**
 * 公式バッジ画像の取得（badges.ts）のテスト
 *
 * Workerの公開API（/api/chat/badges）を呼び、「種類/版」から画像を引ける表になることを確認する。
 * 実際の通信はせず、fetch を差し替える。
 */
import { describe, expect, it } from 'vitest'
import { badgeKey, loadBadges } from './badges'

const 応答 = {
  badges: [
    {
      setId: 'broadcaster',
      versions: [{ id: '1', imageUrl: 'https://example.test/badges/broadcaster.png', title: 'Broadcaster' }],
    },
    {
      setId: 'subscriber',
      versions: [
        { id: '0', imageUrl: 'https://example.test/badges/sub-0.png', title: 'Subscriber' },
        { id: '12', imageUrl: 'https://example.test/badges/sub-12.png', title: '1-Year Subscriber' },
      ],
    },
  ],
}

/** 決めた応答を返す fetch。呼ばれたパスも記録する */
const 応答を返すfetch = (status: number, body: unknown) => {
  const paths: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    paths.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { paths, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('loadBadges', () => {
  it('Workerから取得し、「種類/版」から画像を引ける表にする', async () => {
    const { paths, fetchImpl } = 応答を返すfetch(200, 応答)
    const badges = await loadBadges(fetchImpl)

    expect(paths).toEqual(['/api/chat/badges'])
    expect(badges.get(badgeKey({ setId: 'subscriber', versionId: '12' }))).toEqual({
      url: 'https://example.test/badges/sub-12.png',
      title: '1-Year Subscriber',
    })
    expect(badges.get(badgeKey({ setId: 'broadcaster', versionId: '1' }))).toEqual({
      url: 'https://example.test/badges/broadcaster.png',
      title: 'Broadcaster',
    })
  })

  it('取得していない種類・版を引くと undefined になる（表示側が自前の絵に切り替えられるようにする）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, 応答)
    const badges = await loadBadges(fetchImpl)
    expect(badges.get(badgeKey({ setId: 'subscriber', versionId: '99' }))).toBeUndefined()
  })

  it('Workerが失敗を返したらエラーにする（黙って空の表にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(400, { error: { code: 'invalid-broadcaster', message: '配信者IDが不正です' } })
    await expect(loadBadges(fetchImpl)).rejects.toThrow('配信者IDが不正です')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { badges: [{ setId: 'broadcaster' }] })
    await expect(loadBadges(fetchImpl)).rejects.toThrow()
  })
})
