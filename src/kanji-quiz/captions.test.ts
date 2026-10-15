/**
 * 漢字クイズの画面に出す文言（captions.ts）のテスト
 *
 * 級の見出し・出題させた人・正解の読みの並べ方を決める。描くのは view.ts で、ここは文言だけを受け持つ。
 */
import { describe, expect, it } from 'vitest'
import { answerLineOf, gradeHeadlineOf, requesterLineOf, stakesLineOf, stopBannerLineOf, winnerLineOf, wrongAnswerLineOf } from './captions'
import { ANSWER_LIMIT_MS } from './scene'

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

describe('wrongAnswerLineOf', () => {
  it('不正解の回答を、答えた人の名前と一緒に「直前の回答」として1行にする', () => {
    expect(wrongAnswerLineOf({ userName: '田中太郎', answer: 'いちじょう' })).toBe('直前の回答：いちじょう（田中太郎さん）')
  })
})

describe('stakesLineOf', () => {
  it('制限時間の秒数を添えて、誰も正解しなければ配信が終わることを告げる', () => {
    // 前提: 制限時間は scene.ts の ANSWER_LIMIT_MS（60秒）から取る
    expect(ANSWER_LIMIT_MS).toBe(60_000)
    expect(stakesLineOf()).toBe('60秒以内に誰も正解できなければ配信終了')
  })
})
