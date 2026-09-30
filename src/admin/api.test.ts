/**
 * 管理用APIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/api'
import { createAdminApi, type TriggerInput } from './api'

const site = 'https://hdad.example.com'

const toastVideo = { id: 'sozai-1', name: '乾杯.webm', kind: 'video', contentType: 'video/webm', size: 1_234_567, uploadedAt: '2026-09-21T12:00:00.000Z' }

const toastTrigger = {
  kind: 'reward',
  rewardId: '報酬ID-乾杯',
  actions: [{ type: 'alert', mediaId: 'sozai-1', mediaKind: 'video', durationSeconds: 8, volume: 0.5, message: '{user} さん、乾杯！' }],
}

/** 送られたリクエストを記録し、決めた応答を返す fetch。body が null なら本文のない応答にする */
const fetchReturning = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), site), init))
    return body === null ? new Response(null, { status }) : Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('me（ログイン中の配信者）', () => {
  it('ログイン済みなら、ログイン名とオーバーレイ用キーを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { userId: '12345', login: 'haishinsha', overlayKey: 'overlay-key' })

    expect(await createAdminApi(fetchImpl).me()).toEqual({ userId: '12345', login: 'haishinsha', overlayKey: 'overlay-key' })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/me')
  })

  it('未ログイン（401）は失敗ではなく null で返す（ログインの案内を出すため）', async () => {
    const { fetchImpl } = fetchReturning(401, { error: { code: 'unauthorized', message: 'ログインしてください' } })
    expect(await createAdminApi(fetchImpl).me()).toBeNull()
  })

  it('401以外の失敗は、Workerのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = fetchReturning(500, { error: { code: 'misconfigured', message: 'Workerの環境変数が設定されていません: SESSION_SECRET' } })
    await expect(createAdminApi(fetchImpl).me()).rejects.toThrow('SESSION_SECRET')
  })
})

describe('config・saveConfig（トリガーの設定）', () => {
  it('保存済みのトリガーの一覧を取得する', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { triggers: [toastTrigger] })

    expect(await createAdminApi(fetchImpl).config()).toEqual([toastTrigger])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/config')
  })

  it('応答が想定した形でなければエラーにする（黙って空の設定にしない）', async () => {
    const triggerWithoutKind = { ...toastTrigger, actions: [{ ...toastTrigger.actions[0], mediaKind: 'pdf' }] }
    await expect(createAdminApi(fetchReturning(200, { triggers: [triggerWithoutKind] }).fetchImpl).config()).rejects.toThrow('triggers[0]')
    await expect(createAdminApi(fetchReturning(200, { triggers: 'なし' }).fetchImpl).config()).rejects.toThrow('triggers')
  })

  it('トリガーの一覧をまるごとPUTで保存し、Workerが整えた一覧を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { triggers: [toastTrigger] })
    const triggerInput: TriggerInput = {
      kind: 'reward',
      rewardId: '報酬ID-乾杯',
      actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 8, volume: 0.5, message: '{user} さん、乾杯！' }],
    }

    const saved = await createAdminApi(fetchImpl).saveConfig([triggerInput])

    expect(saved).toEqual([toastTrigger])
    const request = requests[0]!
    expect(request.method).toBe('PUT')
    expect(new URL(request.url).pathname).toBe('/api/admin/config')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(await request.json()).toEqual({ triggers: [triggerInput] })
  })

  it('パラメータを持たないメニュー項目のトリガーも、そのまま送受信する', async () => {
    const followTrigger = {
      kind: 'follow',
      actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }],
    }
    const { requests, fetchImpl } = fetchReturning(200, { triggers: [followTrigger] })
    const triggerInput: TriggerInput = { kind: 'follow', actions: [{ type: 'chat', message: '{user} さん、フォローありがとうございます！' }] }

    const saved = await createAdminApi(fetchImpl).saveConfig([triggerInput])

    expect(saved).toEqual([followTrigger])
    expect(await requests[0]!.json()).toEqual({ triggers: [triggerInput] })
  })

  it('知らないメニュー項目のトリガーを受け取ったらエラーにする（黙って無視すると、絞り込みが効かないまま画面に出る）', async () => {
    const { fetchImpl } = fetchReturning(200, { triggers: [{ ...toastTrigger, kind: 'cheer' }] })
    await expect(createAdminApi(fetchImpl).config()).rejects.toThrow('triggers[0]')
  })

  it('メニュー項目に要るパラメータが無ければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { triggers: [{ kind: 'comeback', actions: toastTrigger.actions }] })
    await expect(createAdminApi(fetchImpl).config()).rejects.toThrow('triggers[0]')
  })

  it('設定に問題があれば、Workerが返した問題点をすべて持つ ApiError にする', async () => {
    const { fetchImpl } = fetchReturning(400, {
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
    const { requests, fetchImpl } = fetchReturning(200, { media: [toastVideo] })

    expect(await createAdminApi(fetchImpl).media()).toEqual([toastVideo])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/media')
  })

  it('素材の一覧が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { media: [{ ...toastVideo, size: '大きい' }] })
    await expect(createAdminApi(fetchImpl).media()).rejects.toThrow('media[0]')
  })

  it('ファイルの中身をそのまま本文にし、種類とファイル名（URLエンコード）をヘッダーで送る', async () => {
    const { requests, fetchImpl } = fetchReturning(201, toastVideo)
    const file = new File([new Uint8Array([26, 69, 223, 163])], '乾杯.webm', { type: 'video/webm' })

    const uploaded = await createAdminApi(fetchImpl).upload(file)

    expect(uploaded).toEqual(toastVideo)
    const request = requests[0]!
    expect(request.method).toBe('POST')
    expect(new URL(request.url).pathname).toBe('/api/admin/media')
    expect(request.headers.get('Content-Type')).toBe('video/webm')
    expect(request.headers.get('X-File-Name')).toBe(encodeURIComponent('乾杯.webm'))
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([26, 69, 223, 163]))
  })

  it('大きすぎる素材などWorkerが断った場合は、Workerのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = fetchReturning(413, { error: { code: 'too-large', message: '素材は50MBまでです' } })
    const file = new File([new Uint8Array([1])], '長い動画.mp4', { type: 'video/mp4' })
    await expect(createAdminApi(fetchImpl).upload(file)).rejects.toMatchObject({ status: 413, code: 'too-large', message: '素材は50MBまでです' })
  })

  it('素材をIDで削除する（IDはURLエンコードする）', async () => {
    const { requests, fetchImpl } = fetchReturning(204, null)

    await createAdminApi(fetchImpl).removeMedia('sozai/1')

    expect(requests[0]!.method).toBe('DELETE')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/media/sozai%2F1')
  })

  it('トリガーに使われている素材の削除は、理由を持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(409, { error: { code: 'media-in-use', message: 'この素材はトリガーに使われています。先にトリガーの設定から外してください' } })
    await expect(createAdminApi(fetchImpl).removeMedia('sozai-1')).rejects.toMatchObject({ code: 'media-in-use' })
  })
})

/** Workerが返すチャンネルポイント報酬（HDADが作ったもの） */
const toastReward = { id: '報酬ID-乾杯', title: '乾杯する', cost: 500, prompt: 'おつまみも添えて', isEnabled: true, isUserInputRequired: false, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true }

/** 管理画面から送る報酬の内容 */
const toastRewardInput = { title: '乾杯する', cost: 500, prompt: 'おつまみも添えて', isEnabled: true, isUserInputRequired: false }

describe('createReward・updateReward・removeReward（チャンネルポイント報酬）', () => {
  it('報酬の内容をJSONでPOSTし、作られた報酬を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(201, toastReward)

    expect(await createAdminApi(fetchImpl).createReward(toastRewardInput)).toEqual(toastReward)
    expect(requests[0]!.method).toBe('POST')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/rewards')
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/json')
    expect(await requests[0]!.json()).toEqual(toastRewardInput)
  })

  it('入力に問題があれば、問題点を持つエラーにする', async () => {
    const { fetchImpl } = fetchReturning(400, {
      error: { code: 'invalid-config', message: 'チャンネルポイント報酬に問題があります', problems: ['title: 名前は空でない45文字までの文字列で指定してください'] },
    })
    await expect(createAdminApi(fetchImpl).createReward({ ...toastRewardInput, title: '' })).rejects.toMatchObject({
      problems: ['title: 名前は空でない45文字までの文字列で指定してください'],
    })
  })

  it('報酬のIDをURLエンコードしてPATCHし、更新後の報酬を返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { ...toastReward, cost: 800 })

    expect(await createAdminApi(fetchImpl).updateReward('報酬/乾杯', { ...toastRewardInput, cost: 800 })).toEqual({ ...toastReward, cost: 800 })
    expect(requests[0]!.method).toBe('PATCH')
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/admin/rewards/${encodeURIComponent('報酬/乾杯')}`)
    expect(await requests[0]!.json()).toEqual({ ...toastRewardInput, cost: 800 })
  })

  it('作成・更新の応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = fetchReturning(200, { id: '報酬ID-乾杯' })
    await expect(createAdminApi(fetchImpl).updateReward('報酬ID-乾杯', toastRewardInput)).rejects.toThrow()
  })

  it('報酬の削除はDELETEで依頼する', async () => {
    const { requests, fetchImpl } = fetchReturning(204, null)

    await createAdminApi(fetchImpl).removeReward('報酬ID-乾杯')

    expect(requests[0]!.method).toBe('DELETE')
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/admin/rewards/${encodeURIComponent('報酬ID-乾杯')}`)
  })

  it('トリガーに使われている報酬の削除は、理由を持つエラーになる', async () => {
    const { fetchImpl } = fetchReturning(409, { error: { code: 'reward-in-use', message: 'この報酬はトリガーに使われています' } })
    await expect(createAdminApi(fetchImpl).removeReward('報酬ID-乾杯')).rejects.toMatchObject({ code: 'reward-in-use' })
  })
})

describe('rotateOverlayKey・rewards・logout', () => {
  it('オーバーレイ用キーを発行し直し、新しいキーを返す', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { overlayKey: '新しいキー' })

    expect(await createAdminApi(fetchImpl).rotateOverlayKey()).toBe('新しいキー')
    expect(requests[0]!.method).toBe('POST')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/overlay-key')
  })

  it('チャンネルポイント報酬の一覧を取得する', async () => {
    const { requests, fetchImpl } = fetchReturning(200, { rewards: [toastReward] })

    expect(await createAdminApi(fetchImpl).rewards()).toEqual([toastReward])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/rewards')
  })

  it('報酬の一覧に画像のURLが無ければエラーにする', async () => {
    const withoutImage: Record<string, unknown> = { ...toastReward }
    delete withoutImage.imageUrl
    const { fetchImpl } = fetchReturning(200, { rewards: [withoutImage] })
    await expect(createAdminApi(fetchImpl).rewards()).rejects.toThrow('rewards[0]')
  })

  it('報酬の一覧が想定した形でなければエラーにする（変更できるかどうかが無いなど）', async () => {
    const withoutManageable: Record<string, unknown> = { ...toastReward }
    delete withoutManageable.manageable
    const { fetchImpl } = fetchReturning(200, { rewards: [withoutManageable] })
    await expect(createAdminApi(fetchImpl).rewards()).rejects.toThrow('rewards[0]')
  })

  it('ログアウトはPOSTで依頼する', async () => {
    const { requests, fetchImpl } = fetchReturning(204, null)

    await createAdminApi(fetchImpl).logout()

    expect(requests[0]!.method).toBe('POST')
    expect(new URL(requests[0]!.url).pathname).toBe('/api/auth/logout')
  })

  it('本文がJSONでない失敗は、状態コードを示すエラーにする', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('<html>Bad Gateway</html>', { status: 502 })
    await expect(createAdminApi(fetchImpl).rewards()).rejects.toThrow('502')
  })
})
