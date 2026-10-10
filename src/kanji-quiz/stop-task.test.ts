/**
 * 裏方のページの「配信の停止」（stop-task.ts）のテスト
 *
 * 配信を止める命令が届いたら、OBS へ StopStream を送り、止められたか（止められなければその理由）を Worker へ知らせる（issue #302）。
 * ここでは OBS への接続と Worker への知らせを代役にして、1回ぶんの流れ（executeStreamStop）を確かめる。
 * - 接続が切れていたら、つなぎ直してから送る
 * - OBS につながらない・StopStream を断られたら、黙らずその理由を知らせる
 */
import { describe, expect, it } from 'vitest'
import type { ObsConnection } from '../screen/connection'
import { executeStreamStop } from './stop-task'

/** 送った要求を覚える OBS の接続の代役。failure を渡すと、要求を断る */
const fakeObs = ({ open = true, failure }: { open?: boolean; failure?: string } = {}) => {
  const requests: string[] = []
  const connection: ObsConnection = {
    request: async (requestType) => {
      requests.push(requestType)
      if (failure !== undefined) throw new Error(failure)
      return {}
    },
    isOpen: () => open,
    close: () => undefined,
  }
  return { requests, connection }
}

describe('executeStreamStop', () => {
  it('OBS へ StopStream を送り、止められたことを知らせる（理由は null）', async () => {
    const obs = fakeObs()
    const reports: [string, string | null][] = []

    const result = await executeStreamStop(
      { current: () => obs.connection, reconnect: async () => obs.connection, reportStop: async (quizId, error) => void reports.push([quizId, error]) },
      'quiz-keidai',
    )

    expect(obs.requests).toEqual(['StopStream'])
    expect(reports).toEqual([['quiz-keidai', null]])
    expect(result).toBeNull()
  })

  it('接続が切れていたら、つなぎ直してから StopStream を送る', async () => {
    const closed = fakeObs({ open: false })
    const reopened = fakeObs()

    await executeStreamStop({ current: () => closed.connection, reconnect: async () => reopened.connection, reportStop: async () => {} }, 'quiz-keidai')

    expect(closed.requests).toEqual([])
    expect(reopened.requests).toEqual(['StopStream'])
  })

  it('StopStream を断られたら、その理由を知らせる', async () => {
    const obs = fakeObs({ failure: '配信していません（OutputNotRunning）' })
    const reports: [string, string | null][] = []

    const result = await executeStreamStop(
      { current: () => obs.connection, reconnect: async () => obs.connection, reportStop: async (quizId, error) => void reports.push([quizId, error]) },
      'quiz-keidai',
    )

    expect(reports).toEqual([['quiz-keidai', '配信していません（OutputNotRunning）']])
    expect(result).toBe('配信していません（OutputNotRunning）')
  })

  it('つなぎ直せなかったら、その理由を知らせる', async () => {
    const closed = fakeObs({ open: false })
    const reports: [string, string | null][] = []

    await executeStreamStop(
      {
        current: () => closed.connection,
        reconnect: async () => {
          throw new Error('ws://localhost:4455 につながりませんでした')
        },
        reportStop: async (quizId, error) => void reports.push([quizId, error]),
      },
      'quiz-keidai',
    )

    expect(reports).toEqual([['quiz-keidai', 'ws://localhost:4455 につながりませんでした']])
  })
})
