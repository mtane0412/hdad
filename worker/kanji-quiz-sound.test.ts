/**
 * 漢字クイズの音の設定（kanji-quiz-sound.ts）のテスト
 *
 * 場面ごとの枠（BGM・出題・カウントダウン・正解・時間切れ）に選んだ音声と、2つの音量の検証・保存・読み出しを確かめる。
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
  DEFAULT_KANJI_QUIZ_SOUND,
  kanjiQuizSoundUses,
  loadKanjiQuizSound,
  parseKanjiQuizSound,
  playbackKanjiQuizSoundOf,
  saveKanjiQuizSound,
  type KanjiQuizSound,
} from './kanji-quiz-sound'

/** アップロード済みの素材。BGM と効果音は音声、背景は画像 */
const uploaded: ReadonlyMap<string, MediaKind> = new Map([
  ['media-thinking', 'audio'],
  ['media-dodon', 'audio'],
  ['media-tick', 'audio'],
  ['media-pinpon', 'audio'],
  ['media-buzzer', 'audio'],
  ['media-haikei', 'image'],
])
const kindOfMedia = (mediaId: string): MediaKind | null => uploaded.get(mediaId) ?? null

/** 5つの枠すべてに音を選んだ設定 */
const fullSound: KanjiQuizSound = {
  slots: { bgm: 'media-thinking', start: 'media-dodon', countdown: 'media-tick', correct: 'media-pinpon', timeUp: 'media-buzzer' },
  bgmVolume: 0.3,
  effectVolume: 0.7,
}

/** 検証で投げられた問題点を取り出す */
const problemsOf = (input: unknown): readonly string[] => {
  try {
    parseKanjiQuizSound(input, kindOfMedia)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('問題点があるはずの設定が通りました')
}

describe('parseKanjiQuizSound', () => {
  it('5つの枠すべてに音声を選んだ設定を通す', () => {
    expect(parseKanjiQuizSound(fullSound, kindOfMedia)).toEqual(fullSound)
  })

  it('空（null）の枠は鳴らさない枠として通す', () => {
    const onlyBgm = { ...fullSound, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, bgm: 'media-thinking' } }

    expect(parseKanjiQuizSound(onlyBgm, kindOfMedia)).toEqual(onlyBgm)
  })

  it('存在しない素材・音声でない素材を選んだ枠は、すべて問題点として挙げる', () => {
    const problems = problemsOf({ ...fullSound, slots: { ...fullSound.slots, correct: 'media-kesareta', timeUp: 'media-haikei' } })

    expect(problems).toEqual(['slots.correct: 素材「media-kesareta」が存在しません', 'slots.timeUp: 素材「media-haikei」は音声ではありません'])
  })

  it('枠が欠けている・素材のIDが文字列でない設定は断る', () => {
    // 時間切れ（timeUp）の枠を書き忘れ、カウントダウン（countdown）の枠に数を入れた設定
    const { bgm, start, correct } = fullSound.slots

    expect(problemsOf({ ...fullSound, slots: { bgm, start, countdown: 5, correct } })).toEqual([
      'slots.countdown: 素材のIDか null で指定してください',
      'slots.timeUp: 素材のIDか null で指定してください',
    ])
  })

  it('知らない枠を含む設定は断る（鳴らす場所はコードで決めているため）', () => {
    expect(problemsOf({ ...fullSound, slots: { ...fullSound.slots, wrong: 'media-buzzer' } })).toEqual(['slots.wrong: 知らない枠です'])
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

describe('saveKanjiQuizSound と loadKanjiQuizSound', () => {
  it('未保存ならどの枠も鳴らさない設定を返す', async () => {
    const sound = await loadKanjiQuizSound(createFakeStore())

    expect(sound).toEqual(DEFAULT_KANJI_QUIZ_SOUND)
    expect(Object.values(sound.slots).every((mediaId) => mediaId === null)).toBe(true)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()

    await saveKanjiQuizSound(store, fullSound)

    expect(await loadKanjiQuizSound(store)).toEqual(fullSound)
  })
})

describe('kanjiQuizSoundUses', () => {
  it('どれかの枠に選ばれている素材なら true を返す', () => {
    expect(kanjiQuizSoundUses(fullSound, 'media-tick')).toBe(true)
  })

  it('どの枠にも選ばれていない素材なら false を返す', () => {
    expect(kanjiQuizSoundUses(fullSound, 'media-haikei')).toBe(false)
  })
})

describe('playbackKanjiQuizSoundOf', () => {
  it('選んだ枠は音声のURL（オーバーレイ用キーつき）に、空の枠は null にして音量と一緒に渡す', () => {
    const sound = { ...fullSound, slots: { ...DEFAULT_KANJI_QUIZ_SOUND.slots, bgm: 'media-thinking', correct: 'media-pinpon' } }

    expect(playbackKanjiQuizSoundOf(sound, 'overlay-key')).toEqual({
      slots: {
        bgm: '/api/media/media-thinking?key=overlay-key',
        start: null,
        countdown: null,
        correct: '/api/media/media-pinpon?key=overlay-key',
        timeUp: null,
      },
      bgmVolume: 0.3,
      effectVolume: 0.7,
    })
  })

  it('オーバーレイ用キーが無くても、どの枠も鳴らさないなら渡せる（URLを作らずに済むため）', () => {
    expect(playbackKanjiQuizSoundOf(DEFAULT_KANJI_QUIZ_SOUND, null).slots.bgm).toBeNull()
  })

  it('オーバーレイ用キーが無いのに音を選んだ枠があれば、黙って鳴らさずに投げる', () => {
    expect(() => playbackKanjiQuizSoundOf(fullSound, null)).toThrow('オーバーレイ用キーが未発行のため、漢字クイズの音のURLを作れません')
  })
})
