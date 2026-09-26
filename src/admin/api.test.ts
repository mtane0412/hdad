/**
 * 管理用APIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/api'
import { createAdminApi, type TriggerInput } from './api'

const サイト = 'https://hdad.example.com'

const 乾杯の動画 = { id: 'sozai-1', name: '乾杯.webm', kind: 'video', contentType: 'video/webm', size: 1_234_567, uploadedAt: '2026-09-21T12:00:00.000Z' }

const 乾杯のトリガー = {
  kind: 'reward',
  rewardId: '報酬ID-乾杯',
  actions: [{ type: 'alert', mediaId: 'sozai-1', mediaKind: 'video', durationSeconds: 8, volume: 0.5, message: '{user} さん、乾杯！' }],
}

/** 送られたリクエストを記録し、決めた応答を返す fetch。body が null なら本文のない応答にする */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return body === null ? new Response(null, { status }) : Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('me（ログイン中の配信者）', () => {
  it('ログイン済みなら、ログイン名とオーバーレイ用キーを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { userId: '12345', login: 'haishinsha', overlayKey: 'overlay-key' })

    expect(await createAdminApi(fetchImpl).me()).toEqual({ userId: '12345', login: 'haishinsha', overlayKey: 'overlay-key' })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/me')
  })

  it('未ログイン（401）は失敗ではなく null で返す（ログインの案内を出すため）', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'unauthorized', message: 'ログインしてください' } })
    expect(await createAdminApi(fetchImpl).me()).toBeNull()
  })

  it('401以外の失敗は、Workerのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(500, { error: { code: 'misconfigured', message: 'Workerの環境変数が設定されていません: SESSION_SECRET' } })
    await expect(createAdminApi(fetchImpl).me()).rejects.toThrow('SESSION_SECRET')
  })
})

describe('config・saveConfig（トリガーの設定）', () => {
  it('保存済みのトリガーの一覧を取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { triggers: [乾杯のトリガー] })

    expect(await createAdminApi(fetchImpl).config()).toEqual([乾杯のトリガー])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/config')
  })

  it('応答が想定した形でなければエラーにする（黙って空の設定にしない）', async () => {
    const 種類のないトリガー = { ...乾杯のトリガー, actions: [{ ...乾杯のトリガー.actions[0], mediaKind: 'pdf' }] }
    await expect(createAdminApi(応答を返すfetch(200, { triggers: [種類のないトリガー] }).fetchImpl).config()).rejects.toThrow('triggers[0]')
    await expect(createAdminApi(応答を返すfetch(200, { triggers: 'なし' }).fetchImpl).config()).rejects.toThrow('triggers')
  })

  it('トリガーの一覧をまるごとPUTで保存し、Workerが整えた一覧を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { triggers: [乾杯のトリガー] })
    const 入力: TriggerInput = {
      kind: 'reward',
      rewardId: '報酬ID-乾杯',
      actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 8, volume: 0.5, message: '{user} さん、乾杯！' }],
    }

    const saved = await createAdminApi(fetchImpl).saveConfig([入力])

    expect(saved).toEqual([乾杯のトリガー])
    const request = requests[0]!
    expect(request.method).toBe('PUT')
    expect(new URL(request.url).pathname).toBe('/api/admin/config')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(await request.json()).toEqual({ triggers: [入力] })
  })

  it('パラメータを持たないメニュー項目のトリガーも、そのまま送受信する', async () => {
    const フォローのトリガー = {
      kind: 'follow',
      actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }],
    }
    const { requests, fetchImpl } = 応答を返すfetch(200, { triggers: [フォローのトリガー] })
    const 入力: TriggerInput = { kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }

    const saved = await createAdminApi(fetchImpl).saveConfig([入力])

    expect(saved).toEqual([フォローのトリガー])
    expect(await requests[0]!.json()).toEqual({ triggers: [入力] })
  })

  it('知らないメニュー項目のトリガーを受け取ったらエラーにする（黙って無視すると、絞り込みが効かないまま画面に出る）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { triggers: [{ ...乾杯のトリガー, kind: 'cheer' }] })
    await expect(createAdminApi(fetchImpl).config()).rejects.toThrow('triggers[0]')
  })

  it('メニュー項目に要るパラメータが無ければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { triggers: [{ kind: 'returningAfter', actions: 乾杯のトリガー.actions }] })
    await expect(createAdminApi(fetchImpl).config()).rejects.toThrow('triggers[0]')
  })

  it('設定に問題があれば、Workerが返した問題点をすべて持つ ApiError にする', async () => {
    const { fetchImpl } = 応答を返すfetch(400, {
      error: {
        code: 'invalid-config',
        message: 'アラートの設定に問題があります',
        problems: ['triggers[0].durationSeconds: 1〜60の数にしてください', 'triggers[0].mediaId: 素材「sozai-9」が存在しません'],
      },
    })

    const error = await createAdminApi(fetchImpl).saveConfig([]).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid-config',
      message: 'アラートの設定に問題があります',
      problems: ['triggers[0].durationSeconds: 1〜60の数にしてください', 'triggers[0].mediaId: 素材「sozai-9」が存在しません'],
    })
  })
})

describe('media・upload・removeMedia（素材）', () => {
  it('素材の一覧を取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { media: [乾杯の動画] })

    expect(await createAdminApi(fetchImpl).media()).toEqual([乾杯の動画])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/media')
  })

  it('素材の一覧が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { media: [{ ...乾杯の動画, size: '大きい' }] })
    await expect(createAdminApi(fetchImpl).media()).rejects.toThrow('media[0]')
  })

  it('ファイルの中身をそのまま本文にし、種類とファイル名（URLエンコード）をヘッダーで送る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(201, 乾杯の動画)
    const file = new File([new Uint8Array([26, 69, 223, 163])], '乾杯.webm', { type: 'video/webm' })

    const uploaded = await createAdminApi(fetchImpl).upload(file)

    expect(uploaded).toEqual(乾杯の動画)
    const request = requests[0]!
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe('/api/admin/media')
    expect(request.headers.get('Content-Type')).toBe('video/webm')
    expect(request.headers.get('X-File-Name')).toBe(encodeURIComponent('乾杯.webm'))
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([26, 69, 223, 163]))
  })

  it('大きすぎる素材などWorkerが断った場合は、Workerのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(413, { error: { code: 'too-large', message: '素材は50MBまでです' } })
    const file = new File([new Uint8Array([1])], '長い動画.mp4', { type: 'video/mp4' })
    await expect(createAdminApi(fetchImpl).upload(file)).rejects.toMatchObject({ status: 413, code: 'too-large', message: '素材は50MBまでです' })
  })

  it('素材をIDで削除する（IDはURLエンコードする）', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(204, null)

    await createAdminApi(fetchImpl).removeMedia('sozai/1')

    expect(requests[0]!.method).toBe('DELETE')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/media/sozai%2F1')
  })

  it('トリガーに使われている素材の削除は、理由を持つエラーになる', async () => {
    const { fetchImpl } = 応答を返すfetch(409, { error: { code: 'media-in-use', message: 'この素材はトリガーに使われています。先にトリガーの設定から外してください' } })
    await expect(createAdminApi(fetchImpl).removeMedia('sozai-1')).rejects.toMatchObject({ code: 'media-in-use' })
  })
})

describe('rotateOverlayKey・rewards・logout', () => {
  it('オーバーレイ用キーを発行し直し、新しいキーを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { overlayKey: '新しいキー' })

    expect(await createAdminApi(fetchImpl).rotateOverlayKey()).toBe('新しいキー')
    expect(requests[0]!.method).toBe('POST')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/overlay-key')
  })

  it('チャンネルポイント報酬の一覧を取得する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { rewards: [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }] })

    expect(await createAdminApi(fetchImpl).rewards()).toEqual([{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/rewards')
  })

  it('ログアウトはPOSTで依頼する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(204, null)

    await createAdminApi(fetchImpl).logout()

    expect(requests[0]!.method).toBe('POST')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/auth/logout')
  })

  it('本文がJSONでない失敗は、状態コードを示すエラーにする', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('<html>Bad Gateway</html>', { status: 502 })
    await expect(createAdminApi(fetchImpl).rewards()).rejects.toThrow('502')
  })
})
