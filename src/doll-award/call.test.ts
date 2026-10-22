/**
 * 人形の獲得の読み取り（call.ts）のテスト
 *
 * Worker（worker/doll-award.ts・worker/doll-standing.ts）が押し出す文字列を、合成ページが次のとおり読むことを確かめる。
 * - 獲得（award）・1人ぶんの所持数（standing）・ランキング（ranking）を、想定した形ならそのまま読むこと
 * - JSON でない・知らない type・項目が欠けた・値の型や範囲が違う場合は、黙って流さずに投げること
 * - 画像の URL は Worker の素材の経路（/api/media/）だけを受け付けること（よその URL を映さない）
 */
import { describe, expect, it } from 'vitest'
import { parseDollAwardMessage, type DollAwardCall, type DollRankingCall, type DollStandingCall } from './call'

/** 田中太郎さんがクマ人形を1つ獲得した */
const tanakaGotBear: DollAwardCall = {
  type: 'award',
  id: 'kanjiQuiz:quiz-kusabana',
  userName: '田中太郎',
  kind: 'normal',
  count: 1,
  doll: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=overlay-key' },
}

/** 田中太郎さんは、クマ人形を2つ持ち、スーパークマ人形は持っていない */
const tanakaStanding: DollStandingCall = {
  type: 'standing',
  id: 'standing-1',
  userId: '1001',
  userName: '田中太郎',
  normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k', count: 2 },
  super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k', count: 0 },
}

/** 花子さん（3点）と田中太郎さん（2点）のランキング */
const ranking: DollRankingCall = {
  type: 'ranking',
  id: 'ranking-1',
  normal: { name: 'クマ人形', imageUrl: '/api/media/image-bear?key=k' },
  super: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k' },
  entries: [
    { rank: 1, userName: '花子', normal: 0, super: 1, points: 3 },
    { rank: 2, userName: '田中太郎', normal: 2, super: 0, points: 2 },
  ],
}

describe('parseDollAwardMessage', () => {
  it('想定した形なら、獲得として読む', () => {
    expect(parseDollAwardMessage(JSON.stringify(tanakaGotBear))).toEqual(tanakaGotBear)
  })

  it('スーパー人形を3つ獲得したものも読む', () => {
    const superAward = { ...tanakaGotBear, kind: 'super', count: 3, doll: { name: 'スーパークマ人形', imageUrl: '/api/media/image-super-bear?key=k' } }

    expect(parseDollAwardMessage(JSON.stringify(superAward))).toEqual(superAward)
  })

  it('1人ぶんの所持数を読む（0 つも受け付ける）', () => {
    expect(parseDollAwardMessage(JSON.stringify(tanakaStanding))).toEqual(tanakaStanding)
  })

  it('ランキングを読む（まだ誰も持っていない 0 人のランキングも受け付ける）', () => {
    expect(parseDollAwardMessage(JSON.stringify(ranking))).toEqual(ranking)
    expect(parseDollAwardMessage(JSON.stringify({ ...ranking, entries: [] }))).toEqual({ ...ranking, entries: [] })
  })

  it('JSON として読めなければ投げる', () => {
    expect(() => parseDollAwardMessage('人形をあげた')).toThrowError(/JSON/)
  })

  it.each([
    ['type が無い', { ...tanakaGotBear, type: undefined }],
    ['知らない type', { ...tanakaGotBear, type: 'trade' }],
    ['視聴者の名前が空', { ...tanakaGotBear, userName: '' }],
    ['知らない種類', { ...tanakaGotBear, kind: 'golden' }],
    ['個数が0', { ...tanakaGotBear, count: 0 }],
    ['個数が整数でない', { ...tanakaGotBear, count: 1.5 }],
    ['人形の名前が空', { ...tanakaGotBear, doll: { ...tanakaGotBear.doll, name: '' } }],
    ['画像が素材の経路でない', { ...tanakaGotBear, doll: { ...tanakaGotBear.doll, imageUrl: 'https://example.com/bear.png' } }],
    ['人形が無い', { ...tanakaGotBear, doll: null }],
    ['所持数の名前が空', { ...tanakaStanding, userName: '' }],
    ['所持数のユーザーIDが空', { ...tanakaStanding, userId: '' }],
    ['所持数が負', { ...tanakaStanding, normal: { ...tanakaStanding.normal, count: -1 } }],
    ['所持数の画像が素材の経路でない', { ...tanakaStanding, super: { ...tanakaStanding.super, imageUrl: 'https://example.com/bear.png' } }],
    ['ランキングの並びが配列でない', { ...ranking, entries: null }],
    ['ランキングの順位が0', { ...ranking, entries: [{ ...ranking.entries[0], rank: 0 }] }],
    ['ランキングの名前が空', { ...ranking, entries: [{ ...ranking.entries[0], userName: '' }] }],
    ['ランキングの人形が無い', { ...ranking, normal: null }],
  ])('%sなら投げる', (_label, body) => {
    expect(() => parseDollAwardMessage(JSON.stringify(body))).toThrowError(/想定した形ではありません/)
  })
})
