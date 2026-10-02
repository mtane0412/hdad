/**
 * 映す字幕の決め方（captions.ts）のテスト
 *
 * 確かめるのは次の5点である。
 * - 暫定の文は届くたびに書き換わり、確定したら確定の行へ移ること
 * - 訳文は、同じIDの確定した行に添えること（添える先が消えていれば捨てる）
 * - 確定した行は一定時間で消えること
 * - 暫定の文が長く書き換わらなければ消えること（認識していたタブが閉じられたとき、話しかけの文が残り続けないため）
 * - 映す行数に上限があり、新しいものを残すこと
 * - 長い行は末尾（新しく話した部分）だけを残し、先頭を「…」で落とすこと（長い発話が配信画面を埋めないため）
 */
import { describe, expect, it } from 'vitest'
import {
  CAPTION_LINES,
  CAPTION_MAX_CHARS,
  FINAL_LIFETIME_MS,
  INTERIM_LIFETIME_MS,
  NO_CAPTIONS,
  TRANSLATION_MAX_CHARS,
  applyCaptionMessage,
  tailOf,
  visibleCaptions,
} from './captions'

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

describe('tailOf', () => {
  it('上限以内の文はそのまま返す', () => {
    expect(tailOf('こんばんは', 5)).toBe('こんばんは')
  })

  it('上限を超えた文は、末尾だけを残して先頭に「…」を付ける（「…」も上限に含める）', () => {
    expect(tailOf('一二三四五六七八九十', 5)).toBe('…七八九十')
  })

  it('残す部分の前半に区切りの空白があれば、そこから始める（言葉の途中から始めない）', () => {
    expect(tailOf('one two three four', 12)).toBe('…three four')
  })

  it('区切りの空白が残す部分の後半にしか無ければ、空白にそろえない（残る文が短くなりすぎないため）', () => {
    expect(tailOf('一二三四五六七八 九十', 8)).toBe('…五六七八 九十')
  })

  it('絵文字などを途中で割らない', () => {
    expect(tailOf('あいうえお😀かき', 4)).toBe('…😀かき')
  })
})

describe('長い行を切る', () => {
  const longSpeech = 'ね 利己的な遺伝子はその個体レベルではなくて残される遺伝子レベルで考えた時に 例えば 近くに住んでいる親類縁者は自分と結構似たあの遺伝子を持ってる可能性が高いので'

  it('長い暫定の文は、新しく話した末尾を残して映す', () => {
    const state = applyCaptionMessage(NO_CAPTIONS, { type: 'interim', text: longSpeech }, 1000)
    const [line] = visibleCaptions(state, 1100)
    expect(Array.from(line?.text ?? '').length).toBeLessThanOrEqual(CAPTION_MAX_CHARS)
    expect(line?.text.startsWith('…')).toBe(true)
    expect(line?.text.endsWith('持ってる可能性が高いので')).toBe(true)
  })

  it('長い確定の行と訳文も、それぞれの上限で末尾を残して映す', () => {
    const longTranslation = 'Selfish gene theory says that when we look at the level of genes that are passed on rather than the level of individuals, relatives living nearby are likely to share similar genes'
    let state = applyCaptionMessage(NO_CAPTIONS, { type: 'final', id: 'utterance-long', text: longSpeech }, 1000)
    state = applyCaptionMessage(state, { type: 'translation', id: 'utterance-long', text: longTranslation }, 1500)
    const [line] = visibleCaptions(state, 1600)
    expect(Array.from(line?.text ?? '').length).toBeLessThanOrEqual(CAPTION_MAX_CHARS)
    expect(Array.from(line?.translation ?? '').length).toBeLessThanOrEqual(TRANSLATION_MAX_CHARS)
    expect(line?.translation?.startsWith('…')).toBe(true)
    expect(line?.translation?.endsWith('share similar genes')).toBe(true)
  })
})
