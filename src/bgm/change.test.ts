/**
 * BGMの切り替え方の判断（change.ts）のテスト
 *
 * 裏方のページは、届いた「いま流している曲」と自分が鳴らしている曲を比べて、何をするかを決める。
 * 同じ曲なら鳴らし直さない（曲の情報を直しただけで頭から流れ直さないため）ことを特に確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { BgmNowPlaying } from './api'
import { bgmChangeOf } from './change'

const 雑談の曲 = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  url: '/api/media/media-zatsudan?key=k',
}
const 盛り上がる曲 = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  url: '/api/media/media-moriagari?key=k',
}

const 流している = (track: BgmNowPlaying['track'], volume = 0.3): BgmNowPlaying => ({ track, volume })

describe('bgmChangeOf', () => {
  it('何も鳴らしていないところへ曲が届いたら、その曲に切り替える', () => {
    expect(bgmChangeOf(null, 流している(雑談の曲))).toEqual({ type: 'switch', url: 雑談の曲.url, volume: 0.3 })
  })

  it('別の曲が届いたら、その曲に切り替える', () => {
    expect(bgmChangeOf(流している(雑談の曲), 流している(盛り上がる曲, 0.5))).toEqual({ type: 'switch', url: 盛り上がる曲.url, volume: 0.5 })
  })

  it('同じ曲で音量だけが違えば、鳴らし直さず音量だけを変える', () => {
    expect(bgmChangeOf(流している(雑談の曲, 0.3), 流している(雑談の曲, 0.6))).toEqual({ type: 'volume', volume: 0.6 })
  })

  it('同じ曲・同じ音量なら何もしない（曲名を直しただけでは頭から流れ直さない）', () => {
    expect(bgmChangeOf(流している(雑談の曲), 流している({ ...雑談の曲, title: 'ひだまりの午後（ピアノ版）' }))).toEqual({ type: 'none' })
  })

  it('止めたことが届いたら止める', () => {
    expect(bgmChangeOf(流している(雑談の曲), 流している(null))).toEqual({ type: 'stop' })
  })

  it('何も鳴らしていないところへ「止めている」が届いたら何もしない', () => {
    expect(bgmChangeOf(null, 流している(null))).toEqual({ type: 'none' })
    expect(bgmChangeOf(流している(null), 流している(null, 0.8))).toEqual({ type: 'none' })
  })
})
