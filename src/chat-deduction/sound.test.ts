/**
 * チャットで推理の音の枠と、音の設定の読み取り（sound.ts）のテスト
 *
 * 合成ページ・管理画面が受け取った音の設定を、補わずに読むことを確かめる。音を選んでいない枠（null）は鳴らさない枠として通し、
 * 形が違うものは黙って無音にせずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { CHAT_DEDUCTION_SOUND_SLOTS, readChatDeductionPlaybackSound, readChatDeductionSound } from './sound'

/** BGM と正解の音だけを選んだ設定（Worker が押し出す形） */
const bgmAndCorrect = {
  slots: {
    bgm: '/api/media/media-thinking?key=overlay-key',
    start: null,
    answered: null,
    wrong: null,
    correct: '/api/media/media-pinpon?key=overlay-key',
    stopped: null,
  },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

describe('CHAT_DEDUCTION_SOUND_SLOTS', () => {
  it('枠はゲームで鳴る順に並んでいる（管理画面の並びにも使う）', () => {
    expect(CHAT_DEDUCTION_SOUND_SLOTS).toEqual(['bgm', 'start', 'answered', 'wrong', 'correct', 'stopped'])
  })
})

describe('readChatDeductionPlaybackSound', () => {
  it('枠ごとの音声のURL（選んでいない枠は null）と2つの音量を読む', () => {
    expect(readChatDeductionPlaybackSound(bgmAndCorrect)).toEqual(bgmAndCorrect)
  })

  it('枠が欠けていれば、鳴らさない枠として補わずに投げる', () => {
    // 打ち切り（stopped）の枠を書き忘れた設定
    const { bgm, start, answered, wrong, correct } = bgmAndCorrect.slots

    expect(() => readChatDeductionPlaybackSound({ ...bgmAndCorrect, slots: { bgm, start, answered, wrong, correct } })).toThrow('stopped')
  })

  it('音量が数でなければ投げる', () => {
    expect(() => readChatDeductionPlaybackSound({ ...bgmAndCorrect, bgmVolume: '小さめ' })).toThrow('音量')
  })

  it('音の設定そのものが無ければ投げる', () => {
    expect(() => readChatDeductionPlaybackSound(undefined)).toThrow('音の設定')
  })
})

describe('readChatDeductionSound', () => {
  it('Worker が返した保存済みの設定（枠ごとの素材のID）を読む', () => {
    const saved = { ...bgmAndCorrect, slots: { ...bgmAndCorrect.slots, bgm: 'media-thinking', correct: 'media-pinpon' } }

    expect(readChatDeductionSound(saved)).toEqual(saved)
  })

  it('形が違えば、Worker の設定として読めないと投げる', () => {
    expect(() => readChatDeductionSound({ slots: {} })).toThrow('Worker')
  })
})
