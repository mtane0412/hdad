/**
 * 手書きの線の描画のテスト
 *
 * canvas への描画命令を覚えておく偽物を渡し、線が意図した形で描かれることを確かめる。
 * 確かめるのは、比で持っている座標が画素に直ること、点をつないで線になること、
 * そして点を1つ打っただけでも何か残ることである。
 */
import { describe, expect, it } from 'vitest'
import { drawStrokes, type StrokeContext } from './view'

/** 受け取った描画命令を順に覚えておく、テスト用の描画先 */
const 偽の描画先を作る = (): StrokeContext & { 命令: string[] } => {
  const 命令: string[] = []
  return {
    命令,
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    clearRect: (x, y, 幅, 高さ) => 命令.push(`clearRect(${x},${y},${幅},${高さ})`),
    beginPath: () => 命令.push('beginPath'),
    moveTo: (x, y) => 命令.push(`moveTo(${x},${y})`),
    lineTo: (x, y) => 命令.push(`lineTo(${x},${y})`),
    stroke: () => 命令.push('stroke'),
    arc: (x, y, 半径) => 命令.push(`arc(${x},${y},${半径})`),
    fill: () => 命令.push('fill'),
  }
}

const 大きさ = { width: 400, height: 200 }

describe('drawStrokes', () => {
  it('描く前に、前のフレームを消す', () => {
    // 線は毎フレーム描き直すので、消さないと消した線が残り続ける
    const 描画先 = 偽の描画先を作る()

    drawStrokes(描画先, { strokes: [] }, 大きさ)

    expect(描画先.命令).toEqual(['clearRect(0,0,400,200)'])
  })

  it('比で持っている座標を、canvas の画素に直して結ぶ', () => {
    const 描画先 = 偽の描画先を作る()
    const 斜めの線 = {
      id: '線1',
      points: [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 1 },
      ],
    }

    drawStrokes(描画先, { strokes: [斜めの線] }, 大きさ)

    expect(描画先.命令).toEqual(['clearRect(0,0,400,200)', 'beginPath', 'moveTo(100,100)', 'lineTo(300,200)', 'stroke'])
  })

  it('点が1つだけの線は、丸を置く', () => {
    // 画面を1回つついただけのときに何も残らないと、押したのに出ないと思われる
    const 描画先 = 偽の描画先を作る()
    const 点 = { id: '線1', points: [{ x: 0.5, y: 0.5 }] }

    drawStrokes(描画先, { strokes: [点] }, 大きさ)

    expect(描画先.命令).toEqual(['clearRect(0,0,400,200)', 'beginPath', 'arc(200,100,2)', 'fill'])
  })

  it('線が何本あっても、すべて描く', () => {
    const 描画先 = 偽の描画先を作る()
    const 二本 = [
      { id: '線1', points: [{ x: 0, y: 0 }] },
      { id: '線2', points: [{ x: 1, y: 1 }] },
    ]

    drawStrokes(描画先, { strokes: 二本 }, 大きさ)

    expect(描画先.命令.filter((命令) => 命令.startsWith('arc'))).toEqual(['arc(0,0,2)', 'arc(400,200,2)'])
  })

  it('線の太さは、箱の幅に対する比で決まる', () => {
    // 載せる箱の大きさが変わっても、見え方が保たれるようにする
    const 描画先 = 偽の描画先を作る()

    drawStrokes(描画先, { strokes: [{ id: '線1', points: [{ x: 0.5, y: 0.5 }] }] }, { width: 800, height: 400 })

    expect(描画先.lineWidth).toBe(8)
  })
})
