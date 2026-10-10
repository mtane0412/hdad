/**
 * 漢字クイズの音の枠と、音の設定の読み取り（sound.ts）のテスト
 *
 * 合成ページ・管理画面が受け取った音の設定を、補わずに読むことを確かめる。音を選んでいない枠（null）は鳴らさない枠として通し、
 * 形が違うものは黙って無音にせずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { KANJI_QUIZ_SOUND_SLOTS, readKanjiQuizPlaybackSound, readKanjiQuizSound } from './sound'

/** BGM と正解の音だけを選んだ設定（Worker が押し出す形） */
const bgmAndCorrect = {
  slots: {
    bgm: '/api/media/media-thinking?key=overlay-key',
    start: null,
    countdown: null,
    correct: '/api/media/media-pinpon?key=overlay-key',
    timeUp: null,
  },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

describe('KANJI_QUIZ_SOUND_SLOTS', () => {
  it('枠は演出で鳴る順に並んでいる（管理画面の並びにも使う）', () => {
    expect(KANJI_QUIZ_SOUND_SLOTS).toEqual(['bgm', 'start', 'countdown', 'correct', 'timeUp'])
  })
})

describe('readKanjiQuizPlaybackSound', () => {
  it('枠ごとの音声のURL（選んでいない枠は null）と2つの音量を読む', () => {
    expect(readKanjiQuizPlaybackSound(bgmAndCorrect)).toEqual(bgmAndCorrect)
  })

  it('枠が欠けていれば、鳴らさない枠として補わずに投げる', () => {
    // 時間切れ（timeUp）の枠を書き忘れた設定
    const { bgm, start, countdown, correct } = bgmAndCorrect.slots

    expect(() => readKanjiQuizPlaybackSound({ ...bgmAndCorrect, slots: { bgm, start, countdown, correct } })).toThrow('timeUp')
  })

  it('音量が数でなければ投げる', () => {
    expect(() => readKanjiQuizPlaybackSound({ ...bgmAndCorrect, effectVolume: '大きめ' })).toThrow('音量')
  })

  it('音の設定そのものが無ければ投げる', () => {
    expect(() => readKanjiQuizPlaybackSound(undefined)).toThrow('音の設定')
  })
})

describe('readKanjiQuizSound', () => {
  it('Worker が返した保存済みの設定（枠ごとの素材のID）を読む', () => {
    const saved = { ...bgmAndCorrect, slots: { ...bgmAndCorrect.slots, bgm: 'media-thinking', correct: 'media-pinpon' } }

    expect(readKanjiQuizSound(saved)).toEqual(saved)
  })
})
