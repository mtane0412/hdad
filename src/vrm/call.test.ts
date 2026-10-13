/**
 * VRMの演出の呼び出しの読み取り（call.ts）のテスト
 *
 * Worker が押し出した文字列を読み、形が違えば黙って流さずに投げる。
 */
import { describe, expect, it } from 'vitest'
import { parseVrmCall } from './call'

/** 看板娘の VRM を出す呼び出し */
const valid = { id: '呼び出しID', seed: 42, model: '/api/media/media-kanban?key=overlay-key' }

describe('parseVrmCall', () => {
  it('種と VRM のURLを読む', () => {
    expect(parseVrmCall(JSON.stringify(valid))).toEqual(valid)
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseVrmCall('看板娘が出てくる')).toThrow(/JSONとして読めません/)
  })

  it('種が範囲外・整数でなければ投げる', () => {
    expect(() => parseVrmCall(JSON.stringify({ ...valid, seed: -1 }))).toThrow(/想定した形ではありません/)
    expect(() => parseVrmCall(JSON.stringify({ ...valid, seed: 2 ** 32 }))).toThrow(/想定した形ではありません/)
    expect(() => parseVrmCall(JSON.stringify({ ...valid, seed: 1.5 }))).toThrow(/想定した形ではありません/)
  })

  it('VRM のURLがこのサイトの素材の経路でなければ投げる（よそのファイルを読み込まない）', () => {
    expect(() => parseVrmCall(JSON.stringify({ ...valid, model: 'https://example.com/kanban.vrm' }))).toThrow(/想定した形ではありません/)
    expect(() => parseVrmCall(JSON.stringify({ ...valid, model: null }))).toThrow(/想定した形ではありません/)
  })
})
