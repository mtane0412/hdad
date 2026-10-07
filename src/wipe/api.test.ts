/**
 * ワイプのWorkerの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { createWipeOverlayApi } from './api'

const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'
const iconUrl = 'https://static-cdn.jtvnw.net/jtv_user_pictures/tanenob-profile_image-300x300.png'

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const fetchReturning = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), site), init))
    return Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('createWipeOverlayApi', () => {
  it('オーバーレイ用キーとログイン名を付けて、アイコンのURLを引く', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { profileImageUrl: iconUrl })

    const url = await createWipeOverlayApi(fetchImpl, overlayKey).lookupIcon('tanenob')

    expect(url).toBe(iconUrl)
    const requested = new URL(requests[0]?.url ?? '')
    expect(requested.pathname).toBe('/api/overlay/wipe/icon')
    expect(requested.searchParams.get('key')).toBe(overlayKey)
    expect(requested.searchParams.get('login')).toBe('tanenob')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { icon: iconUrl })

    await expect(createWipeOverlayApi(fetchImpl, overlayKey).lookupIcon('tanenob')).rejects.toThrow(/想定した形/)
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = fetchReturning(502, { error: { code: 'twitch-api', message: 'Twitchにログイン名 tanenob のアイコンがありません' } })

    await expect(createWipeOverlayApi(fetchImpl, overlayKey).lookupIcon('tanenob')).rejects.toThrow(/tanenob/)
  })
})
