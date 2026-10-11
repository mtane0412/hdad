/**
 * ペロペロの呼び出しの読み取り（call.ts）のテスト
 *
 * Worker が押し出した文字列を読み、形が違えば黙って流さずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { parseLickCall } from './call'

const valid = {
  id: '呼び出しID',
  seed: 42,
  target: { name: '田中太郎', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanaka.png' },
  sound: { sound: '/api/media/media-juru?key=overlay-key', volume: 0.6 },
}

describe('parseLickCall', () => {
  it('種と舐める相手を読む', () => {
    expect(parseLickCall(JSON.stringify(valid))).toEqual(valid)
  })

  it('効果音を鳴らさない（null）呼び出しも読む', () => {
    const call = { ...valid, sound: { sound: null, volume: 0.6 } }
    expect(parseLickCall(JSON.stringify(call))).toEqual(call)
  })

  it('アイコンが null の相手（頭文字の顔にする）も読む', () => {
    const call = { ...valid, target: { name: '田中太郎', iconUrl: null } }
    expect(parseLickCall(JSON.stringify(call))).toEqual(call)
  })

  it('JSON として読めなければ投げる', () => {
    expect(() => parseLickCall('ぺろぺろ')).toThrowError(/JSONとして読めません/)
  })

  it.each([
    ['種が整数でない', { ...valid, seed: 1.5 }],
    ['種が負', { ...valid, seed: -1 }],
    ['種が2^32以上', { ...valid, seed: 2 ** 32 }],
    ['名前が空', { ...valid, target: { name: '', iconUrl: null } }],
    ['アイコンが https でない', { ...valid, target: { name: '田中太郎', iconUrl: 'http://example.com/tanaka.png' } }],
    ['相手が無い', { id: '呼び出しID', seed: 42, sound: valid.sound }],
    ['効果音の設定が無い', { id: '呼び出しID', seed: 42, target: valid.target }],
    ['効果音の音量が数でない', { ...valid, sound: { sound: null, volume: '大きめ' } }],
  ])('%sなら投げる', (_, call) => {
    expect(() => parseLickCall(JSON.stringify(call))).toThrowError(/想定した形ではありません/)
  })
})
