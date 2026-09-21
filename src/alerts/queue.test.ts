/**
 * アラートの再生待ちの列（queue.ts）のテスト
 *
 * アラートは1件ずつ順番に再生する。再生中に届いたものは重ねずに待たせ、終わったら次を再生する。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_QUEUE, advance, enqueue } from './queue'
import type { Alert } from './trigger'

const アラート = (text: string): Alert => ({
  media: { kind: 'image', url: 'https://example.com/kanpai.png' },
  durationSeconds: 5,
  volume: 1,
  text,
})

describe('enqueue', () => {
  it('何も再生していなければ、届いたアラートをすぐ再生中にする', () => {
    expect(enqueue(EMPTY_QUEUE, アラート('1件目'))).toEqual({ current: アラート('1件目'), waiting: [] })
  })

  it('再生中に届いたアラートは、届いた順に待たせる', () => {
    const queue = [アラート('2件目'), アラート('3件目')].reduce(enqueue, enqueue(EMPTY_QUEUE, アラート('1件目')))
    expect(queue).toEqual({ current: アラート('1件目'), waiting: [アラート('2件目'), アラート('3件目')] })
  })
})

describe('advance', () => {
  it('再生が終わったら、待っている先頭を再生中にする', () => {
    const queue = { current: アラート('1件目'), waiting: [アラート('2件目'), アラート('3件目')] }
    expect(advance(queue)).toEqual({ current: アラート('2件目'), waiting: [アラート('3件目')] })
  })

  it('待っているものがなければ、何も再生していない状態に戻る', () => {
    expect(advance({ current: アラート('1件目'), waiting: [] })).toEqual(EMPTY_QUEUE)
  })
})
