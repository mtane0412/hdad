/**
 * 漢字クイズで音を鳴らす時刻の表（sound-cues.ts）のテスト
 *
 * 1回の出題で、どの枠の音をいつ鳴らすかが、場面の進み方（scene.ts の定数）とずれないことを確かめる。
 * - BGM と「出題」は流しはじめに鳴らし、BGM は正解者が届いた時刻か時間切れの時刻で下げて止める
 * - カウントダウンは大きな数字が切り替わるたびに鳴らし、正解者が届いたらその先は鳴らさない
 * - 正解者が届いたら「正解」、届かなければ時間切れの時刻に「時間切れ」を鳴らす
 * - 確かめるタイマーが遅れても、過ぎた効果音をまとめて鳴らさない
 */
import { describe, expect, it } from 'vitest'
import { ANSWER_LIMIT_MS, GRADE_INTRO_MS } from './scene'
import type { KanjiQuizSound } from './sound'
import { KANJI_QUIZ_BGM_FADE_OUT_MS, dueKanjiQuizSoundCues, kanjiQuizBgmDuckHoldOf, kanjiQuizSoundCuesOf } from './sound-cues'

/** 5つの枠すべてに音を選んだ設定（合成ページが受け取る、音声のURLの形） */
const fullSound: KanjiQuizSound = {
  slots: {
    bgm: '/api/media/media-thinking?key=k',
    start: '/api/media/media-dodon?key=k',
    countdown: '/api/media/media-tick?key=k',
    correct: '/api/media/media-pinpon?key=k',
    timeUp: '/api/media/media-buzzer?key=k',
  },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

/** どの枠も鳴らさない設定 */
const silentSound: KanjiQuizSound = {
  slots: { bgm: null, start: null, countdown: null, correct: null, timeUp: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

/** 時間切れの時刻（流しはじめてから。級を出し終えてから制限時間が過ぎたとき） */
const timeUpAt = GRADE_INTRO_MS + ANSWER_LIMIT_MS

/** 表から、id と鳴らす時刻だけを取り出す（並び順を確かめるため） */
const timingsOf = (cues: ReturnType<typeof kanjiQuizSoundCuesOf>): [string, number][] => cues.map((cue) => [cue.id, cue.at])

describe('kanjiQuizSoundCuesOf', () => {
  it('正解者が届かなければ、出題・最後の5秒のカウントダウン・時間切れを鳴らし、時間切れで BGM を下げる', () => {
    // 前提: 級2秒＋制限時間15秒なので、時間切れは17秒。大きな数字は12秒から1秒ごとに 5→1 と切り替わる
    expect(timingsOf(kanjiQuizSoundCuesOf(fullSound, null))).toEqual([
      ['bgm', 0],
      ['start', 0],
      ['countdown-5', 12_000],
      ['countdown-4', 13_000],
      ['countdown-3', 14_000],
      ['countdown-2', 15_000],
      ['countdown-1', 16_000],
      ['timeUp', timeUpAt],
      ['bgm-end', timeUpAt],
    ])
  })

  it('正解者が届いたら、その時刻に正解の音を鳴らして BGM を下げ、それより後のカウントダウンと時間切れは鳴らさない', () => {
    // 前提: 13.5秒に正解者が届いた（カウントダウンの 5 と 4 は鳴り終えている）
    expect(timingsOf(kanjiQuizSoundCuesOf(fullSound, 13_500))).toEqual([
      ['bgm', 0],
      ['start', 0],
      ['countdown-5', 12_000],
      ['countdown-4', 13_000],
      ['correct', 13_500],
      ['bgm-end', 13_500],
    ])
  })

  it('BGM と効果音にそれぞれの音量を付け、BGM は決まった長さで下げる', () => {
    const cues = kanjiQuizSoundCuesOf(fullSound, null)

    expect(cues.find((cue) => cue.id === 'bgm')).toEqual({ id: 'bgm', at: 0, type: 'bgmStart', url: fullSound.slots.bgm, volume: 0.3 })
    expect(cues.find((cue) => cue.id === 'timeUp')).toEqual({ id: 'timeUp', at: timeUpAt, type: 'effect', url: fullSound.slots.timeUp, volume: 0.6 })
    expect(cues.find((cue) => cue.id === 'bgm-end')).toEqual({ id: 'bgm-end', at: timeUpAt, type: 'bgmFadeOut', duration: KANJI_QUIZ_BGM_FADE_OUT_MS })
  })

  it('鳴らさない枠は表に載せず、どの枠も鳴らさなければ表は空になる', () => {
    const onlyCorrect = { ...silentSound, slots: { ...silentSound.slots, correct: fullSound.slots.correct } }

    expect(timingsOf(kanjiQuizSoundCuesOf(onlyCorrect, 13_500))).toEqual([['correct', 13_500]])
    expect(kanjiQuizSoundCuesOf(silentSound, null)).toEqual([])
  })
})

describe('dueKanjiQuizSoundCues', () => {
  it('時刻を迎えた音のうち、まだ鳴らしていないものだけを返す', () => {
    // 前提: 出だしの BGM と出題の音は鳴らし終え、12.1秒にタイマーが確かめた
    const due = dueKanjiQuizSoundCues(fullSound, 12_100, null, new Set(['bgm', 'start']))

    expect(due.map((cue) => cue.id)).toEqual(['countdown-5'])
  })

  it('タイマーが遅れて効果音の時刻から0.5秒より過ぎていたら、その効果音は鳴らさない（場面とずれて聞こえるため）', () => {
    // 前提: OBS がページを止めていて、13.7秒まで確かめられなかった（12秒のカウントダウンは1.7秒遅れ、13秒のものは0.7秒遅れ）
    const due = dueKanjiQuizSoundCues(fullSound, 13_700, null, new Set(['bgm', 'start']))

    expect(due).toEqual([])
  })

  it('BGM を下げる時刻を過ぎてからは、BGM を鳴らしはじめない', () => {
    // 前提: 流しはじめから一度も確かめられないまま、正解者が届いて BGM を下げる時刻を過ぎた
    const due = dueKanjiQuizSoundCues(fullSound, 14_000, 13_500, new Set())

    expect(due.map((cue) => cue.id)).toEqual(['correct', 'bgm-end'])
  })
})

describe('kanjiQuizBgmDuckHoldOf', () => {
  it('BGM を鳴らさない設定なら、配信の BGM を下げない（null）', () => {
    expect(kanjiQuizBgmDuckHoldOf(silentSound, 0, null)).toBeNull()
  })

  it('正解者が届いていなければ、時間切れで BGM を下げ終えるまで配信の BGM を下げておく', () => {
    expect(kanjiQuizBgmDuckHoldOf(fullSound, 0, null)).toBe(timeUpAt + KANJI_QUIZ_BGM_FADE_OUT_MS)
  })

  it('正解者が届いたら、届いた時刻から BGM を下げ終えるまでの残りに縮める', () => {
    // 前提: 13.5秒に正解者が届き、13.6秒に知らせる
    expect(kanjiQuizBgmDuckHoldOf(fullSound, 13_600, 13_500)).toBe(13_500 + KANJI_QUIZ_BGM_FADE_OUT_MS - 13_600)
  })

  it('BGM を下げ終えた後なら、すぐ戻す（0）', () => {
    expect(kanjiQuizBgmDuckHoldOf(fullSound, timeUpAt + 5_000, null)).toBe(0)
  })
})
