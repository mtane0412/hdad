/**
 * BGMの次の曲・前の曲の決め方（bgm-order.ts）のテスト
 *
 * 確かめること:
 * - 通常の再生では一覧の順に進み、最後の曲の次は最初の曲に戻ること（配信のBGMを黙って途切れさせないため）
 * - シャッフルでは、いま流している曲以外から選ぶこと（同じ曲が続かないように）
 * - 止めているときは、次なら最初の曲（シャッフルなら任意の曲）、前なら最後の曲から始めること
 * - 曲が1つも無ければ null を返すこと
 */
import { describe, expect, it } from 'vitest'
import type { BgmTrack } from './bgm-config'
import { steppedMediaIdOf } from './bgm-order'

/** 曲名だけ違う曲を作る */
const trackOf = (mediaId: string, title: string): BgmTrack => ({ mediaId, title, credit: '音楽: テスト', creditUrl: '', mood: '', scene: '' })

const opening = trackOf('media-opening', 'はじまりの曲')
const chatting = trackOf('media-chatting', '雑談の曲')
const ending = trackOf('media-ending', 'おわりの曲')
const tracks = [opening, chatting, ending]

/** 乱数を固定する。0 なら候補の先頭、0.99 なら候補の最後を選ぶ */
const fixedRandom = (value: number) => () => value

describe('steppedMediaIdOf（通常の再生）', () => {
  it('次の曲は一覧の順に進む', () => {
    expect(steppedMediaIdOf(tracks, opening.mediaId, 'next', false, fixedRandom(0))).toBe(chatting.mediaId)
  })

  it('最後の曲の次は最初の曲に戻る', () => {
    expect(steppedMediaIdOf(tracks, ending.mediaId, 'next', false, fixedRandom(0))).toBe(opening.mediaId)
  })

  it('前の曲は一覧の順に戻り、最初の曲の前は最後の曲になる', () => {
    expect(steppedMediaIdOf(tracks, chatting.mediaId, 'previous', false, fixedRandom(0))).toBe(opening.mediaId)
    expect(steppedMediaIdOf(tracks, opening.mediaId, 'previous', false, fixedRandom(0))).toBe(ending.mediaId)
  })

  it('止めているときは、次なら最初の曲、前なら最後の曲から始める', () => {
    expect(steppedMediaIdOf(tracks, null, 'next', false, fixedRandom(0))).toBe(opening.mediaId)
    expect(steppedMediaIdOf(tracks, null, 'previous', false, fixedRandom(0))).toBe(ending.mediaId)
  })

  it('曲が1つだけなら、次の曲もその曲になる', () => {
    expect(steppedMediaIdOf([chatting], chatting.mediaId, 'next', false, fixedRandom(0))).toBe(chatting.mediaId)
  })

  it('曲が1つも無ければ null を返す', () => {
    expect(steppedMediaIdOf([], null, 'next', false, fixedRandom(0))).toBeNull()
  })
})

describe('steppedMediaIdOf（シャッフル）', () => {
  it('次の曲は、いま流している曲以外から選ぶ', () => {
    expect(steppedMediaIdOf(tracks, opening.mediaId, 'next', true, fixedRandom(0))).toBe(chatting.mediaId)
    expect(steppedMediaIdOf(tracks, opening.mediaId, 'next', true, fixedRandom(0.99))).toBe(ending.mediaId)
  })

  it('止めているときは、すべての曲から選ぶ', () => {
    expect(steppedMediaIdOf(tracks, null, 'next', true, fixedRandom(0))).toBe(opening.mediaId)
  })

  it('曲が1つだけなら、その曲を選ぶ', () => {
    expect(steppedMediaIdOf([chatting], chatting.mediaId, 'next', true, fixedRandom(0.5))).toBe(chatting.mediaId)
  })

  it('前の曲はシャッフルでも一覧の順に戻る（選んだ順を覚えていないため）', () => {
    expect(steppedMediaIdOf(tracks, chatting.mediaId, 'previous', true, fixedRandom(0.99))).toBe(opening.mediaId)
  })
})
