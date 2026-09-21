/**
 * Cheermote（ビッツの絵）の取得と本文への適用（cheermotes.ts）のテスト
 *
 * Cheer の書き込みは、本文に「接頭辞＋ビッツ数」（例: cheer500）という単語が入って届く。
 * Twitch公式エモートと違って本文中の位置は届かないため、単語として見つけて置き換える。
 */
import { describe, expect, it } from 'vitest'
import { applyCheermotes, loadCheermotes, type CheermoteMap } from './cheermotes'
import type { Fragment } from './message'

/** 前提: 全体の「Cheer」（1・100・1000ビッツの3段階） */
const cheermotes: CheermoteMap = new Map([
  [
    'cheer',
    {
      prefix: 'Cheer',
      tiers: [
        { minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1.gif' },
        { minBits: 100, color: '#9c3ee8', imageUrl: 'https://example.test/cheer/100.gif' },
        { minBits: 1000, color: '#1db2a5', imageUrl: 'https://example.test/cheer/1000.gif' },
      ],
    },
  ],
])

const 文字の断片 = (text: string): Fragment[] => [{ type: 'text', text }]

describe('applyCheermotes', () => {
  it('「接頭辞＋ビッツ数」の単語を、ビッツ数に見合う段階の絵に置き換える', () => {
    expect(applyCheermotes(文字の断片('cheer500 おうえんしてます'), cheermotes)).toEqual([
      { type: 'cheer', name: 'cheer500', url: 'https://example.test/cheer/100.gif', amount: 500, color: '#9c3ee8' },
      { type: 'text', text: ' おうえんしてます' },
    ])
  })

  it('ビッツ数がちょうど段階の境目なら、その段階の絵にする', () => {
    const [fragment] = applyCheermotes(文字の断片('Cheer1000'), cheermotes)
    expect(fragment).toMatchObject({ url: 'https://example.test/cheer/1000.gif', color: '#1db2a5' })
  })

  it('接頭辞の大文字小文字は区別しない（視聴者は CHEER100 とも cheer100 とも書く）', () => {
    const [fragment] = applyCheermotes(文字の断片('CHEER100'), cheermotes)
    expect(fragment).toMatchObject({ type: 'cheer', name: 'CHEER100', amount: 100 })
  })

  it('接頭辞だけ・数字だけの単語は置き換えない', () => {
    expect(applyCheermotes(文字の断片('cheer 100 たのしい'), cheermotes)).toEqual(文字の断片('cheer 100 たのしい'))
  })

  it('知らない接頭辞は置き換えない', () => {
    expect(applyCheermotes(文字の断片('Kappa100'), cheermotes)).toEqual(文字の断片('Kappa100'))
  })

  it('一覧が空なら、本文をそのまま返す（取得が終わる前に届いた書き込みを壊さない）', () => {
    expect(applyCheermotes(文字の断片('cheer500 ありがとう'), new Map())).toEqual(文字の断片('cheer500 ありがとう'))
  })

  it('エモートの断片には手を付けない', () => {
    const fragments: Fragment[] = [{ type: 'emote', name: 'Kappa', url: 'https://example.test/kappa.png' }]
    expect(applyCheermotes(fragments, cheermotes)).toEqual(fragments)
  })
})

/** 決めた応答を返す fetch。呼ばれたパスも記録する */
const 応答を返すfetch = (status: number, body: unknown) => {
  const paths: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    paths.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { paths, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('loadCheermotes', () => {
  const 応答 = {
    cheermotes: [
      {
        prefix: 'Cheer',
        tiers: [{ minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1.gif' }],
      },
    ],
  }

  it('Workerに配信者IDを渡して取得し、小文字の接頭辞から引ける表にする', async () => {
    const { paths, fetchImpl } = 応答を返すfetch(200, 応答)
    const loaded = await loadCheermotes('12345', fetchImpl)

    expect(paths).toEqual(['/api/chat/cheermotes?broadcaster=12345'])
    expect(loaded.get('cheer')?.prefix).toBe('Cheer')
  })

  it('Workerが失敗を返したらエラーにする（黙って空の表にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(400, { error: { code: 'invalid-broadcaster', message: '配信者IDが不正です' } })
    await expect(loadCheermotes('12345', fetchImpl)).rejects.toThrow('配信者IDが不正です')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { cheermotes: [{ prefix: 'Cheer' }] })
    await expect(loadCheermotes('12345', fetchImpl)).rejects.toThrow()
  })
})
