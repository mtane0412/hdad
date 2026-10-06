/**
 * ツイスターの呼び出しの読み取り（call.ts）のテスト
 *
 * Worker は、レイドを受けたとき（と管理画面の試し再生）に、対戦の種と2人（レイドした人・配信者）の名前とアイコンを
 * WebSocket で押し出す。合成ページはそれを読み、形が違えば黙って流さずに投げる（素材の箱に失敗を出す）。
 */
import { describe, expect, it } from 'vitest'
import { parseTwisterCall } from './call'

/** レイドの呼び出しの例 */
const raidCall = {
  id: 'b3c1a9e0-raid',
  seed: 3141592653,
  players: [
    { name: 'こわい話の人', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai.png' },
    { name: '配信者さん', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/haishin.png' },
  ],
}

describe('parseTwisterCall', () => {
  it('種と2人の名前・アイコンを読む', () => {
    expect(parseTwisterCall(JSON.stringify(raidCall))).toEqual(raidCall)
  })

  it('アイコンが無い人（試し再生の相手）は null のまま読む', () => {
    const demo = { ...raidCall, players: [{ name: 'レイドした人（試し）', iconUrl: null }, raidCall.players[1]] }
    expect(parseTwisterCall(JSON.stringify(demo)).players[0].iconUrl).toBeNull()
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseTwisterCall('{壊れた')).toThrow('JSON')
  })

  it('種が 0 以上 2^32 未満の整数でなければ投げる', () => {
    for (const seed of [-1, 1.5, 2 ** 32, '42']) {
      expect(() => parseTwisterCall(JSON.stringify({ ...raidCall, seed }))).toThrow('想定した形')
    }
  })

  it('2人そろっていない・名前が空・アイコンが https でなければ投げる', () => {
    const broken = [
      { ...raidCall, players: [raidCall.players[0]] },
      { ...raidCall, players: [{ name: '', iconUrl: null }, raidCall.players[1]] },
      { ...raidCall, players: [{ name: 'こわい話の人', iconUrl: 'javascript:alert(1)' }, raidCall.players[1]] },
    ]
    for (const call of broken) {
      expect(() => parseTwisterCall(JSON.stringify(call))).toThrow('想定した形')
    }
  })
})
