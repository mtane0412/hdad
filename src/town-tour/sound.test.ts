/**
 * 市町村紹介の音の枠と、押し出された音の読み取り（sound.ts）のテスト
 *
 * 合成ページが受け取った音の設定を、補わずに読むことを確かめる。音を選んでいない枠（null）は鳴らさない枠として通し、
 * 形が違うものは黙って無音にせずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { TOWN_TOUR_SOUND_SLOTS, readPlaybackSound } from './sound'

/** BGM と着地の音だけを選んだ設定（Worker が押し出す形） */
const bgmAndLanding = {
  slots: {
    bgm: '/api/media/media-cookie?key=overlay-key',
    opening: null,
    zoom: null,
    landing: '/api/media/media-peta?key=overlay-key',
    item: null,
    closing: null,
  },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

describe('TOWN_TOUR_SOUND_SLOTS', () => {
  it('枠は演出で鳴る順に並んでいる（管理画面の並びにも使う）', () => {
    expect(TOWN_TOUR_SOUND_SLOTS).toEqual(['bgm', 'opening', 'zoom', 'landing', 'item', 'closing'])
  })
})

describe('readPlaybackSound', () => {
  it('枠ごとの音声のURL（選んでいない枠は null）と2つの音量を読む', () => {
    expect(readPlaybackSound(bgmAndLanding)).toEqual(bgmAndLanding)
  })

  it('枠が欠けていれば、鳴らさない枠として補わずに投げる', () => {
    // 締め（closing）の枠を書き忘れた設定
    const { bgm, opening, zoom, landing, item } = bgmAndLanding.slots
    const withoutClosing = { bgm, opening, zoom, landing, item }

    expect(() => readPlaybackSound({ ...bgmAndLanding, slots: withoutClosing })).toThrow('closing')
  })

  it('音量が数でなければ投げる', () => {
    expect(() => readPlaybackSound({ ...bgmAndLanding, effectVolume: '大きめ' })).toThrow('音量')
  })

  it('音の設定そのものが無ければ投げる', () => {
    expect(() => readPlaybackSound(undefined)).toThrow('音の設定')
  })
})
