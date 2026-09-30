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

const textFragments = (text: string): Fragment[] => [{ type: 'text', text }]

/** ビッツが付いた書き込みとして置き換える（Cheer でない書き込みは置き換えない仕様のため、既定でビッツ有りにする） */
const replace = (fragments: readonly Fragment[], bits = 500): Fragment[] => applyCheermotes(fragments, cheermotes, bits)

describe('applyCheermotes', () => {
  it('ビッツが付いていない書き込みは、同じ文字列があっても置き換えない（ただの「cheer100」という発言を絵にしない）', () => {
    expect(applyCheermotes(textFragments('cheer100 って書くとどうなるの？'), cheermotes, 0)).toEqual(
      textFragments('cheer100 って書くとどうなるの？'),
    )
  })

  it('「接頭辞＋ビッツ数」の単語を、ビッツ数に見合う段階の絵に置き換える', () => {
    expect(replace(textFragments('cheer500 おうえんしてます'))).toEqual([
      { type: 'cheer', name: 'cheer500', url: 'https://example.test/cheer/100.gif', amount: 500, color: '#9c3ee8' },
      { type: 'text', text: ' おうえんしてます' },
    ])
  })

  it('ビッツ数がちょうど段階の境目なら、その段階の絵にする', () => {
    const [fragment] = replace(textFragments('Cheer1000'), 1000)
    expect(fragment).toMatchObject({ url: 'https://example.test/cheer/1000.gif', color: '#1db2a5' })
  })

  it('接頭辞の大文字小文字は区別しない（視聴者は CHEER100 とも cheer100 とも書く）', () => {
    const [fragment] = replace(textFragments('CHEER100'), 100)
    expect(fragment).toMatchObject({ type: 'cheer', name: 'CHEER100', amount: 100 })
  })

  it('接頭辞だけ・数字だけの単語は置き換えない', () => {
    expect(replace(textFragments('cheer 100 たのしい'))).toEqual(textFragments('cheer 100 たのしい'))
  })

  it('知らない接頭辞は置き換えない', () => {
    expect(replace(textFragments('Kappa100'))).toEqual(textFragments('Kappa100'))
  })

  it('一覧が空なら、本文をそのまま返す（取得が終わる前に届いた書き込みを壊さない）', () => {
    expect(applyCheermotes(textFragments('cheer500 ありがとう'), new Map(), 500)).toEqual(textFragments('cheer500 ありがとう'))
  })

  it('エモートの断片には手を付けない', () => {
    const fragments: Fragment[] = [{ type: 'emote', name: 'Kappa', url: 'https://example.test/kappa.png' }]
    expect(replace(fragments)).toEqual(fragments)
  })
})

/** 決めた応答を返す fetch。呼ばれたパスも記録する */
const fetchReturning = (status: number, body: unknown) => {
  const paths: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    paths.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { paths, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('loadCheermotes', () => {
  const response = {
    cheermotes: [
      {
        prefix: 'Cheer',
        tiers: [{ minBits: 1, color: '#979797', imageUrl: 'https://example.test/cheer/1.gif' }],
      },
    ],
  }

  it('Workerから取得し、小文字の接頭辞から引ける表にする', async () => {
    const { paths, fetchImpl } = fetchReturning(200, response)
    const loaded = await loadCheermotes(fetchImpl)

    expect(paths).toEqual(['/api/chat/cheermotes'])
    expect(loaded.get('cheer')?.prefix).toBe('Cheer')
  })

  it('Workerが失敗を返したらエラーにする（黙って空の表にしない）', async () => {
    const { fetchImpl } = fetchReturning(400, { error: { code: 'invalid-broadcaster', message: '配信者IDが不正です' } })
    await expect(loadCheermotes(fetchImpl)).rejects.toThrow('配信者IDが不正です')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { cheermotes: [{ prefix: 'Cheer' }] })
    await expect(loadCheermotes(fetchImpl)).rejects.toThrow()
  })
})
