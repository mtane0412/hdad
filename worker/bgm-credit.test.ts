/**
 * BGMのクレジットの差し込み語（bgm-credit.ts）のテスト
 *
 * チャットコマンドの応答文の {bgm} が、流している曲の曲名・クレジット表記・クレジット先のURLに
 * 置き換わること、止めているときは流していないと分かる文言になること、置き換わった文が
 * 見積もった最大の長さを超えないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { BGM_PLACEHOLDER, MAX_BGM_CREDIT_LENGTH, NO_BGM, bgmCreditText, fillBgmCredit } from './bgm-credit'

/** クレジット先のURLがある曲 */
const 雑談の曲 = { title: 'ひだまりの午後', credit: '音楽: 甘茶の音楽工房', creditUrl: 'https://amachamusic.chagasi.com/' }

describe('bgmCreditText', () => {
  it('曲名・クレジット表記・クレジット先のURLを1行にする', () => {
    expect(bgmCreditText(雑談の曲)).toBe('「ひだまりの午後」 音楽: 甘茶の音楽工房 https://amachamusic.chagasi.com/')
  })

  it('クレジット先のURLが無ければ、曲名とクレジット表記だけにする', () => {
    expect(bgmCreditText({ ...雑談の曲, creditUrl: '' })).toBe('「ひだまりの午後」 音楽: 甘茶の音楽工房')
  })

  it('止めているときは、流していないと分かる文言にする', () => {
    expect(bgmCreditText(null)).toBe(NO_BGM)
  })

  it('上限を縮める前に保存した長い曲なら、黙って切り詰めずに保存し直すよう投げる', () => {
    // 古い上限（曲名100・クレジット表記200・URL500文字）の範囲で、並べると364文字を超える曲
    const 古い上限で保存した曲 = { title: 'あ'.repeat(100), credit: 'い'.repeat(200), creditUrl: `https://${'u'.repeat(100)}` }

    expect(() => bgmCreditText(古い上限で保存した曲)).toThrow('/bgm/ で曲を直して保存し直してください')
  })

  it('曲の各項目が上限いっぱいでも、見積もった最大の長さに収まる', () => {
    const 上限いっぱいの曲 = { title: 'あ'.repeat(60), credit: 'い'.repeat(100), creditUrl: `https://${'u'.repeat(192)}` }

    expect(bgmCreditText(上限いっぱいの曲)).toHaveLength(MAX_BGM_CREDIT_LENGTH)
  })
})

describe('fillBgmCredit', () => {
  it(`文言の ${BGM_PLACEHOLDER} を、流している曲のクレジットに置き換える`, () => {
    expect(fillBgmCredit('いまの曲: {bgm}', 雑談の曲)).toBe('いまの曲: 「ひだまりの午後」 音楽: 甘茶の音楽工房 https://amachamusic.chagasi.com/')
  })

  it('止めているときは、流していないと分かる文言に置き換える', () => {
    expect(fillBgmCredit('いまの曲: {bgm}', null)).toBe(`いまの曲: ${NO_BGM}`)
  })

  it('曲名に $& のような置き換えの記号が入っていても、そのまま出す', () => {
    expect(fillBgmCredit('{bgm}', { ...雑談の曲, title: '$&', creditUrl: '' })).toBe('「$&」 音楽: 甘茶の音楽工房')
  })
})
