/**
 * canvas の縁取り文字（src/core/outlined-text.ts）のテスト
 *
 * 配信の背景は明るいことも暗いことも柄があることもあるので、直置きの文字は「縁を描いてから塗る」。
 * ここでは、canvas に対して行った描画（縁の太さ・角の形・描く順番）と、
 * 呼び出し側の描画の状態を汚さないことを、描画の命令を記録する偽物の canvas で確かめる。
 */
import { describe, expect, it } from 'vitest'
import { drawOutlinedText, OUTLINE_RATIO } from './outlined-text'

/** strokeText・fillText を呼んだ時点の状態を記録する、偽物の 2D コンテキスト */
const recordingContext = () => {
  const calls: { kind: 'stroke' | 'fill'; text: string; x: number; y: number; style: string; lineWidth: number; lineJoin: string }[] = []
  const saved: { lineWidth: number; lineJoin: string; strokeStyle: string; fillStyle: string }[] = []
  const ctx = {
    lineWidth: 1,
    lineJoin: 'miter',
    strokeStyle: '#123456',
    fillStyle: '#654321',
    save() {
      saved.push({ lineWidth: this.lineWidth, lineJoin: this.lineJoin, strokeStyle: this.strokeStyle, fillStyle: this.fillStyle })
    },
    restore() {
      const state = saved.pop()
      if (state === undefined) throw new Error('save していないのに restore した')
      Object.assign(this, state)
    },
    strokeText(text: string, x: number, y: number) {
      calls.push({ kind: 'stroke', text, x, y, style: this.strokeStyle, lineWidth: this.lineWidth, lineJoin: this.lineJoin })
    },
    fillText(text: string, x: number, y: number) {
      calls.push({ kind: 'fill', text, x, y, style: this.fillStyle, lineWidth: this.lineWidth, lineJoin: this.lineJoin })
    },
  }
  return { ctx, calls }
}

describe('drawOutlinedText', () => {
  it('縁を先に描いてから同じ位置に塗る（塗りが縁に削られない）', () => {
    const { ctx, calls } = recordingContext()

    drawOutlinedText(ctx as unknown as CanvasRenderingContext2D, '山田さんをペロペロ', 100, 50, { fontSize: 72, fill: '#ffffff', outline: '#000000' })

    expect(calls.map((call) => [call.kind, call.text, call.x, call.y, call.style])).toEqual([
      ['stroke', '山田さんをペロペロ', 100, 50, '#000000'],
      ['fill', '山田さんをペロペロ', 100, 50, '#ffffff'],
    ])
  })

  it('外に見える縁の幅が文字の大きさの OUTLINE_RATIO 倍になるよう、線はその2倍の太さで引く', () => {
    // 前提: strokeText の線は輪郭の内と外に半分ずつ乗り、内側の半分は後から塗る文字に隠れる
    const { ctx, calls } = recordingContext()

    drawOutlinedText(ctx as unknown as CanvasRenderingContext2D, '時間切れ！', 0, 0, { fontSize: 100, fill: '#ff4d4d', outline: '#000000' })

    expect(calls[0]?.lineWidth).toBeCloseTo(100 * OUTLINE_RATIO * 2)
  })

  it('縁の角は丸める（太い縁でも尖った角が飛び出さない）', () => {
    const { ctx, calls } = recordingContext()

    drawOutlinedText(ctx as unknown as CanvasRenderingContext2D, '驚', 0, 0, { fontSize: 300, fill: '#ffcf40', outline: '#000000' })

    expect(calls[0]?.lineJoin).toBe('round')
  })

  it('描き終えたら、線の太さ・角・色を呼ぶ前の状態に戻す', () => {
    const { ctx } = recordingContext()

    drawOutlinedText(ctx as unknown as CanvasRenderingContext2D, '10', 0, 0, { fontSize: 260, fill: '#ff4d4d', outline: '#000000' })

    expect({ lineWidth: ctx.lineWidth, lineJoin: ctx.lineJoin, strokeStyle: ctx.strokeStyle, fillStyle: ctx.fillStyle }).toEqual({
      lineWidth: 1,
      lineJoin: 'miter',
      strokeStyle: '#123456',
      fillStyle: '#654321',
    })
  })
})
