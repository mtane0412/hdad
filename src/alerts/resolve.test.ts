/**
 * アラートの問い合わせ（resolve.ts）のテスト
 *
 * オーバーレイは届いた通知をそのままWorker（POST /api/overlay/alert）へ送り、再生するアラートを受け取る。
 * 照合をWorkerに任せているのは、条件に「その配信で初めての発言か」のようにデータベースの記録から決まるものがあり、
 * オーバーレイでは判定できないためである。
 * 受け取った内容が想定した形でなければ、黙って「当てはまらなかった」ことにせずエラーにすることを確認する。
 */
import { describe, expect, it } from 'vitest'
import type { EventSubNotification } from './eventsub'
import { resolveAlert } from './resolve'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const 交換の通知: EventSubNotification = {
  type: 'notification',
  id: 'message-1',
  subscriptionType: REDEMPTION,
  event: { user_name: '田中太郎', user_login: 'tanaka_taro', reward: { id: '報酬ID-乾杯', title: '乾杯する' } },
}

const アラートの応答 = {
  alert: { media: { kind: 'video', url: '/api/media/sozai-1?key=overlay-key' }, durationSeconds: 8, volume: 0.5, text: '田中太郎 さん、乾杯！' },
}

const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: { url: URL; init: RequestInit | undefined }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: new URL(String(input), 'https://stream-assets.example.com'), init })
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('resolveAlert', () => {
  it('オーバーレイ用キーと通知をWorkerへ送り、再生するアラートを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, アラートの応答)

    const alert = await resolveAlert('overlay-key', 交換の通知, fetchImpl)

    expect(alert).toEqual(アラートの応答.alert)
    expect(requests[0]?.url.pathname).toBe('/api/overlay/alert')
    expect(requests[0]?.url.searchParams.get('key')).toBe('overlay-key')
    expect(requests[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ subscriptionType: REDEMPTION, event: 交換の通知.event })
  })

  it('当てはまるトリガーがなければ null を返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { alert: null })

    expect(await resolveAlert('overlay-key', 交換の通知, fetchImpl)).toBeNull()
  })

  it('Workerが失敗を返したら、その文面でエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })

    await expect(resolveAlert('古いキー', 交換の通知, fetchImpl)).rejects.toThrow('オーバーレイ用キーが正しくありません')
  })

  it('Workerの失敗の文面を読めなければ、状態コードを添えてエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(500, 'JSONのオブジェクトではない')

    await expect(resolveAlert('overlay-key', 交換の通知, fetchImpl)).rejects.toThrow('500')
  })

  it('応答に alert が無ければエラーにする（黙って「当てはまらなかった」ことにしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, {})

    await expect(resolveAlert('overlay-key', 交換の通知, fetchImpl)).rejects.toThrow('alert')
  })

  it('応答のアラートが想定した形でなければエラーにする', async () => {
    const 素材のないアラート = { alert: { durationSeconds: 8, volume: 0.5, text: '乾杯！' } }
    const { fetchImpl } = 応答を返すfetch(200, 素材のないアラート)

    await expect(resolveAlert('overlay-key', 交換の通知, fetchImpl)).rejects.toThrow('alert')
  })

  it('素材の種類が知らないものならエラーにする', async () => {
    const 知らない種類 = { alert: { ...アラートの応答.alert, media: { kind: 'pdf', url: '/api/media/sozai-1' } } }
    const { fetchImpl } = 応答を返すfetch(200, 知らない種類)

    await expect(resolveAlert('overlay-key', 交換の通知, fetchImpl)).rejects.toThrow('alert')
  })
})
