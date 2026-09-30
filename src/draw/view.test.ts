/**
 * 手書きの線の描画のテスト
 *
 * canvas への描画命令を覚えておく偽物を渡し、線が意図した形で描かれることを確かめる。
 * 確かめるのは、比で持っている座標が画素に直ること、点をつないで線になること、
 * そして点を1つ打っただけでも何か残ることである。
 */
import { describe, expect, it } from 'vitest'
import { colorOf, widthOf } from './tools'
import { drawStrokes, type StrokeContext } from './view'

/** 受け取った描画命令を順に覚えておく、テスト用の描画先 */
const createFakeRenderTarget = (): StrokeContext & { command: string[] } => {
  const command: string[] = []
  return {
    command,
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    clearRect: (x, y, boxWidth, height) => command.push(`clearRect(${x},${y},${boxWidth},${height})`),
    beginPath: () => command.push('beginPath'),
    moveTo: (x, y) => command.push(`moveTo(${x},${y})`),
    lineTo: (x, y) => command.push(`lineTo(${x},${y})`),
    stroke: () => command.push('stroke'),
    arc: (x, y, radius) => command.push(`arc(${x},${y},${radius})`),
    fill: () => command.push('fill'),
  }
}

const size = { width: 400, height: 200 }

/** 色と太さを省いて書けるようにする */
const stroke = (id: string, points: { x: number; y: number }[], color = 'white', width = 'medium') => ({ id, points, color, width })

describe('drawStrokes', () => {
  it('描く前に、前のフレームを消す', () => {
    // 線は毎フレーム描き直すので、消さないと消した線が残り続ける
    const renderTarget = createFakeRenderTarget()

    drawStrokes(renderTarget, { strokes: [] }, size)

    expect(renderTarget.command).toEqual(['clearRect(0,0,400,200)'])
  })

  it('比で持っている座標を、canvas の画素に直して結ぶ', () => {
    const renderTarget = createFakeRenderTarget()
    const diagonalStroke = stroke('線1', [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 1 },
    ])

    drawStrokes(renderTarget, { strokes: [diagonalStroke] }, size)

    // 縁取りを描いてから、その上に本来の色で描く（明るい画面でも暗い画面でも沈まないようにする）
    expect(renderTarget.command).toEqual([
      'clearRect(0,0,400,200)',
      'beginPath',
      'moveTo(100,100)',
      'lineTo(300,200)',
      'stroke',
      'beginPath',
      'moveTo(100,100)',
      'lineTo(300,200)',
      'stroke',
    ])
  })

  it('点が1つだけの線は、丸を置く', () => {
    // 画面を1回つついただけのときに何も残らないと、押したのに出ないと思われる
    const renderTarget = createFakeRenderTarget()
    const point = stroke('線1', [{ x: 0.5, y: 0.5 }])

    drawStrokes(renderTarget, { strokes: [point] }, size)

    // 縁取りの丸は、線そのものの丸より大きくないと縁が見えない
    expect(renderTarget.command).toEqual(['clearRect(0,0,400,200)', 'beginPath', 'arc(200,100,3)', 'fill', 'beginPath', 'arc(200,100,2)', 'fill'])
  })

  it('線が何本あっても、すべて描く', () => {
    const renderTarget = createFakeRenderTarget()
    const twoStrokes = [stroke('線1', [{ x: 0, y: 0 }]), stroke('線2', [{ x: 1, y: 1 }])]

    drawStrokes(renderTarget, { strokes: twoStrokes }, size)

    expect(renderTarget.command.filter((command) => command.startsWith('arc'))).toEqual(['arc(0,0,3)', 'arc(0,0,2)', 'arc(400,200,3)', 'arc(400,200,2)'])
  })

  it('線の太さは、箱の幅に対する比で決まる', () => {
    // 載せる箱の大きさが変わっても、見え方が保たれるようにする
    const renderTarget = createFakeRenderTarget()

    drawStrokes(renderTarget, { strokes: [stroke('線1', [{ x: 0.5, y: 0.5 }], 'white', 'medium')] }, { width: 800, height: 400 })

    expect(renderTarget.lineWidth).toBe(8)
  })

  it('線ごとに、選ばれた色と太さで描く', () => {
    const renderTarget = createFakeRenderTarget()

    drawStrokes(renderTarget, { strokes: [stroke('線1', [{ x: 0.5, y: 0.5 }], 'red', 'bold')] }, { width: 800, height: 400 })

    expect(renderTarget.strokeStyle).toBe(colorOf('red').value)
    expect(renderTarget.lineWidth).toBe(800 * widthOf('bold').ratio)
  })

  it('縁取りは、線そのものより太く描く', () => {
    // 細い線でも縁が見えるように、外側へ広げたぶんだけ太くする
    const renderTarget = createFakeRenderTarget()
    const widthLog: number[] = []
    const loggingRenderTarget = {
      ...renderTarget,
      set lineWidth(value: number) {
        widthLog.push(value)
      },
      get lineWidth() {
        return widthLog[widthLog.length - 1] ?? 0
      },
    }

    drawStrokes(loggingRenderTarget, { strokes: [stroke('線1', [{ x: 0.5, y: 0.5 }], 'red', 'medium')] }, { width: 800, height: 400 })

    expect(widthLog[0]).toBeGreaterThan(8)
    expect(widthLog[widthLog.length - 1]).toBe(8)
  })

  it('選べない色の線は、黙って既定の色で描かずにエラーにする', () => {
    const renderTarget = createFakeRenderTarget()

    expect(() => drawStrokes(renderTarget, { strokes: [stroke('線1', [{ x: 0.5, y: 0.5 }], '虹色')] }, size)).toThrow('手書きの色「虹色」は選べません')
  })
})
