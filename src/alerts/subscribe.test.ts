/**
 * 購読の依頼（subscribe.ts）のテスト
 *
 * オーバーレイは自分ではTwitchのトークンを持たないので、Worker（/api/eventsub/subscriptions）に購読を頼む。
 * 失敗したときに「待てば直る失敗」と「人が直さないと直らない失敗」を見分けることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { requestSubscriptions } from './subscribe'

const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), 'https://stream-assets.example.com'), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('requestSubscriptions', () => {
  it('オーバーレイ用キーとセッションIDをWorkerへ送る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { types: ['channel.raid'] })

    const result = await requestSubscriptions('オーバーレイ用キー', 'セッションID', fetchImpl)

    expect(result).toEqual({ ok: true })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/eventsub/subscriptions')
    expect(requests[0]!.method).toBe('POST')
    expect(await requests[0]!.json()).toEqual({ key: 'オーバーレイ用キー', sessionId: 'セッションID' })
  })

  it('キーの誤りや未ログイン（4xx）は、待っても直らない失敗として、Workerのメッセージと一緒に返す', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'invalid-overlay-key', message: 'オーバーレイ用キーが正しくありません' } })
    expect(await requestSubscriptions('古いキー', 'セッションID', fetchImpl)).toEqual({
      ok: false,
      retryable: false,
      message: 'オーバーレイ用キーが正しくありません',
    })
  })

  it('Workerの設定不足（500）も、待っても直らない失敗にする', async () => {
    const { fetchImpl } = 応答を返すfetch(500, { error: { code: 'misconfigured', message: 'Workerの環境変数が設定されていません' } })
    expect(await requestSubscriptions('オーバーレイ用キー', 'セッションID', fetchImpl)).toMatchObject({ ok: false, retryable: false })
  })

  it('Twitch側の失敗（502）は、待てば直るかもしれない失敗にする', async () => {
    const { fetchImpl } = 応答を返すfetch(502, { error: { code: 'twitch-error', message: 'Twitchが 503 を返しました' } })
    expect(await requestSubscriptions('オーバーレイ用キー', 'セッションID', fetchImpl)).toEqual({
      ok: false,
      retryable: true,
      message: 'Twitchが 503 を返しました',
    })
  })

  it('通信そのものに失敗した場合も、待てば直るかもしれない失敗にする', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch')
    }
    expect(await requestSubscriptions('オーバーレイ用キー', 'セッションID', fetchImpl)).toEqual({
      ok: false,
      retryable: true,
      message: 'Workerと通信できませんでした（Failed to fetch）',
    })
  })

  it('エラーの本文が想定した形でなければ、状態コードをメッセージにする', async () => {
    const { fetchImpl } = 応答を返すfetch(404, 'Not Found')
    expect(await requestSubscriptions('オーバーレイ用キー', 'セッションID', fetchImpl)).toEqual({
      ok: false,
      retryable: false,
      message: 'Workerが 404 を返しました',
    })
  })
})
