/**
 * ペロペロの効果音の設定（lick-sound.ts）のテスト
 *
 * 配信者がアップロードした音声1つと音量だけを持つ。音声でない素材・無い素材・範囲外の音量はまとめて問題点として断る。
 * 合成ページへは素材のIDを音声のURL（オーバーレイ用キーつき）に置き換えて押し出す。
 */
import { describe, expect, it } from 'vitest'
import type { MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_LICK_SOUND, lickSoundUses, loadLickSound, parseLickSound, playbackLickSoundOf, saveLickSound } from './lick-sound'

/** ジュルジュルの音声と、画像を1つずつ上げてある */
const kindOfMedia = (mediaId: string): MediaKind | null => ({ 'media-juru': 'audio', 'media-photo': 'image' })[mediaId] as MediaKind | null ?? null

describe('parseLickSound', () => {
  it('音声の素材と音量を、そのまま保存用の形にする', () => {
    expect(parseLickSound({ sound: 'media-juru', volume: 0.8 }, kindOfMedia)).toEqual({ sound: 'media-juru', volume: 0.8 })
  })

  it('効果音が null なら「鳴らさない」として通す', () => {
    expect(parseLickSound({ sound: null, volume: 0.5 }, kindOfMedia)).toEqual({ sound: null, volume: 0.5 })
  })

  it('オブジェクトでなければ断る', () => {
    expect(() => parseLickSound('ジュルジュル', kindOfMedia)).toThrow(expect.objectContaining({ problems: ['設定はオブジェクトで指定してください'] }))
  })

  it('無い素材・音声でない素材・音量の範囲外を、まとめて問題点として返す', () => {
    expect(() => parseLickSound({ sound: 'media-photo', volume: 1.5 }, kindOfMedia)).toThrow(
      expect.objectContaining({ problems: ['sound: 素材「media-photo」は音声ではありません', 'volume: 0〜1 の数で指定してください'] }),
    )
    expect(() => parseLickSound({ sound: 'media-nothing', volume: 0.5 }, kindOfMedia)).toThrow(
      expect.objectContaining({ problems: ['sound: 素材「media-nothing」が存在しません'] }),
    )
  })
})

describe('saveLickSound / loadLickSound', () => {
  it('未保存なら効果音を鳴らさない設定を返す', async () => {
    expect(await loadLickSound(createFakeStore())).toEqual(DEFAULT_LICK_SOUND)
    expect(DEFAULT_LICK_SOUND.sound).toBeNull()
  })

  it('保存したものを読み出せる', async () => {
    const store = createFakeStore()
    await saveLickSound(store, { sound: 'media-juru', volume: 0.7 })

    expect(await loadLickSound(store)).toEqual({ sound: 'media-juru', volume: 0.7 })
  })
})

describe('lickSoundUses', () => {
  it('効果音に選ばれている素材かを返す（選ばれている素材は削除させない）', () => {
    expect(lickSoundUses({ sound: 'media-juru', volume: 0.7 }, 'media-juru')).toBe(true)
    expect(lickSoundUses({ sound: 'media-juru', volume: 0.7 }, 'media-other')).toBe(false)
    expect(lickSoundUses({ sound: null, volume: 0.7 }, 'media-juru')).toBe(false)
  })
})

describe('playbackLickSoundOf', () => {
  it('素材のIDを、オーバーレイ用キーつきの音声のURLに置き換える', () => {
    expect(playbackLickSoundOf({ sound: 'media-juru', volume: 0.7 }, 'overlay-key')).toEqual({ sound: '/api/media/media-juru?key=overlay-key', volume: 0.7 })
  })

  it('効果音を鳴らさないなら、オーバーレイ用キーが無くても作れる', () => {
    expect(playbackLickSoundOf({ sound: null, volume: 0.7 }, null)).toEqual({ sound: null, volume: 0.7 })
  })

  it('効果音を選んでいるのにオーバーレイ用キーが未発行なら投げる（黙って無音にしない）', () => {
    expect(() => playbackLickSoundOf({ sound: 'media-juru', volume: 0.7 }, null)).toThrowError(/オーバーレイ用キー/)
  })
})
