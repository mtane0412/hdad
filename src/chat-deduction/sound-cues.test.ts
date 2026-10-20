/**
 * チャットで推理で鳴らす音の判断（sound-cues.ts）のテスト
 *
 * 合成ページは、前に映していた一覧と新しく受け取った一覧を比べて、どの音を鳴らすかを決める。確かめるのは次の点である。
 * - 押し出し（announce: true）で、ゲームの開始・答えた質問・解答の正誤・打ち切りに合う効果音を鳴らす
 * - 読み直し（announce: false）と最初の一覧では効果音を鳴らさない（つなぎ直すたびに昔のカードの音を鳴らさないため）
 * - BGM はゲームを開催しているあいだだけ鳴らし、読み直しでも合わせる（開催中に合成ページを開き直しても流れるように）
 * - 「鳴らさない」にした枠は鳴らさない
 */
import { describe, expect, it } from 'vitest'
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard } from './board'
import type { ChatDeductionSound } from './sound'
import { CHAT_DEDUCTION_BGM_FADE_OUT_MS, chatDeductionBgmUrlOf, chatDeductionSoundCuesOf } from './sound-cues'

/** 6つの枠すべてに音を選んだ設定（Worker が音声のURLにしたもの） */
const fullSound: ChatDeductionSound = {
  slots: {
    bgm: '/api/media/media-thinking?key=overlay-key',
    start: '/api/media/media-dodon?key=overlay-key',
    answered: '/api/media/media-pon?key=overlay-key',
    wrong: '/api/media/media-bubu?key=overlay-key',
    correct: '/api/media/media-pinpon?key=overlay-key',
    stopped: '/api/media/media-gong?key=overlay-key',
  },
  bgmVolume: 0.2,
  effectVolume: 0.7,
}

/** どの枠も鳴らさない設定 */
const silentSound: ChatDeductionSound = {
  slots: { bgm: null, start: null, answered: null, wrong: null, correct: null, stopped: null },
  bgmVolume: 0.2,
  effectVolume: 0.7,
}

/** 富士山の問題で開催中のゲーム */
const runningGame: ChatDeductionBoardGame = { id: 1, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null }

const question: ChatDeductionCard = { kind: 'question', id: 1, userName: '田中太郎', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' }
const wrongGuess: ChatDeductionCard = { kind: 'guess', id: 1, userName: '鈴木花子', text: '阿蘇山', correct: false }
const correctGuess: ChatDeductionCard = { kind: 'guess', id: 2, userName: '田中太郎', text: '富士山', correct: true }

const boardOf = (game: ChatDeductionBoardGame | null, cards: readonly ChatDeductionCard[], sound = fullSound): ChatDeductionBoard => ({ game, cards, sound })

/** 一度もゲームを始めていない一覧 */
const empty = boardOf(null, [])
/** 開催中で、カードがまだ無い一覧 */
const started = boardOf(runningGame, [])

const effect = (slot: keyof ChatDeductionSound['slots']) => ({ type: 'effect', url: fullSound.slots[slot], volume: fullSound.effectVolume })
const bgmStart = { type: 'bgmStart', url: fullSound.slots.bgm, volume: fullSound.bgmVolume }
const bgmFadeOut = { type: 'bgmFadeOut', duration: CHAT_DEDUCTION_BGM_FADE_OUT_MS }

describe('chatDeductionSoundCuesOf', () => {
  it('ゲームを始めた押し出しでは、開始の効果音を鳴らして BGM を鳴らしはじめる', () => {
    expect(chatDeductionSoundCuesOf(empty, started, true)).toEqual([effect('start'), bgmStart])
  })

  it('前のゲームを終えたあとに次のゲームを始めた押し出しでも、開始の効果音を鳴らす', () => {
    // 前提: ゲーム1は正解で終わっている
    const solved = boardOf({ ...runningGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' }, [correctGuess])

    expect(chatDeductionSoundCuesOf(solved, boardOf({ ...runningGame, id: 2 }, []), true)).toEqual([effect('start'), bgmStart])
  })

  it('答えた質問が増えた押し出しでは、回答の効果音を1回鳴らす（BGM は鳴らしたまま）', () => {
    expect(chatDeductionSoundCuesOf(started, boardOf(runningGame, [question]), true)).toEqual([effect('answered')])
  })

  it('不正解の解答が増えた押し出しでは、不正解の効果音を鳴らす', () => {
    expect(chatDeductionSoundCuesOf(boardOf(runningGame, [question]), boardOf(runningGame, [question, wrongGuess]), true)).toEqual([effect('wrong')])
  })

  it('同じIDでも、質問と解答は別のカードとして扱う', () => {
    // 前提: 質問1が映っていて、解答1（IDが同じ1）が届いた
    expect(chatDeductionSoundCuesOf(boardOf(runningGame, [question]), boardOf(runningGame, [question, wrongGuess]), true)).toEqual([effect('wrong')])
  })

  it('正解でゲームを終えた押し出しでは、正解の効果音を鳴らして BGM を下げて止める', () => {
    const solved = boardOf({ ...runningGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' }, [question, correctGuess])

    expect(chatDeductionSoundCuesOf(boardOf(runningGame, [question]), solved, true)).toEqual([effect('correct'), bgmFadeOut])
  })

  it('配信者が打ち切った押し出しでは、打ち切りの効果音を鳴らして BGM を下げて止める', () => {
    const stopped = boardOf({ ...runningGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'stopped', answer: '富士山' }, [question])

    expect(chatDeductionSoundCuesOf(boardOf(runningGame, [question]), stopped, true)).toEqual([effect('stopped'), bgmFadeOut])
  })

  it('読み直し（announce: false）では、新しいカードがあっても効果音を鳴らさない', () => {
    expect(chatDeductionSoundCuesOf(started, boardOf(runningGame, [question, wrongGuess]), false)).toEqual([])
  })

  it('最初の一覧では効果音を鳴らさないが、開催中なら BGM を鳴らしはじめる（開き直しても流れるように）', () => {
    expect(chatDeductionSoundCuesOf(null, boardOf(runningGame, [question]), true)).toEqual([bgmStart])
    expect(chatDeductionSoundCuesOf(null, boardOf(runningGame, [question]), false)).toEqual([bgmStart])
  })

  it('読み直しでゲームが終わっていたと分かったら、効果音は鳴らさずに BGM だけを止める', () => {
    const stopped = boardOf({ ...runningGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'stopped', answer: '富士山' }, [])

    expect(chatDeductionSoundCuesOf(started, stopped, false)).toEqual([bgmFadeOut])
  })

  it('BGM の音声を選び直した設定が届いたら、新しい BGM に替える', () => {
    const otherBgm = { ...fullSound, slots: { ...fullSound.slots, bgm: '/api/media/media-other?key=overlay-key' } }

    expect(chatDeductionSoundCuesOf(started, boardOf(runningGame, [], otherBgm), false)).toEqual([
      { type: 'bgmStart', url: otherBgm.slots.bgm, volume: otherBgm.bgmVolume },
    ])
  })

  it('BGM の音声はそのままで音量だけを変えた設定が届いたら、BGM を頭から流し直さずに音量だけを変える', () => {
    // 前提: 開催中で、考える曲を 0.2 で流している。読み直しで、同じ曲を 0.5 にした設定が届いた
    const louder = { ...fullSound, bgmVolume: 0.5 }

    expect(chatDeductionSoundCuesOf(started, boardOf(runningGame, [], louder), false)).toEqual([{ type: 'bgmVolume', volume: 0.5 }])
  })

  it('「鳴らさない」にした枠は、場面が来ても鳴らさない', () => {
    expect(chatDeductionSoundCuesOf(boardOf(null, [], silentSound), boardOf(runningGame, [question], silentSound), true)).toEqual([])
  })

  it('一覧が変わらなければ何も鳴らさない', () => {
    expect(chatDeductionSoundCuesOf(boardOf(runningGame, [question]), boardOf(runningGame, [question]), true)).toEqual([])
  })
})

describe('chatDeductionBgmUrlOf', () => {
  it('開催中で BGM を選んでいれば、その音声の URL を返す', () => {
    expect(chatDeductionBgmUrlOf(started)).toBe(fullSound.slots.bgm)
  })

  it('ゲームが無い・終えた・BGM を「鳴らさない」にしたなら null を返す', () => {
    expect(chatDeductionBgmUrlOf(empty)).toBeNull()
    expect(chatDeductionBgmUrlOf(boardOf({ ...runningGame, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'stopped', answer: '富士山' }, []))).toBeNull()
    expect(chatDeductionBgmUrlOf(boardOf(runningGame, [], silentSound))).toBeNull()
  })
})
