/**
 * 漢字クイズの画面に出す文言（captions.ts）のテスト
 *
 * 級の見出し・出題させた人・正解の読みの並べ方を決める。描くのは view.ts で、ここは文言だけを受け持つ。
 */
import { describe, expect, it } from 'vitest'
import { answerLineOf, gradeHeadlineOf, requesterLineOf, stopBannerLineOf, winnerLineOf } from './captions'

describe('gradeHeadlineOf', () => {
  it('「漢検○級」の形にする（準のつく級も同じ）', () => {
    expect(gradeHeadlineOf('6')).toBe('漢検6級')
    expect(gradeHeadlineOf('pre1')).toBe('漢検準1級')
  })
})

describe('requesterLineOf', () => {
  it('交換した人がいれば「○○さんからの出題」にする', () => {
    expect(requesterLineOf('田中太郎')).toBe('田中太郎さんからの出題')
  })

  it('試し再生（交換した人がいない）なら出さない', () => {
    expect(requesterLineOf(null)).toBeNull()
  })
})

describe('answerLineOf', () => {
  it('正解の読みが1つならそのまま出す', () => {
    expect(answerLineOf(['けいだい'])).toBe('けいだい')
  })

  it('正解の読みが複数なら「／」で区切って並べる', () => {
    expect(answerLineOf(['ついたち', 'いちにち', 'いちじつ'])).toBe('ついたち／いちにち／いちじつ')
  })
})

describe('winnerLineOf', () => {
  it('最初の正解者の名前を「○○さん 正解！」にする', () => {
    expect(winnerLineOf('山田花子')).toBe('山田花子さん 正解！')
  })
})

describe('stopBannerLineOf', () => {
  it('試し再生で猶予が尽きたら、止めないことを出す', () => {
    expect(stopBannerLineOf({ kind: 'rehearsal' })).toBe('試し再生なので配信は止めません')
  })
})
