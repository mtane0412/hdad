/**
 * 読み上げ待ちの列（queue.ts）のテスト
 *
 * 確かめること:
 * - 1件ずつ順に読むこと（重ねて読まない）
 * - 待ちが上限を超えたら、古いほうから捨てること（読み上げが配信に追いつかなくなるため）
 */
import { describe, expect, it } from 'vitest'
import { advanceSpeech, EMPTY_SPEECH_QUEUE, enqueueSpeech, MAX_WAITING_SPEECH } from './queue'

describe('enqueueSpeech', () => {
  it('何も読んでいなければ、すぐ読み上げ中にする', () => {
    expect(enqueueSpeech(EMPTY_SPEECH_QUEUE, 'こんにちは')).toEqual({ current: 'こんにちは', waiting: [] })
  })

  it('読み上げ中なら、後ろに並べる', () => {
    const 列 = enqueueSpeech(enqueueSpeech(EMPTY_SPEECH_QUEUE, 'こんにちは'), 'はじめまして')

    expect(列).toEqual({ current: 'こんにちは', waiting: ['はじめまして'] })
  })

  it('待ちが上限を超えたら、古いほうから捨てる（新しい発言を優先する）', () => {
    let 列 = enqueueSpeech(EMPTY_SPEECH_QUEUE, '読み上げ中の発言')
    for (let 番号 = 1; 番号 <= MAX_WAITING_SPEECH + 2; 番号 += 1) 列 = enqueueSpeech(列, `${番号}番目の発言`)

    expect(列.current).toBe('読み上げ中の発言')
    expect(列.waiting).toHaveLength(MAX_WAITING_SPEECH)
    expect(列.waiting[0]).toBe('3番目の発言')
    expect(列.waiting.at(-1)).toBe(`${MAX_WAITING_SPEECH + 2}番目の発言`)
  })
})

describe('advanceSpeech', () => {
  it('読み終わったら、待っている先頭を読み上げ中にする', () => {
    const 列 = enqueueSpeech(enqueueSpeech(EMPTY_SPEECH_QUEUE, 'こんにちは'), 'はじめまして')

    expect(advanceSpeech(列)).toEqual({ current: 'はじめまして', waiting: [] })
  })

  it('待っているものが無ければ、何も読んでいない状態に戻る', () => {
    expect(advanceSpeech(enqueueSpeech(EMPTY_SPEECH_QUEUE, 'こんにちは'))).toEqual(EMPTY_SPEECH_QUEUE)
  })
})
