/**
 * 描く画面のポインタの読み取りのテスト
 *
 * 描く画面のキャンバスは、合成ページで手書きを置く箱とは大きさが違う。送るのは画素ではなく比なので、
 * ポインタの位置をキャンバスの大きさで割る部分を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createStrokeId, toRatio } from './pointer'

/** 幅400・高さ200のキャンバスが、画面の (40, 20) に置かれている状態 */
const canvasRect = { left: 40, top: 20, width: 400, height: 200 }

describe('toRatio', () => {
  it('キャンバスの左上を0、右下を1にする', () => {
    expect(toRatio(40, 20, canvasRect)).toEqual({ x: 0, y: 0 })
    expect(toRatio(440, 220, canvasRect)).toEqual({ x: 1, y: 1 })
  })

  it('真ん中は0.5になる', () => {
    expect(toRatio(240, 120, canvasRect)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('キャンバスの外へはみ出した位置も、そのまま比で返す', () => {
    // ポインタをキャンバスの外まで動かすことは普通に起こる。切り詰めると線が縁に張り付く
    expect(toRatio(0, 20, canvasRect)).toEqual({ x: -0.1, y: 0 })
  })

  it('大きさを測れていないキャンバスでは、左上として扱う（0で割らない）', () => {
    expect(toRatio(100, 100, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('createStrokeId', () => {
  it('呼ぶたびに違う名前になる（前の線に点が足されないようにする）', () => {
    expect(createStrokeId()).not.toBe(createStrokeId())
  })

  it('名前の長さは、送れる上限に収まる', () => {
    expect(createStrokeId().length).toBeLessThanOrEqual(64)
  })
})
