/**
 * ペロペロの呼び出しの組み立て（lick-call.ts）のテスト
 *
 * Worker は舐め方の種と、舐める相手1人の名前とアイコンだけを押し出す。舐め方の中身は合成ページが種から計算する。
 * 種は 0 以上 2^32 未満の整数で、合成ページの読み取り（src/lick/call.ts の parseLickCall）がそのまま受け取れる形にする。
 */
import { describe, expect, it } from 'vitest'
import { parseLickCall } from '../src/lick/call'
import { demoLickCallOf, lickCallOf, lickSeedOf } from './lick-call'

/** 舐めるたびに鳴らす効果音（Worker が音声のURLに置き換えたもの） */
const sound = { sound: '/api/media/media-juru?key=issued-overlay-key-0123456789abcdefghij', volume: 0.6 }

describe('lickCallOf', () => {
  it('舐める相手の名前とアイコンを、種と効果音と一緒に並べる', () => {
    expect(lickCallOf({ name: '田中太郎', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanaka.png' }, sound, 42, '呼び出しID')).toEqual({
      id: '呼び出しID',
      seed: 42,
      target: { name: '田中太郎', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanaka.png' },
      sound,
    })
  })

  it('合成ページの読み取りが、そのまま同じ呼び出しとして読める（アイコンが無い相手も）', () => {
    const call = lickCallOf({ name: '田中太郎', iconUrl: null }, { sound: null, volume: 0.6 }, 4294967295, '呼び出しID')
    expect(parseLickCall(JSON.stringify(call))).toEqual(call)
  })
})

describe('demoLickCallOf', () => {
  it('相手を指定しなければ、アイコンの無い試しの相手を舐める', () => {
    expect(demoLickCallOf(null, sound, 7, '呼び出しID').target).toEqual({ name: '視聴者（試し）', iconUrl: null })
  })

  it('相手を指定すれば、その人を舐める', () => {
    const target = { name: '山田花子', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png' }
    expect(demoLickCallOf(target, sound, 7, '呼び出しID').target).toEqual(target)
  })
})

describe('lickSeedOf', () => {
  it('乱数の32ビットの値をそのまま種にする', () => {
    expect(lickSeedOf(new Uint32Array([123456789]))).toBe(123456789)
  })

  it('値が入っていなければ投げる', () => {
    expect(() => lickSeedOf(new Uint32Array(0))).toThrowError(/種にする乱数がありません/)
  })
})
