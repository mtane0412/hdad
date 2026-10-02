/**
 * 字幕のやりとり（message.ts）のテスト
 *
 * 確かめるのは、アプリの枠が送る2種類（暫定・確定）を読み取れることと、
 * 想定した形でないものを黙って捨てずにエラーにすること。
 */
import { describe, expect, it } from 'vitest'
import { CAPTION_MAX_LENGTH, parseCaptionMessage } from './message'

describe('parseCaptionMessage', () => {
  it('話している途中の文（暫定）を読み取る', () => {
    expect(parseCaptionMessage(JSON.stringify({ type: 'interim', text: 'こんばんは今日は' }))).toEqual({ type: 'interim', text: 'こんばんは今日は' })
  })

  it('確定した文を読み取る', () => {
    expect(parseCaptionMessage(JSON.stringify({ type: 'final', text: 'こんばんは、今日はゲームをします' }))).toEqual({
      type: 'final',
      text: 'こんばんは、今日はゲームをします',
    })
  })

  it('暫定の文が空になった（話し終えた・認識が止まった）ことを読み取る', () => {
    expect(parseCaptionMessage(JSON.stringify({ type: 'interim', text: '' }))).toEqual({ type: 'interim', text: '' })
  })

  it('JSONとして読めないものはエラーにする', () => {
    expect(() => parseCaptionMessage('こんばんは')).toThrow('字幕を読み取れませんでした')
  })

  it('知らない種類はエラーにする', () => {
    expect(() => parseCaptionMessage(JSON.stringify({ type: 'translation', text: 'Good evening' }))).toThrow('字幕の形が想定と違います')
  })

  it('本文が文字列でなければエラーにする', () => {
    expect(() => parseCaptionMessage(JSON.stringify({ type: 'final', text: 123 }))).toThrow('字幕の形が想定と違います')
  })

  it('確定した文が空ならエラーにする（確定は中身のある発話だけが送られる）', () => {
    expect(() => parseCaptionMessage(JSON.stringify({ type: 'final', text: '' }))).toThrow('字幕の形が想定と違います')
  })

  it('長すぎる本文はエラーにする', () => {
    expect(() => parseCaptionMessage(JSON.stringify({ type: 'final', text: 'あ'.repeat(CAPTION_MAX_LENGTH + 1) }))).toThrow('字幕の形が想定と違います')
  })
})
