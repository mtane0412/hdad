/**
 * 消しゴムの当たり判定のテスト
 *
 * 消しゴムは触れた線を1本まるごと消す。ここでは「どの線に触れたか」の判定だけを確かめる。
 * 箱は幅1000・高さ500画素とし、消しゴムの半径は ERASER_RADIUS_RATIO × 1000 画素になる。
 */
import { describe, expect, it } from 'vitest'
import { ERASER_RADIUS_RATIO, touchedStrokeIds } from './erase'
import type { Point } from './stroke'
import type { Stroke, Strokes } from './strokes'

const box = { width: 1000, height: 500 }

/** 消しゴムの半径（画素） */
const radius = ERASER_RADIUS_RATIO * box.width

const stroke = (id: string, points: Point[], width = 'medium'): Stroke => ({ id, points, color: 'white', width })

const collection = (...strokes: Stroke[]): Strokes => ({ strokes })

/** 左右に引いた横線（高さは箱の真ん中） */
const horizontalLine = (id: string, width = 'medium'): Stroke =>
  stroke(
    id,
    [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ],
    width,
  )

/** 箱の真ん中から下へ、画素でずらした点 */
const centerToBottom = (pixel: number): Point => ({ x: 0.5, y: 0.5 + pixel / box.height })

describe('touchedStrokeIds', () => {
  it('消しゴムを線の上に置いたら、その線の名前を返す', () => {
    const point = { x: 0.5, y: 0.5 }

    expect(touchedStrokeIds(collection(horizontalLine('横線')), point, point, box)).toEqual(['横線'])
  })

  it('線から離れた場所では、何も返さない', () => {
    const point = centerToBottom(radius * 5)

    expect(touchedStrokeIds(collection(horizontalLine('横線')), point, point, box)).toEqual([])
  })

  it('線の太さのぶんも当たりとする', () => {
    // 太い線（幅20画素）なら縁まで10画素あるので、消しゴムの半径＋10画素の手前までは当たる
    const point = centerToBottom(radius + 8)

    expect(touchedStrokeIds(collection(horizontalLine('太い線', 'bold'), horizontalLine('細い線', 'thin')), point, point, box)).toEqual(['太い線'])
  })

  it('距離は画素で測る（縦と横の比の違いで当たりの広さが変わらない）', () => {
    // 高さ500画素の箱で縦に0.02ずれた点は10画素の距離なので当たる（幅の1000画素で測ると20画素になり外れる）
    const point = { x: 0.5, y: 0.52 }

    expect(touchedStrokeIds(collection(horizontalLine('横線')), point, point, box)).toEqual(['横線'])
  })

  it('素早く動かして、点と点のあいだで線をまたいでも当たる', () => {
    const verticalLine = stroke('縦線', [
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ])

    expect(touchedStrokeIds(collection(verticalLine), { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, box)).toEqual(['縦線'])
  })

  it('点を1つ打っただけの線にも当たる', () => {
    const pointOnly = stroke('点', [{ x: 0.5, y: 0.5 }])
    const eraser = { x: 0.505, y: 0.5 }

    expect(touchedStrokeIds(collection(pointOnly), eraser, eraser, box)).toEqual(['点'])
  })

  it('いくつもの線に触れたら、触れた線をすべて返す', () => {
    const upperStroke = stroke('上の線', [
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.2 },
    ])
    const lowerStroke = stroke('下の線', [
      { x: 0.1, y: 0.8 },
      { x: 0.9, y: 0.8 },
    ])
    const distantStroke = stroke('離れた線', [
      { x: 0.8, y: 0.1 },
      { x: 0.9, y: 0.1 },
    ])

    expect(touchedStrokeIds(collection(upperStroke, lowerStroke, distantStroke), { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }, box)).toEqual(['上の線', '下の線'])
  })
})
