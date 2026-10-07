/**
 * ツイスターの呼び出しの組み立て（twister-call.ts）のテスト
 *
 * Worker は対戦の種と2人（レイドした人・配信者）の名前とアイコンだけを押し出す。対戦の中身は合成ページが種から計算する。
 * 種は 0 以上 2^32 未満の整数で、合成ページの読み取り（src/twister/call.ts の parseTwisterCall）がそのまま受け取れる形にする。
 */
import { describe, expect, it } from 'vitest'
import { parseTwisterCall } from '../src/twister/call'
import { demoTwisterCallOf, twisterCallOf, twisterSeedOf } from './twister-call'

const raid = { raiderId: '1111', raiderName: '山田花子', broadcasterName: 'たねのぶ' }
const icons = {
  '1111': 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png',
  '9999': 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png',
}

describe('twisterCallOf', () => {
  it('レイドした人を0番、配信者を1番にして、名前とアイコンを並べる', () => {
    expect(twisterCallOf(raid, icons, '9999', 42, '呼び出しID')).toEqual({
      id: '呼び出しID',
      seed: 42,
      players: [
        { name: '山田花子', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png' },
        { name: 'たねのぶ', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenobu.png' },
      ],
    })
  })

  it('Twitch がアイコンを返さなかった人（消えたアカウントなど）は、アイコンを null にする（頭文字の顔で流す）', () => {
    const call = twisterCallOf(raid, { '9999': icons['9999'] }, '9999', 42, '呼び出しID')
    expect(call.players[0].iconUrl).toBeNull()
  })

  it('合成ページの読み取りが、そのまま同じ呼び出しとして読める', () => {
    const call = twisterCallOf(raid, icons, '9999', 4294967295, '呼び出しID')
    expect(parseTwisterCall(JSON.stringify(call))).toEqual(call)
  })
})

describe('demoTwisterCallOf', () => {
  it('試し再生の相手はアイコンを持たず、配信者は自分のアイコンで対戦する', () => {
    const call = demoTwisterCallOf(null, icons['9999'] ?? null, 7, '試しID')
    expect(call.players[0]).toEqual({ name: 'レイドした人（試し）', iconUrl: null })
    expect(call.players[1]).toEqual({ name: '配信者', iconUrl: icons['9999'] })
    expect(parseTwisterCall(JSON.stringify(call))).toEqual(call)
  })

  it('相手を渡せば、試しの相手の代わりにその人の名前とアイコンで対戦する', () => {
    const raider = { name: '山田花子', iconUrl: icons['1111'] ?? null }
    const call = demoTwisterCallOf(raider, icons['9999'] ?? null, 7, '試しID')
    expect(call.players).toEqual([raider, { name: '配信者', iconUrl: icons['9999'] }])
    expect(parseTwisterCall(JSON.stringify(call))).toEqual(call)
  })
})

describe('twisterSeedOf', () => {
  it('乱数の32ビットの値を、そのまま0以上2^32未満の種にする', () => {
    expect(twisterSeedOf(new Uint32Array([0]))).toBe(0)
    expect(twisterSeedOf(new Uint32Array([4294967295]))).toBe(4294967295)
  })

  it('値が入っていなければ投げる', () => {
    expect(() => twisterSeedOf(new Uint32Array(0))).toThrow()
  })
})
