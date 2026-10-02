/**
 * 映す字幕の決め方（captions.ts）のテスト
 *
 * 確かめるのは次の5点である。
 * - 暫定の文は届くたびに書き換わり、確定したら確定の行へ移ること
 * - 訳文は、同じIDの確定した行に添えること（添える先が消えていれば捨てる）
 * - 確定した行は一定時間で消えること
 * - 暫定の文が長く書き換わらなければ消えること（認識していたタブが閉じられたとき、話しかけの文が残り続けないため）
 * - 映す行数に上限があり、新しいものを残すこと
 */
import { describe, expect, it } from 'vitest'
import { CAPTION_LINES, FINAL_LIFETIME_MS, INTERIM_LIFETIME_MS, NO_CAPTIONS, applyCaptionMessage, visibleCaptions } from './captions'

describe('applyCaptionMessage と visibleCaptions', () => {
  it('まだ何も届いていなければ何も映さない', () => {
    expect(visibleCaptions(NO_CAPTIONS, 0)).toEqual([])
  })

  it('暫定の文は届くたびに書き換える', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'interim', text: 'こんばんは' }, 1000)
    state = applyCaptionMessage(state, { type: 'interim', text: 'こんばんは今日は' }, 1200)
    expect(visibleCaptions(state, 1300)).toEqual([{ text: 'こんばんは今日は', final: false, translation: null }])
  })

  it('確定したら暫定の文を消し、確定の行として映す', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'interim', text: 'こんばんは今日は' }, 1000)
    state = applyCaptionMessage(state, { type: 'final', id: 'utterance-1', text: 'こんばんは、今日はゲームをします' }, 2000)
    expect(visibleCaptions(state, 2100)).toEqual([{ text: 'こんばんは、今日はゲームをします', final: true, translation: null }])
  })

  it('確定した行は、確定してから一定時間で消える', () => {
    const state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-2', text: 'こんばんは' }, 1000)
    expect(visibleCaptions(state, 1000 + FINAL_LIFETIME_MS - 1)).toHaveLength(1)
    expect(visibleCaptions(state, 1000 + FINAL_LIFETIME_MS)).toEqual([])
  })

  it('確定した行のあとに話し始めた暫定の文は、確定した行の下に並べる', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-3', text: 'こんばんは' }, 1000)
    state = applyCaptionMessage(state, { type: 'interim', text: '今日は' }, 1500)
    expect(visibleCaptions(state, 1600)).toEqual([
      { text: 'こんばんは', final: true, translation: null },
      { text: '今日は', final: false, translation: null },
    ])
  })

  it('暫定の文が空で届いたら消す', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'interim', text: 'こんばんは' }, 1000)
    state = applyCaptionMessage(state, { type: 'interim', text: '' }, 1100)
    expect(visibleCaptions(state, 1200)).toEqual([])
  })

  it('暫定の文が長く書き換わらなければ消す', () => {
    const state = applyCaptionMessage(NO_CAPTIONS, { type: 'interim', text: 'こんばんは' }, 1000)
    expect(visibleCaptions(state, 1000 + INTERIM_LIFETIME_MS - 1)).toHaveLength(1)
    expect(visibleCaptions(state, 1000 + INTERIM_LIFETIME_MS)).toEqual([])
  })

  it('訳文が届いたら、同じIDの確定した行に添える', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-a', text: 'こんばんは' }, 1000)
    state = applyCaptionMessage(state, { type: 'final', id: 'utterance-b', text: '今日はゲームをします' }, 1200)
    state = applyCaptionMessage(state, { type: 'translation', id: 'utterance-a', text: 'Good evening' }, 1500)
    expect(visibleCaptions(state, 1600)).toEqual([
      { text: 'こんばんは', final: true, translation: 'Good evening' },
      { text: '今日はゲームをします', final: true, translation: null },
    ])
  })

  it('訳文を添えた行は、訳文が届いてから一定時間映す（訳を読む時間を取る）', () => {
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-a', text: 'こんばんは' }, 1000)
    state = applyCaptionMessage(state, { type: 'translation', id: 'utterance-a', text: 'Good evening' }, 3000)
    expect(visibleCaptions(state, 3000 + FINAL_LIFETIME_MS - 1)).toHaveLength(1)
    expect(visibleCaptions(state, 3000 + FINAL_LIFETIME_MS)).toEqual([])
  })

  it('添える先の行がもう無い訳文は捨てる（消えた行を訳文で呼び戻さない）', () => {
    const state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-a', text: 'こんばんは' }, 1000)
    expect(applyCaptionMessage(state, { type: 'translation', id: 'utterance-z', text: 'Good evening' }, 1500)).toBe(state)
    const expired = applyCaptionMessage(state, { type: 'translation', id: 'utterance-a', text: 'Good evening' }, 1000 + FINAL_LIFETIME_MS)
    expect(visibleCaptions(expired, 1000 + FINAL_LIFETIME_MS)).toEqual([])
  })

  it('映すのは新しいものから決まった行数まで', () => {
    let state = NO_CAPTIONS
    const texts = ['一つ目の発話', '二つ目の発話', '三つ目の発話', '四つ目の発話']
    texts.forEach((text, index) => {
      state = applyCaptionMessage(state, { type: 'final', id: `utterance-${index}`, text }, 1000 + index)
    })
    state = applyCaptionMessage(state, { type: 'interim', text: '話している途中' }, 1010)
    const shown = visibleCaptions(state, 1020)
    expect(shown).toHaveLength(CAPTION_LINES)
    expect(shown.at(-1)).toEqual({ text: '話している途中', final: false, translation: null })
    expect(shown.at(-2)).toEqual({ text: '四つ目の発話', final: true, translation: null })
  })
})
