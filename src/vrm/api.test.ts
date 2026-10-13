/**
 * VRMの演出の、Worker とのつなぎ方（api.ts）のテスト
 *
 * プレビュー（?demo=true）では、配信者のセッションで出す VRM の設定を読み、その素材のURLを返す。
 * 選んでいなければ、何も映らないプレビューを黙って出さずに投げる。
 * 配信中のマスコットは、オーバーレイ用キーで出す VRM のURLを読む。URLが素材の経路でなければ、よそのファイルを読み込まずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { fetchMascotModelUrl, fetchPreviewModelUrl } from './api'

/** 決まった応答を返す fetch の代役。呼ばれたパスを控える */
const fakeFetch = (status: number, body: unknown) => {
  const paths: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    paths.push(String(input))
    return Response.json(body, { status })
  }
  return { paths, fetchImpl }
}

describe('fetchPreviewModelUrl', () => {
  it('選んである VRM の素材のURLを返す', async () => {
    const fake = fakeFetch(200, { model: 'media-kanban' })

    expect(await fetchPreviewModelUrl(fake.fetchImpl)).toBe('/api/media/media-kanban')
    expect(fake.paths).toEqual(['/api/admin/vrm/model'])
  })

  it('VRM を選んでいなければ投げる', async () => {
    await expect(fetchPreviewModelUrl(fakeFetch(200, { model: null }).fetchImpl)).rejects.toThrow(/VRM が選ばれていません/)
  })

  it('設定を読めなければ投げる（ログインしていないなど）', async () => {
    await expect(fetchPreviewModelUrl(fakeFetch(401, { error: { code: 'unauthorized', message: 'ログインしてください' } }).fetchImpl)).rejects.toThrow()
  })
})

describe('fetchMascotModelUrl', () => {
  const overlayKey = 'issued-overlay-key-0123456789abcdefghij'

  it('オーバーレイ用キーをつけて読み、出す VRM のURLを返す', async () => {
    const fake = fakeFetch(200, { model: `/api/media/media-kanban?key=${overlayKey}` })

    expect(await fetchMascotModelUrl(fake.fetchImpl, overlayKey)).toBe(`/api/media/media-kanban?key=${overlayKey}`)
    expect(fake.paths).toEqual([`/api/overlay/vrm/model?key=${overlayKey}`])
  })

  it('VRM を選んでいない（409）なら、Worker の理由のまま投げる', async () => {
    const fake = fakeFetch(409, { error: { code: 'vrm-not-ready', message: 'VRMの演出で出す VRM が選ばれていません' } })

    await expect(fetchMascotModelUrl(fake.fetchImpl, overlayKey)).rejects.toThrow(/VRM が選ばれていません/)
  })

  it('URLが素材の経路でなければ、よそのファイルを読み込まずに投げる', async () => {
    const fake = fakeFetch(200, { model: 'https://example.com/other.vrm' })

    await expect(fetchMascotModelUrl(fake.fetchImpl, overlayKey)).rejects.toThrow()
  })
})
