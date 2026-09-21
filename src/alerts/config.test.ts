/**
 * 設定の取得（config.ts）のテスト
 *
 * オーバーレイはWorker（/api/overlay/config）からトリガーの一覧を受け取る。
 * 受け取った内容が想定した形でなければ、黙って空の設定にせずエラーにすることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { fetchTriggers } from './config'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const 設定の応答 = {
  triggers: [
    {
      event: REDEMPTION,
      rewardId: '報酬ID-乾杯',
      media: { kind: 'video', url: '/api/media/sozai-1?key=overlay-key' },
      durationSeconds: 8,
      volume: 0.5,
      message: '{user} さん、乾杯！',
    },
  ],
}

const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: URL[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    requests.push(new URL(String(input), 'https://stream-assets.example.com'))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('fetchTriggers', () => {
  it('オーバーレイ用キーを付けてWorkerから設定を取得し、トリガーの一覧を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, 設定の応答)

    const triggers = await fetchTriggers('overlay-key', fetchImpl)

    expect(triggers).toEqual(設定の応答.triggers)
    expect(requests[0]?.pathname).toBe('/api/overlay/config')
    expect(requests[0]?.searchParams.get('key')).toBe('overlay-key')
  })

  it('トリガーが1件もない設定は、空の一覧として受け取る', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { triggers: [] })
    expect(await fetchTriggers('overlay-key', fetchImpl)).toEqual([])
  })

  it('Workerが失敗を返したら、Workerのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })
    await expect(fetchTriggers('古いキー', fetchImpl)).rejects.toThrow('オーバーレイ用キーが正しくありません')
  })

  it('チャンネルポイント交換以外のイベントのトリガーも、報酬IDなしで受け取る', async () => {
    const 他のイベントの設定 = {
      triggers: [
        { event: 'channel.follow', media: { kind: 'image', url: '/api/media/sozai-2?key=overlay-key' }, durationSeconds: 5, volume: 1, message: '{user} さん、ありがとう！' },
        { event: 'channel.raid', media: { kind: 'video', url: '/api/media/sozai-3?key=overlay-key' }, durationSeconds: 5, volume: 1, message: '{user} さんが{viewers}人でレイド' },
      ],
    }
    const { fetchImpl } = 応答を返すfetch(200, 他のイベントの設定)

    expect(await fetchTriggers('overlay-key', fetchImpl)).toEqual(他のイベントの設定.triggers)
  })

  it('チャンネルポイント交換なのに報酬IDの欄がなければエラーにする', async () => {
    const { event, media, durationSeconds, volume, message } = { ...設定の応答.triggers[0], event: REDEMPTION }
    const { fetchImpl } = 応答を返すfetch(200, { triggers: [{ event, media, durationSeconds, volume, message }] })

    await expect(fetchTriggers('overlay-key', fetchImpl)).rejects.toThrow('triggers[0]')
  })

  it('知らない種類のイベントのトリガーはエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { triggers: [{ ...設定の応答.triggers[0], event: 'channel.cheer' }] })
    await expect(fetchTriggers('overlay-key', fetchImpl)).rejects.toThrow('triggers[0]')
  })

  it('応答が想定した形でなければエラーにする（黙って空の設定にしない）', async () => {
    const 素材のない設定 = { triggers: [{ ...設定の応答.triggers[0], media: { kind: 'pdf', url: '/api/media/x' } }] }
    await expect(fetchTriggers('overlay-key', 応答を返すfetch(200, 素材のない設定).fetchImpl)).rejects.toThrow('triggers[0]')
    await expect(fetchTriggers('overlay-key', 応答を返すfetch(200, { triggers: 'なし' }).fetchImpl)).rejects.toThrow('triggers')
  })
})
