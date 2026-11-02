/**
 * 描画の間引き（src/overlay/frame-gate.ts）のテスト
 *
 * プレビューの描画を一定の頻度に抑えつつ、画面の更新の刻みとの端数で頻度が落ちないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { createFrameGate } from './frame-gate'

/** 更新間隔 frameMs の画面で seconds 秒回したときに、描画を許された回数を数える */
const countDraws = (gate: (elapsedMs: number) => boolean, frameMs: number, seconds: number): number => {
  const frames = Math.round((seconds * 1000) / frameMs)
  let draws = 0
  for (let frame = 0; frame < frames; frame += 1) {
    if (gate(frame * frameMs)) draws += 1
  }
  return draws
}

describe('createFrameGate', () => {
  it('最初のフレームは描く（開いた直後から映す）', () => {
    expect(createFrameGate(15)(0)).toBe(true)
  })

  it('間隔が経つまでは描かず、経ったら描く', () => {
    const gate = createFrameGate(10)

    expect(gate(1000)).toBe(true)
    expect(gate(1050)).toBe(false)
    expect(gate(1100)).toBe(true)
  })

  it('120Hzの画面でも指定の頻度を保つ（端数で1コマずつ遅れていかない）', () => {
    expect(countDraws(createFrameGate(15), 1000 / 120, 10)).toBe(150)
  })

  it('60Hzの画面でも指定の頻度を保つ', () => {
    expect(countDraws(createFrameGate(15), 1000 / 60, 10)).toBe(150)
  })

  it('長く止まったあとも、遅れを取り戻そうと続けて描かない', () => {
    const gate = createFrameGate(10)

    expect(gate(0)).toBe(true)
    expect(gate(5000)).toBe(true)
    expect(gate(5010)).toBe(false)
  })

  it('0以下の頻度では描けないので投げる', () => {
    expect(() => createFrameGate(0)).toThrow('描画の頻度')
  })
})
