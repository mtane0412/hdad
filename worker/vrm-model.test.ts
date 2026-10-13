/**
 * VRMの演出で出すモデルの設定（vrm-model.ts）のテスト
 *
 * 配信者がアップロードした VRM 1つだけを持つ。VRM でない素材・無い素材はまとめて問題点として断る。
 * 合成ページへは素材のIDを VRM のURL（オーバーレイ用キーつき）に置き換えて押し出す。
 * モデルを選んでいない・キーが未発行なら、黙って何も出さずに済ませずに投げる。
 */
import { describe, expect, it } from 'vitest'
import type { MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_VRM_MODEL, loadVrmModel, parseVrmModel, playbackVrmModelOf, saveVrmModel, vrmModelUses } from './vrm-model'

/** 看板娘の VRM と、写真の画像を1つずつ上げてある */
const kindOfMedia = (mediaId: string): MediaKind | null => {
  if (mediaId === 'media-kanban') return 'vrm'
  if (mediaId === 'media-photo') return 'image'
  return null
}

describe('parseVrmModel', () => {
  it('VRM の素材を、そのまま保存用の形にする', () => {
    expect(parseVrmModel({ model: 'media-kanban' }, kindOfMedia)).toEqual({ model: 'media-kanban' })
  })

  it('モデルが null なら「選んでいない」として通す', () => {
    expect(parseVrmModel({ model: null }, kindOfMedia)).toEqual({ model: null })
  })

  it('オブジェクトでなければ断る', () => {
    expect(() => parseVrmModel('看板娘', kindOfMedia)).toThrow(expect.objectContaining({ problems: ['設定はオブジェクトで指定してください'] }))
  })

  it('無い素材・VRM でない素材・文字列でない値を問題点として返す', () => {
    expect(() => parseVrmModel({ model: 'media-photo' }, kindOfMedia)).toThrow(expect.objectContaining({ problems: ['model: 素材「media-photo」は VRM ではありません'] }))
    expect(() => parseVrmModel({ model: 'media-nothing' }, kindOfMedia)).toThrow(expect.objectContaining({ problems: ['model: 素材「media-nothing」が存在しません'] }))
    expect(() => parseVrmModel({ model: 42 }, kindOfMedia)).toThrow(expect.objectContaining({ problems: ['model: 素材のIDか null で指定してください'] }))
  })
})

describe('saveVrmModel / loadVrmModel', () => {
  it('未保存ならモデルを選んでいない設定を返す', async () => {
    expect(await loadVrmModel(createFakeStore())).toEqual(DEFAULT_VRM_MODEL)
    expect(DEFAULT_VRM_MODEL).toEqual({ model: null })
  })

  it('保存した設定をそのまま読み出す', async () => {
    const store = createFakeStore()

    await saveVrmModel(store, { model: 'media-kanban' })

    expect(await loadVrmModel(store)).toEqual({ model: 'media-kanban' })
  })
})

describe('vrmModelUses', () => {
  it('選ばれている素材かどうかを答える（選ばれている素材は削除させない）', () => {
    expect(vrmModelUses({ model: 'media-kanban' }, 'media-kanban')).toBe(true)
    expect(vrmModelUses({ model: 'media-kanban' }, 'media-photo')).toBe(false)
    expect(vrmModelUses({ model: null }, 'media-kanban')).toBe(false)
  })
})

describe('playbackVrmModelOf', () => {
  it('素材のIDを、オーバーレイ用キーつきの VRM のURLに置き換える', () => {
    expect(playbackVrmModelOf({ model: 'media-kanban' }, 'issued-overlay-key')).toBe('/api/media/media-kanban?key=issued-overlay-key')
  })

  it('モデルを選んでいなければ投げる（何も映らない演出を黙って流さない）', () => {
    expect(() => playbackVrmModelOf({ model: null }, 'issued-overlay-key')).toThrow(/VRM が選ばれていません/)
  })

  it('オーバーレイ用キーが未発行なら投げる', () => {
    expect(() => playbackVrmModelOf({ model: 'media-kanban' }, null)).toThrow(/オーバーレイ用キーが未発行/)
  })
})
