/**
 * 読み上げの音量の変化（level.ts）のテスト
 *
 * 確かめること:
 * - 音声の標本から、決まった長さの区切りごとの音量（0〜1）の列を作ること
 * - 無音は 0 のままにし、小さな声でもいちばん大きい区切りが 1 になるようにそろえること
 * - 読み上げのページから配る知らせ（鳴らしはじめ・止まった）を読み、形が違えば投げること
 */
import { describe, expect, it } from 'vitest'
import { SPEECH_LEVEL_FRAME_MS, envelopeOf, parseSpeechLevelMessage } from './level'

/** 標本の頻度（1秒あたりの標本の数） */
const SAMPLE_RATE = 24_000
/** 1つの区切りに入る標本の数 */
const FRAME_SAMPLES = (SAMPLE_RATE * SPEECH_LEVEL_FRAME_MS) / 1000

/** 区切りごとの振れ幅を並べた音声を作る（区切りの中は振れ幅で正負に振れる） */
const samplesOf = (amplitudes: readonly number[]): Float32Array =>
  Float32Array.from(amplitudes.flatMap((amplitude) => Array.from({ length: FRAME_SAMPLES }, (_, index) => (index % 2 === 0 ? amplitude : -amplitude))))

describe('envelopeOf', () => {
  it('区切りごとの音量を、いちばん大きい区切りを 1 にそろえて返す', () => {
    const levels = envelopeOf(samplesOf([0, 0.5, 0.25]), SAMPLE_RATE)

    expect(levels).toHaveLength(3)
    expect(levels[0]).toBe(0)
    expect(levels[1]).toBe(1)
    expect(levels[2]).toBeCloseTo(0.5, 2)
  })

  it('小さな声でも、いちばん大きい区切りは 1 になる', () => {
    expect(Math.max(...envelopeOf(samplesOf([0.02, 0.01]), SAMPLE_RATE))).toBe(1)
  })

  it('無音だけなら、すべて 0 のままにする（雑音を大きくして口を動かさない）', () => {
    expect(envelopeOf(samplesOf([0, 0, 0]), SAMPLE_RATE)).toEqual([0, 0, 0])
  })

  it('最後の区切りが短くても、区切りとして数える', () => {
    const samples = samplesOf([0.5]).subarray(0, FRAME_SAMPLES / 2)

    expect(envelopeOf(samples, SAMPLE_RATE)).toEqual([1])
  })
})

describe('parseSpeechLevelMessage', () => {
  it('鳴らしはじめの知らせを読む', () => {
    const message = { type: 'start', id: '読み上げ-1', startedAt: 1_760_000_000_000, frameMs: SPEECH_LEVEL_FRAME_MS, levels: [0, 0.5, 1] }

    expect(parseSpeechLevelMessage(message)).toEqual(message)
  })

  it('止まった知らせを読む', () => {
    expect(parseSpeechLevelMessage({ type: 'stop', id: '読み上げ-1' })).toEqual({ type: 'stop', id: '読み上げ-1' })
  })

  it('形が違えば投げる', () => {
    expect(() => parseSpeechLevelMessage('こんにちは')).toThrow()
    expect(() => parseSpeechLevelMessage({ type: 'start', id: '読み上げ-1', startedAt: 0, frameMs: 20, levels: [1.5] })).toThrow()
    expect(() => parseSpeechLevelMessage({ type: 'start', id: '読み上げ-1', startedAt: 0, frameMs: 0, levels: [] })).toThrow()
    expect(() => parseSpeechLevelMessage({ type: 'stop' })).toThrow()
    expect(() => parseSpeechLevelMessage({ type: 'pause', id: '読み上げ-1' })).toThrow()
  })
})
