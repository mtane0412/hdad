/**
 * チャットで推理の音の設定（chat-deduction-sound.ts）のテスト
 *
 * 場面ごとの枠（BGM・開始・回答・不正解・正解・打ち切り）に選んだ音声と、2つの音量の検証・保存・読み出しを確かめる。
 * 特に重要なのは次の点である。
 * - 問題点を最初の1件で止めずにすべて集めること（画面で一度に直せるようにするため）
 * - 音声として上げた素材しか枠に選べないこと
 * - 空の枠は「鳴らさない」として通し、ほかの音で埋めないこと
 * - 合成ページへ渡すときに素材のIDを音声のURL（オーバーレイ用キーつき）にすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, type MediaKind } from './alert-config'
import {
  DEFAULT_CHAT_DEDUCTION_SOUND,
  chatDeductionSoundUses,
  loadChatDeductionSound,
  parseChatDeductionSound,
  playbackChatDeductionSoundOf,
  saveChatDeductionSound,
  type ChatDeductionSound,
} from './chat-deduction-sound'
import { createFakeStore } from './fake-store'

/** アップロード済みの素材。BGM と効果音は音声、背景は画像 */
const uploaded: ReadonlyMap<string, MediaKind> = new Map([
  ['media-thinking', 'audio'],
  ['media-dodon', 'audio'],
  ['media-pon', 'audio'],
  ['media-bubu', 'audio'],
  ['media-pinpon', 'audio'],
  ['media-gong', 'audio'],
  ['media-haikei', 'image'],
])
const kindOfMedia = (mediaId: string): MediaKind | null => uploaded.get(mediaId) ?? null

/** 6つの枠すべてに音を選んだ設定 */
const fullSound: ChatDeductionSound = {
  slots: { bgm: 'media-thinking', start: 'media-dodon', answered: 'media-pon', wrong: 'media-bubu', correct: 'media-pinpon', stopped: 'media-gong' },
  bgmVolume: 0.2,
  effectVolume: 0.7,
}

/** 検証で投げられた問題点を取り出す */
const problemsOf = (input: unknown): readonly string[] => {
  try {
    parseChatDeductionSound(input, kindOfMedia)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('問題点があるはずの設定が通りました')
}

describe('parseChatDeductionSound', () => {
  it('6つの枠すべてに音声を選んだ設定を通す', () => {
    expect(parseChatDeductionSound(fullSound, kindOfMedia)).toEqual(fullSound)
  })

  it('空（null）の枠は鳴らさない枠として通す', () => {
    const onlyBgm = { ...fullSound, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, bgm: 'media-thinking' } }

    expect(parseChatDeductionSound(onlyBgm, kindOfMedia)).toEqual(onlyBgm)
  })

  it('存在しない素材・音声でない素材を選んだ枠は、すべて問題点として挙げる', () => {
    const problems = problemsOf({ ...fullSound, slots: { ...fullSound.slots, correct: 'media-kesareta', stopped: 'media-haikei' } })

    expect(problems).toEqual(['slots.correct: 素材「media-kesareta」が存在しません', 'slots.stopped: 素材「media-haikei」は音声ではありません'])
  })

  it('枠が欠けている・素材のIDが文字列でない設定は断る', () => {
    // 打ち切り（stopped）の枠を書き忘れ、回答（answered）の枠に数を入れた設定
    const { bgm, start, wrong, correct } = fullSound.slots

    expect(problemsOf({ ...fullSound, slots: { bgm, start, answered: 5, wrong, correct } })).toEqual([
      'slots.answered: 素材のIDか null で指定してください',
      'slots.stopped: 素材のIDか null で指定してください',
    ])
  })

  it('知らない枠を含む設定は断る（鳴らす場所はコードで決めているため）', () => {
    expect(problemsOf({ ...fullSound, slots: { ...fullSound.slots, timeUp: 'media-gong' } })).toEqual(['slots.timeUp: 知らない枠です'])
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

describe('saveChatDeductionSound と loadChatDeductionSound', () => {
  it('未保存ならどの枠も鳴らさない設定を返す', async () => {
    const sound = await loadChatDeductionSound(createFakeStore())

    expect(sound).toEqual(DEFAULT_CHAT_DEDUCTION_SOUND)
    expect(Object.values(sound.slots).every((mediaId) => mediaId === null)).toBe(true)
  })

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()

    await saveChatDeductionSound(store, fullSound)

    expect(await loadChatDeductionSound(store)).toEqual(fullSound)
  })
})

describe('chatDeductionSoundUses', () => {
  it('どれかの枠に選ばれている素材なら true を返す', () => {
    expect(chatDeductionSoundUses(fullSound, 'media-pon')).toBe(true)
  })

  it('どの枠にも選ばれていない素材なら false を返す', () => {
    expect(chatDeductionSoundUses(fullSound, 'media-haikei')).toBe(false)
  })
})

describe('playbackChatDeductionSoundOf', () => {
  it('選んだ枠は音声のURL（オーバーレイ用キーつき）に、空の枠は null にして音量と一緒に渡す', () => {
    const sound = { ...fullSound, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, bgm: 'media-thinking', correct: 'media-pinpon' } }

    expect(playbackChatDeductionSoundOf(sound, 'overlay-key')).toEqual({
      slots: {
        bgm: '/api/media/media-thinking?key=overlay-key',
        start: null,
        answered: null,
        wrong: null,
        correct: '/api/media/media-pinpon?key=overlay-key',
        stopped: null,
      },
      bgmVolume: fullSound.bgmVolume,
      effectVolume: fullSound.effectVolume,
    })
  })

  it('オーバーレイ用キーが無くても、どの枠も鳴らさないなら渡せる（URLを作らずに済むため）', () => {
    expect(playbackChatDeductionSoundOf(DEFAULT_CHAT_DEDUCTION_SOUND, null).slots.bgm).toBeNull()
  })

  it('オーバーレイ用キーが無いのに音を選んだ枠があれば、黙って鳴らさずに投げる', () => {
    expect(() => playbackChatDeductionSoundOf(fullSound, null)).toThrow('オーバーレイ用キーが未発行のため、チャットで推理の音のURLを作れません')
  })
})
