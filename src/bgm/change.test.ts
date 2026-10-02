/**
 * BGMの切り替え方の判断（change.ts）のテスト
 *
 * 裏方のページは、届いた「いま流している曲」と自分が鳴らしている曲を比べて、何をするかを決める。
 * 同じ曲なら鳴らし直さない（曲の情報を直しただけで頭から流れ直さないため）ことを特に確かめる。
 * リピートを入れているあいだは曲をループで鳴らし、切っているあいだは曲の終わりで止まる（次の曲は Worker が決める）。
 */
import { describe, expect, it } from 'vitest'
import type { BgmNowPlaying } from './api'
import { bgmChangeOf } from './change'

const chatTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  url: '/api/media/media-zatsudan?key=k',
}
const hypeTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  url: '/api/media/media-moriagari?key=k',
}

const playing = (track: BgmNowPlaying['track'], volume = 0.3, repeat = false): BgmNowPlaying => ({ track, volume, repeat, shuffle: false })

describe('bgmChangeOf', () => {
  it('何も鳴らしていないところへ曲が届いたら、その曲に切り替える', () => {
    expect(bgmChangeOf(null, playing(chatTrack))).toEqual({ type: 'switch', url: chatTrack.url, volume: 0.3, loop: false })
  })

  it('別の曲が届いたら、その曲に切り替える', () => {
    expect(bgmChangeOf(playing(chatTrack), playing(hypeTrack, 0.5))).toEqual({ type: 'switch', url: hypeTrack.url, volume: 0.5, loop: false })
  })

  it('同じ曲で音量だけが違えば、鳴らし直さず音量だけを変える', () => {
    expect(bgmChangeOf(playing(chatTrack, 0.3), playing(chatTrack, 0.6))).toEqual({ type: 'adjust', volume: 0.6, loop: false })
  })

  it('リピートを入れた曲に切り替えるときは、ループで鳴らす', () => {
    expect(bgmChangeOf(null, playing(chatTrack, 0.3, true))).toEqual({ type: 'switch', url: chatTrack.url, volume: 0.3, loop: true })
  })

  it('同じ曲でリピートだけが変われば、鳴らし直さずループするかだけを変える', () => {
    expect(bgmChangeOf(playing(chatTrack, 0.3, false), playing(chatTrack, 0.3, true))).toEqual({ type: 'adjust', volume: 0.3, loop: true })
  })

  it('シャッフルだけが変わっても何もしない（次の曲を決めるのは Worker のため）', () => {
    expect(bgmChangeOf(playing(chatTrack), { ...playing(chatTrack), shuffle: true })).toEqual({ type: 'none' })
  })

  it('同じ曲・同じ音量なら何もしない（曲名を直しただけでは頭から流れ直さない）', () => {
    expect(bgmChangeOf(playing(chatTrack), playing({ ...chatTrack, title: 'ひだまりの午後（ピアノ版）' }))).toEqual({ type: 'none' })
  })

  it('止めたことが届いたら止める', () => {
    expect(bgmChangeOf(playing(chatTrack), playing(null))).toEqual({ type: 'stop' })
  })

  it('何も鳴らしていないところへ「止めている」が届いたら何もしない', () => {
    expect(bgmChangeOf(null, playing(null))).toEqual({ type: 'none' })
    expect(bgmChangeOf(playing(null), playing(null, 0.8))).toEqual({ type: 'none' })
  })
})
