/**
 * 人形の獲得の読み取り（call.ts）のテスト
 *
 * Worker（worker/doll-award.ts）が押し出す文字列を、合成ページが次のとおり読むことを確かめる。
 * - 想定した形なら、そのまま獲得として読むこと
 * - JSON でない・項目が欠けた・値の型や範囲が違う場合は、黙って流さずに投げること
 * - 画像の URL は Worker の素材の経路（/api/media/）だけを受け付けること（よその URL を映さない）
 */
import { describe, expect, it } from 'vitest'
import { parseDollAwardCall, type DollAwardCall } from './call'

/** 田中太郎さんがクマ人形を1つ獲得した */
const tanakaGotBear: DollAwardCall = {
  id: 'kanjiQuiz:quiz-kusabana',
  userName: '田中太郎',
  kind: 'normal',
  count: 1,
  doll: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=overlay-key' },
}

describe('parseDollAwardCall', () => {
  it('想定した形なら、獲得として読む', () => {
    expect(parseDollAwardCall(JSON.stringify(tanakaGotBear))).toEqual(tanakaGotBear)
  })

  it('スーパー人形を3つ獲得したものも読む', () => {
    const superAward = { ...tanakaGotBear, kind: 'super', count: 3, doll: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k' } }

    expect(parseDollAwardCall(JSON.stringify(superAward))).toEqual(superAward)
  })

  it('JSON として読めなければ投げる', () => {
    expect(() => parseDollAwardCall('人形をあげた')).toThrowError(/JSON/)
  })

  it.each([
    ['視聴者の名前が空', { ...tanakaGotBear, userName: '' }],
    ['知らない種類', { ...tanakaGotBear, kind: 'golden' }],
    ['個数が0', { ...tanakaGotBear, count: 0 }],
    ['個数が整数でない', { ...tanakaGotBear, count: 1.5 }],
    ['人形の名前が空', { ...tanakaGotBear, doll: { ...tanakaGotBear.doll, name: '' } }],
    ['画像が素材の経路でない', { ...tanakaGotBear, doll: { ...tanakaGotBear.doll, imageUrl: 'https://example.com/bear.png' } }],
    ['人形が無い', { ...tanakaGotBear, doll: null }],
  ])('%sなら投げる', (_label, body) => {
    expect(() => parseDollAwardCall(JSON.stringify(body))).toThrowError(/想定した形ではありません/)
  })
})
