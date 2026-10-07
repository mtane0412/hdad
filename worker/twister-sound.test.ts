/**
 * ツイスターの BGM の設定（twister-sound.ts）のテスト
 *
 * 対戦のあいだ流す BGM の音声と音量の検証・保存・読み出しを確かめる。特に重要なのは次の点である。
 * - 問題点を最初の1件で止めずにすべて集めること（管理画面で一度に直せるようにするため）
 * - 音声として上げた素材しか BGM に選べないこと
 * - BGM が空（null）なら「流さない」として通すこと
 * - 合成ページへ渡すときに素材のIDを音声のURL（オーバーレイ用キーつき）にすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, type MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_TWISTER_SOUND, loadTwisterSound, parseTwisterSound, playbackTwisterSoundOf, saveTwisterSound, twisterSoundUses } from './twister-sound'

/** アップロード済みの素材。対戦の曲は音声、マットの画像は画像 */
const uploaded: ReadonlyMap<string, MediaKind> = new Map([
  ['media-taisen', 'audio'],
  ['media-mat', 'image'],
])
const kindOfMedia = (mediaId: string): MediaKind | null => uploaded.get(mediaId) ?? null

const overlayKey = 'issued-overlay-key-0123456789abcdefghij'

describe('parseTwisterSound', () => {
  it('音声の素材と音量を、そのまま保存用の形にする', () => {
    expect(parseTwisterSound({ bgm: 'media-taisen', bgmVolume: 0.4 }, kindOfMedia)).toEqual({ bgm: 'media-taisen', bgmVolume: 0.4 })
  })

  it('BGM が null なら「流さない」として通す', () => {
    expect(parseTwisterSound({ bgm: null, bgmVolume: 0.3 }, kindOfMedia)).toEqual({ bgm: null, bgmVolume: 0.3 })
  })

  it('オブジェクトでなければ断る', () => {
    expect(() => parseTwisterSound('対戦の曲', kindOfMedia)).toThrow(ConfigError)
  })

  it('無い素材・音声でない素材・音量の範囲外を、まとめて問題点として返す', () => {
    const problemsOf = (input: unknown): readonly string[] => {
      try {
        parseTwisterSound(input, kindOfMedia)
      } catch (error) {
        if (error instanceof ConfigError) return error.problems
        throw error
      }
      throw new Error('断られませんでした')
    }

    expect(problemsOf({ bgm: 'media-nai', bgmVolume: 1.5 })).toEqual(['bgm: 素材「media-nai」が存在しません', 'bgmVolume: 0〜1 の数で指定してください'])
    expect(problemsOf({ bgm: 'media-mat', bgmVolume: 0.3 })).toEqual(['bgm: 素材「media-mat」は音声ではありません'])
    expect(problemsOf({ bgm: 42, bgmVolume: '大きめ' })).toEqual(['bgm: 素材のIDか null で指定してください', 'bgmVolume: 0〜1 の数で指定してください'])
  })
})

describe('saveTwisterSound / loadTwisterSound', () => {
  it('未保存なら BGM を流さない設定を返す', async () => {
    expect(await loadTwisterSound(createFakeStore())).toEqual(DEFAULT_TWISTER_SOUND)
    expect(DEFAULT_TWISTER_SOUND.bgm).toBeNull()
  })

  it('保存したものを読み出せる', async () => {
    const store = createFakeStore()
    await saveTwisterSound(store, { bgm: 'media-taisen', bgmVolume: 0.5 })
    expect(await loadTwisterSound(store)).toEqual({ bgm: 'media-taisen', bgmVolume: 0.5 })
  })
})

describe('twisterSoundUses', () => {
  it('BGM に選ばれている素材かを返す（選ばれている素材は削除させない）', () => {
    const sound = { bgm: 'media-taisen', bgmVolume: 0.3 }
    expect(twisterSoundUses(sound, 'media-taisen')).toBe(true)
    expect(twisterSoundUses(sound, 'media-mat')).toBe(false)
    expect(twisterSoundUses(DEFAULT_TWISTER_SOUND, 'media-taisen')).toBe(false)
  })
})

describe('playbackTwisterSoundOf', () => {
  it('素材のIDを、オーバーレイ用キーつきの音声のURLに置き換える', () => {
    expect(playbackTwisterSoundOf({ bgm: 'media-taisen', bgmVolume: 0.3 }, overlayKey)).toEqual({
      bgm: `/api/media/media-taisen?key=${overlayKey}`,
      bgmVolume: 0.3,
    })
  })

  it('BGM を流さないなら、オーバーレイ用キーが無くても作れる', () => {
    expect(playbackTwisterSoundOf(DEFAULT_TWISTER_SOUND, null)).toEqual(DEFAULT_TWISTER_SOUND)
  })

  it('BGM を選んでいるのにオーバーレイ用キーが未発行なら投げる（黙って無音にしない）', () => {
    expect(() => playbackTwisterSoundOf({ bgm: 'media-taisen', bgmVolume: 0.3 }, null)).toThrow('オーバーレイ用キー')
  })
})
