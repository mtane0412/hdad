/**
 * VRMのマスコットの反応の呼び出しの読み取り（call.ts）のテスト
 *
 * Worker が押し出した文字列を読み、形が違えば黙って流さずに投げる。
 * 反応の最中に届いたときに捨ててよい反応（うなずき）を見分ける。
 */
import { describe, expect, it } from 'vitest'
import { isSkippableWhenBusy, parseVrmCall } from './call'

/** 看板娘の VRM でお礼をする呼び出し */
const valid = { id: '呼び出しID', seed: 42, reaction: 'thanks', model: '/api/media/media-kanban?key=overlay-key' }

describe('parseVrmCall', () => {
  it('種と反応の種類と VRM のURLを読む', () => {
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

  it('反応の種類が一覧に無ければ投げる', () => {
    expect(() => parseVrmCall(JSON.stringify({ ...valid, reaction: 'dance' }))).toThrow(/想定した形ではありません/)
    expect(() => parseVrmCall(JSON.stringify({ ...valid, reaction: undefined }))).toThrow(/想定した形ではありません/)
  })

  it('VRM のURLがこのサイトの素材の経路でなければ投げる（よそのファイルを読み込まない）', () => {
    expect(() => parseVrmCall(JSON.stringify({ ...valid, model: 'https://example.com/kanban.vrm' }))).toThrow(/想定した形ではありません/)
    expect(() => parseVrmCall(JSON.stringify({ ...valid, model: null }))).toThrow(/想定した形ではありません/)
  })
})

describe('isSkippableWhenBusy', () => {
  it('うなずきは、反応の最中に届いたら捨ててよい（速いチャットで待ちが積もらないように）', () => {
    expect(isSkippableWhenBusy('nod')).toBe(true)
  })

  it('お礼・大喜び・手を振るは捨てずに待って流す', () => {
    for (const reaction of ['thanks', 'cheer', 'wave'] as const) expect(isSkippableWhenBusy(reaction)).toBe(false)
  })
})
