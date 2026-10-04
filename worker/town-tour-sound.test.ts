/**
 * 市町村紹介の音の設定（town-tour-sound.ts）のテスト
 *
 * 場面ごとの枠（BGM・始まり・ズーム・着地・項目ごと・締め）に選んだ音声と、2つの音量の検証・保存・読み出しを確かめる。
 * 特に重要なのは次の点である。
 * - 問題点を最初の1件で止めずにすべて集めること（管理画面で一度に直せるようにするため）
 * - 音声として上げた素材しか枠に選べないこと
 * - 空の枠は「鳴らさない」として通し、ほかの音で埋めないこと
 * - 合成ページへ渡すときに素材のIDを音声のURL（オーバーレイ用キーつき）にすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, type MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'
import {
  DEFAULT_TOWN_TOUR_SOUND,
  loadTownTourSound,
  parseTownTourSound,
  playbackSoundOf,
  saveTownTourSound,
  townTourSoundUses,
  type TownTourSound,
} from './town-tour-sound'

/** アップロード済みの素材。BGM と効果音は音声、地図の画像は画像 */
const uploaded: ReadonlyMap<string, MediaKind> = new Map([
  ['media-cookie', 'audio'],
  ['media-jajean', 'audio'],
  ['media-hyun', 'audio'],
  ['media-peta', 'audio'],
  ['media-pa', 'audio'],
  ['media-chanchan', 'audio'],
  ['media-chizu', 'image'],
])
const kindOfMedia = (mediaId: string): MediaKind | null => uploaded.get(mediaId) ?? null

/** 6つの枠すべてに音を選んだ設定 */
const fullSound: TownTourSound = {
  slots: {
    bgm: 'media-cookie',
    opening: 'media-jajean',
    zoom: 'media-hyun',
    landing: 'media-peta',
    item: 'media-pa',
    closing: 'media-chanchan',
  },
  bgmVolume: 0.3,
  effectVolume: 0.7,
}

/** 検証で投げられた問題点を取り出す */
const problemsOf = (input: unknown): readonly string[] => {
  try {
    parseTownTourSound(input, kindOfMedia)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('問題点があるはずの設定が通りました')
}

describe('parseTownTourSound', () => {
  it('6つの枠すべてに音声を選んだ設定を通す', () => {
    expect(parseTownTourSound(fullSound, kindOfMedia)).toEqual(fullSound)
  })

  it('空（null）の枠は鳴らさない枠として通す', () => {
    const onlyBgm = { ...fullSound, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie' } }

    expect(parseTownTourSound(onlyBgm, kindOfMedia)).toEqual(onlyBgm)
  })

  it('同じ音声を複数の枠に選んでもよい（ズームと着地を同じ音にするなど）', () => {
    const shared = { ...fullSound, slots: { ...fullSound.slots, landing: 'media-hyun' } }

    expect(parseTownTourSound(shared, kindOfMedia)).toEqual(shared)
  })

  it('存在しない素材・音声でない素材を選んだ枠は、すべて問題点として挙げる', () => {
    const problems = problemsOf({ ...fullSound, slots: { ...fullSound.slots, zoom: 'media-kesareta', landing: 'media-chizu' } })

    expect(problems).toEqual(['slots.zoom: 素材「media-kesareta」が存在しません', 'slots.landing: 素材「media-chizu」は音声ではありません'])
  })

  it('枠が欠けている・素材のIDが文字列でない設定は断る', () => {
    // 締め（closing）の枠を書き忘れ、項目ごと（item）の枠に数を入れた設定
    const { bgm, opening, zoom, landing } = fullSound.slots

    expect(problemsOf({ ...fullSound, slots: { bgm, opening, zoom, landing, item: 3 } })).toEqual([
      'slots.item: 素材のIDか null で指定してください',
      'slots.closing: 素材のIDか null で指定してください',
    ])
  })

  it('知らない枠を含む設定は断る（鳴らす場所はコードで決めているため）', () => {
    expect(problemsOf({ ...fullSound, slots: { ...fullSound.slots, ending: 'media-pa' } })).toEqual(['slots.ending: 知らない枠です'])
  })

  it('音量が0〜1の数でなければ、両方とも問題点として挙げる', () => {
    expect(problemsOf({ ...fullSound, bgmVolume: 1.5, effectVolume: '大きめ' })).toEqual([
      'bgmVolume: 0〜1 の数で指定してください',
      'effectVolume: 0〜1 の数で指定してください',
    ])
  })

  it('オブジェクトでない設定や、枠がオブジェクトでない設定は断る', () => {
    expect(problemsOf('BGMだけ')).toEqual(['設定はオブジェクトで指定してください'])
    expect(problemsOf({ ...fullSound, slots: [] })).toEqual(['slots: 枠ごとの素材をオブジェクトで指定してください'])
  })
})

describe('saveTownTourSound と loadTownTourSound', () => {
  it('未保存ならどの枠も鳴らさない設定を返す', async () => {
    const sound = await loadTownTourSound(createFakeStore())

    expect(sound).toEqual(DEFAULT_TOWN_TOUR_SOUND)
    expect(Object.values(sound.slots).every((mediaId) => mediaId === null)).toBe(true)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()

    await saveTownTourSound(store, fullSound)

    expect(await loadTownTourSound(store)).toEqual(fullSound)
  })
})

describe('townTourSoundUses', () => {
  it('どれかの枠に選ばれている素材なら true を返す', () => {
    expect(townTourSoundUses(fullSound, 'media-peta')).toBe(true)
  })

  it('どの枠にも選ばれていない素材なら false を返す', () => {
    expect(townTourSoundUses(fullSound, 'media-chizu')).toBe(false)
  })
})

describe('playbackSoundOf', () => {
  it('選んだ枠は音声のURL（オーバーレイ用キーつき）に、空の枠は null にして音量と一緒に渡す', () => {
    const sound = { ...fullSound, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie', item: 'media-pa' } }

    expect(playbackSoundOf(sound, 'overlay-key')).toEqual({
      slots: {
        bgm: '/api/media/media-cookie?key=overlay-key',
        opening: null,
        zoom: null,
        landing: null,
        item: '/api/media/media-pa?key=overlay-key',
        closing: null,
      },
      bgmVolume: 0.3,
      effectVolume: 0.7,
    })
  })

  it('オーバーレイ用キーが無くても、どの枠も鳴らさないなら渡せる（URLを作らずに済むため）', () => {
    expect(playbackSoundOf(DEFAULT_TOWN_TOUR_SOUND, null).slots.bgm).toBeNull()
  })

  it('オーバーレイ用キーが無いのに音を選んだ枠があれば、黙って鳴らさずに投げる', () => {
    expect(() => playbackSoundOf(fullSound, null)).toThrow('オーバーレイ用キーが未発行のため、市町村紹介の音のURLを作れません')
  })
})
