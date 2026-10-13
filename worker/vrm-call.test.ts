/**
 * VRMの演出の呼び出しの組み立て（vrm-call.ts）のテスト
 *
 * Worker は動き方の種と、出す VRM のURLだけを押し出す。動きの中身は合成ページが種から計算する。
 * 種は 0 以上 2^32 未満の整数で、合成ページの読み取り（src/vrm/call.ts の parseVrmCall）がそのまま受け取れる形にする。
 */
import { describe, expect, it } from 'vitest'
import { parseVrmCall } from '../src/vrm/call'
import { vrmCallOf, vrmSeedOf } from './vrm-call'

/** 看板娘の VRM（Worker がオーバーレイ用キーつきのURLに置き換えたもの） */
const model = '/api/media/media-kanban?key=issued-overlay-key-0123456789abcdefghij'

describe('vrmCallOf', () => {
  it('VRM のURLを、種と一緒に並べる', () => {
    expect(vrmCallOf(model, 42, '呼び出しID')).toEqual({ id: '呼び出しID', seed: 42, model })
  })

  it('合成ページの読み取りが、そのまま同じ呼び出しとして読める', () => {
    const call = vrmCallOf(model, 4294967295, '呼び出しID')
    expect(parseVrmCall(JSON.stringify(call))).toEqual(call)
  })
})

describe('vrmSeedOf', () => {
  it('乱数の32ビットの値をそのまま種にする', () => {
    expect(vrmSeedOf(new Uint32Array([358]))).toBe(358)
  })

  it('値が入っていなければ投げる', () => {
    expect(() => vrmSeedOf(new Uint32Array(0))).toThrow(/種にする乱数がありません/)
  })
})
