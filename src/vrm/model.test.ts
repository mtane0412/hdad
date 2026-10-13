/**
 * VRMの演出で出すモデルの設定の読み取り（model.ts）のテスト
 *
 * Worker が返した設定を読み、形が違えば黙って「選んでいない」と読まずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { readVrmModel } from './model'

describe('readVrmModel', () => {
  it('選んである VRM の素材のIDを読む', () => {
    expect(readVrmModel({ model: 'media-kanban' })).toEqual({ model: 'media-kanban' })
  })

  it('選んでいなければ null のまま読む', () => {
    expect(readVrmModel({ model: null })).toEqual({ model: null })
  })

  it('形が違えば投げる', () => {
    expect(() => readVrmModel({})).toThrow(/想定した形ではありません/)
    expect(() => readVrmModel({ model: 42 })).toThrow(/想定した形ではありません/)
    expect(() => readVrmModel('看板娘')).toThrow(/想定した形ではありません/)
  })
})
