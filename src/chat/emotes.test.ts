/**
 * サードパーティエモート（emotes.ts）のテスト
 *
 * 7TV・BTTV・FFZ の公開APIの応答からエモート名と画像URLの対応表を作り、
 * 本文中の単語をエモートに置き換えられることを確認する。外部APIは偽の fetch に差し替える。
 */
import { describe, expect, it } from 'vitest'
import { applyEmotes, loadThirdPartyEmotes, type FetchJson } from './emotes'

/** 前提: 各サービスの応答を、実際のAPIと同じ形で最小限に再現したもの */
const 応答一覧: Record<string, unknown> = {
  'https://7tv.io/v3/emote-sets/global': {
    emotes: [{ name: 'RainTime', data: { host: { url: '//cdn.7tv.app/emote/01AAA' } } }],
  },
  'https://7tv.io/v3/users/twitch/123': {
    emote_set: { emotes: [{ name: 'tanePog', data: { host: { url: '//cdn.7tv.app/emote/01BBB' } } }] },
  },
  'https://api.betterttv.net/3/cached/emotes/global': [{ id: 'aaa111', code: 'CiGrip' }],
  'https://api.betterttv.net/3/cached/users/twitch/123': {
    channelEmotes: [{ id: 'bbb222', code: 'taneDance' }],
    sharedEmotes: [{ id: 'ccc333', code: 'catJAM' }],
  },
  'https://api.frankerfacez.com/v1/set/global': {
    default_sets: [3],
    sets: {
      '3': { emoticons: [{ name: 'ZrehplaR', urls: { '1': 'https://cdn.frankerfacez.com/emote/9/1', '2': 'https://cdn.frankerfacez.com/emote/9/2' } }] },
      '999': { emoticons: [{ name: '既定ではないセット', urls: { '1': 'https://cdn.frankerfacez.com/emote/1/1' } }] },
    },
  },
  'https://api.frankerfacez.com/v1/room/id/123': {
    sets: { '77': { emoticons: [{ name: 'taneWave', urls: { '1': 'https://cdn.frankerfacez.com/emote/5/1' } }] } },
  },
}

/** 応答一覧から返す偽の fetch。一覧にないURLは「未登録（404）」として undefined を返す */
const 偽のfetch =
  (応答: Record<string, unknown>): FetchJson =>
  (url) =>
    Promise.resolve(応答[url])

describe('loadThirdPartyEmotes', () => {
  it('3サービスの全体用・チャンネル用エモートを、名前から画像URLを引ける表にまとめる', async () => {
    const { emotes, failures } = await loadThirdPartyEmotes('123', 偽のfetch(応答一覧))
    expect(failures).toEqual([])
    expect(Object.fromEntries(emotes)).toEqual({
      RainTime: 'https://cdn.7tv.app/emote/01AAA/2x.webp',
      tanePog: 'https://cdn.7tv.app/emote/01BBB/2x.webp',
      CiGrip: 'https://cdn.betterttv.net/emote/aaa111/2x',
      taneDance: 'https://cdn.betterttv.net/emote/bbb222/2x',
      catJAM: 'https://cdn.betterttv.net/emote/ccc333/2x',
      ZrehplaR: 'https://cdn.frankerfacez.com/emote/9/2',
      taneWave: 'https://cdn.frankerfacez.com/emote/5/1',
    })
  })

  it('チャンネルがそのサービスに未登録（404）でも失敗にはせず、全体用エモートだけを使う', async () => {
    const 全体用だけ = Object.fromEntries(Object.entries(応答一覧).filter(([url]) => !url.endsWith('/123')))
    const { emotes, failures } = await loadThirdPartyEmotes('123', 偽のfetch(全体用だけ))
    expect(failures).toEqual([])
    expect([...emotes.keys()].sort()).toEqual(['CiGrip', 'RainTime', 'ZrehplaR'])
  })

  it('あるサービスの取得に失敗しても、他のサービスのエモートは使え、失敗したサービス名が分かる', async () => {
    const BTTVだけ落ちている: FetchJson = (url) =>
      url.includes('betterttv') ? Promise.reject(new Error('通信エラー')) : Promise.resolve(応答一覧[url])
    const { emotes, failures } = await loadThirdPartyEmotes('123', BTTVだけ落ちている)
    expect(failures).toEqual(['BTTV'])
    expect(emotes.has('tanePog')).toBe(true)
    expect(emotes.has('CiGrip')).toBe(false)
  })

  it('応答の形が想定と違うサービスは、失敗として扱う', async () => {
    const 形が違う = { ...応答一覧, 'https://7tv.io/v3/emote-sets/global': { emotes: 'これは配列ではない' } }
    const { failures } = await loadThirdPartyEmotes('123', 偽のfetch(形が違う))
    expect(failures).toEqual(['7TV'])
  })

  it('同じ名前のエモートは、チャンネル用を全体用より優先する', async () => {
    const 名前が重複 = {
      ...応答一覧,
      'https://api.betterttv.net/3/cached/emotes/global': [{ id: 'global1', code: 'おなじ名前' }],
      'https://api.betterttv.net/3/cached/users/twitch/123': {
        channelEmotes: [{ id: 'channel1', code: 'おなじ名前' }],
        sharedEmotes: [],
      },
    }
    const { emotes } = await loadThirdPartyEmotes('123', 偽のfetch(名前が重複))
    expect(emotes.get('おなじ名前')).toBe('https://cdn.betterttv.net/emote/channel1/2x')
  })
})

describe('applyEmotes', () => {
  const 対応表 = new Map([['catJAM', 'https://cdn.betterttv.net/emote/ccc333/2x']])

  it('空白で区切られた単語がエモート名と一致したら、エモートに置き換える', () => {
    expect(applyEmotes([{ type: 'text', text: 'のってきた catJAM たのしい' }], 対応表)).toEqual([
      { type: 'text', text: 'のってきた ' },
      { type: 'emote', name: 'catJAM', url: 'https://cdn.betterttv.net/emote/ccc333/2x' },
      { type: 'text', text: ' たのしい' },
    ])
  })

  it('単語の一部に含まれるだけでは置き換えない', () => {
    const 断片 = [{ type: 'text', text: 'catJAMMER' }] as const
    expect(applyEmotes(断片, 対応表)).toEqual(断片)
  })

  it('Twitch公式エモートの断片はそのまま残す', () => {
    const 断片 = [{ type: 'emote', name: 'Kappa', url: 'https://example.com/kappa' }] as const
    expect(applyEmotes(断片, 対応表)).toEqual(断片)
  })
})
