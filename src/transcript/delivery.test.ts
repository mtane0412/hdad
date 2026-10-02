/**
 * 確定した発話の送信（delivery.ts）のテスト
 *
 * Worker への送信と待ち時間は代役に差し替え、実際には通信も待ちもしない。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import type { TranscriptApi } from './api'
import { createTranscriptDelivery, type DeliveredLine } from './delivery'

/** 送られた内容を記録し、決めた順に答える Worker の代役 */
const createApi = (answers: readonly (boolean | Error)[]) => {
  const sent: { messageId: string; text: string }[] = []
  let index = 0
  const api: TranscriptApi = {
    async send(messageId, text) {
      sent.push({ messageId, text })
      const answer = answers[index] ?? true
      index += 1
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { api, sent }
}

const setup = (answers: readonly (boolean | Error)[]) => {
  const { api, sent } = createApi(answers)
  const waits: number[] = []
  let lines: readonly DeliveredLine[] = []
  let nextId = 0
  const delivery = createTranscriptDelivery({
    api,
    createId: () => {
      nextId += 1
      return `識別子${nextId}`
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds)
    },
    onChange: (next) => {
      lines = next
    },
  })
  return { delivery, sent, waits, latest: () => lines }
}

describe('createTranscriptDelivery', () => {
  it('発話ごとに web speech の印を付けた新しいメッセージIDで送り、記録されたことを残す', async () => {
    const { delivery, sent, latest } = setup([true])

    await delivery.deliver('こんばんは、配信を始めます')

    expect(sent).toEqual([{ messageId: 'webspeech:識別子1', text: 'こんばんは、配信を始めます' }])
    expect(latest()).toEqual([{ id: 'webspeech:識別子1', text: 'こんばんは、配信を始めます', state: 'recorded' }])
  })

  it('配信していなくて捨てられたら、配信外として残す', async () => {
    const { delivery, latest } = setup([false])
    await delivery.deliver('マイクの確認です')
    expect(latest()[0]?.state).toBe('discarded')
  })

  it('通信の失敗なら、待ってから同じメッセージIDで送り直す', async () => {
    const { delivery, sent, waits, latest } = setup([new TypeError('Failed to fetch'), true])

    await delivery.deliver('こんばんは')

    // 同じ発話を二重に記録しないよう、送り直しも同じIDで送る
    expect(sent.map((call) => call.messageId)).toEqual(['webspeech:識別子1', 'webspeech:識別子1'])
    expect(waits).toHaveLength(1)
    expect(latest()[0]?.state).toBe('recorded')
  })

  it('送り直しても失敗が続けば、あきらめて理由を残す', async () => {
    const failure = new ApiError(503, 'unknown', 'Workerが 503 を返しました', [])
    const { delivery, sent, latest } = setup([failure, failure, failure, failure, failure, failure])

    await delivery.deliver('こんばんは')

    expect(sent.length).toBeGreaterThan(1)
    expect(latest()[0]).toMatchObject({ state: 'failed', error: 'Workerが 503 を返しました' })
  })

  it('本文の誤りなど、送り直しても同じ答えになる失敗は送り直さない', async () => {
    const { delivery, sent, latest } = setup([new ApiError(400, 'text-too-long', '発話は1000文字までにしてください', [])])

    await delivery.deliver('とても長い発話')

    expect(sent).toHaveLength(1)
    expect(latest()[0]).toMatchObject({ state: 'failed', error: '発話は1000文字までにしてください' })
  })

  it('残す発話は新しいものから上限の件数までにする', async () => {
    const { delivery, latest } = setup([])

    for (let count = 1; count <= 60; count += 1) await delivery.deliver(`発話${count}`)

    expect(latest()).toHaveLength(50)
    expect(latest()[0]?.text).toBe('発話60')
    expect(latest().at(-1)?.text).toBe('発話11')
  })
})
