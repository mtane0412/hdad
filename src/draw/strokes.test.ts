/**
 * 描かれた線の集まりのテスト
 *
 * 合成ページは、届いた1通ずつをこの形に積み上げ、毎フレームここから描き直す。
 * 積み上げ方が正しいこと、そして合成ページを途中で開いたときに起こることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { MAX_POINTS_PER_STROKE, MAX_STROKES, NO_STROKES, applyDrawMessage, isStroke } from './strokes'
import type { StrokeStart } from './stroke'

/** 色と太さを省いて書けるようにする（この検査の主題ではないため） */
const startDrawing = (id: string, x: number, y: number, color = 'white', width = 'medium'): StrokeStart => ({
  type: 'start',
  id,
  point: { x, y },
  color,
  width,
})

describe('applyDrawMessage', () => {
  it('描き始めで、点を1つ持つ線ができる', () => {
    const result = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    expect(result.strokes).toEqual([{ id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'white', width: 'medium' }])
  })

  it('続きで、同じ線の末尾に点が足される', () => {
    const afterStart = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    const result = applyDrawMessage(afterStart, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(result.strokes).toEqual([
      {
        id: '線1',
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
        color: 'white',
        width: 'medium',
      },
    ])
  })

  it('別の名前の線は、別の線として並ぶ', () => {
    const firstStroke = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    const result = applyDrawMessage(firstStroke, startDrawing('線2', 0.5, 0.6))

    expect(result.strokes.map(({ id }) => id)).toEqual(['線1', '線2'])
  })

  it('描き始めを受け取っていない線の続きは、捨てる', () => {
    // 合成ページを線の途中で開くと起こる。描き始めが分からない線は描きようがないので、次の線から描く
    const result = applyDrawMessage(NO_STROKES, { type: 'extend', id: '見ていない線', points: [{ x: 0.3, y: 0.4 }] })

    expect(result.strokes).toEqual([])
  })

  it('同じ名前で描き始めが来たら、その線を引き直す', () => {
    // 描く画面がつなぎ直したあと、同じ名前を振り直すことがありうる。古い点が残ると線がつながって見える
    const afterStart = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    const result = applyDrawMessage(afterStart, startDrawing('線1', 0.8, 0.9))

    expect(result.strokes).toEqual([{ id: '線1', points: [{ x: 0.8, y: 0.9 }], color: 'white', width: 'medium' }])
  })

  it('線が上限を超えたら、古いものから落とす', () => {
    let accumulated = NO_STROKES
    for (let index = 0; index <= MAX_STROKES; index += 1) {
      accumulated = applyDrawMessage(accumulated, startDrawing(`線${index}`, 0.1, 0.1))
    }

    expect(accumulated.strokes).toHaveLength(MAX_STROKES)
    expect(accumulated.strokes.map(({ id }) => id)[0]).toBe('線1')
  })

  it('線ごとに、選ばれた色と太さを覚えておく', () => {
    const thickRedStroke = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2, 'red', 'bold'))

    const result = applyDrawMessage(thickRedStroke, startDrawing('線2', 0.5, 0.6, 'blue', 'thin'))

    expect(result.strokes.map(({ color, width }) => `${color}/${width}`)).toEqual(['red/bold', 'blue/thin'])
  })

  it('線を消すと、その1本だけがなくなる', () => {
    const twoStrokes = applyDrawMessage(applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2)), startDrawing('線2', 0.5, 0.6))

    const result = applyDrawMessage(twoStrokes, { type: 'erase', id: '線1' })

    expect(result.strokes.map(({ id }) => id)).toEqual(['線2'])
  })

  it('無い線を消そうとしても、何も変わらない', () => {
    // 合成ページを途中で開き、描き始めを受け取っていない線が消されたときに起こる
    const oneStroke = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    const result = applyDrawMessage(oneStroke, { type: 'erase', id: '知らない線' })

    expect(result).toBe(oneStroke)
  })

  it('全消しで、線がすべて消える', () => {
    const afterStart = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    const result = applyDrawMessage(afterStart, { type: 'clear' })

    expect(result.strokes).toEqual([])
  })

  it('全消しのあとに描いた線は、前の線とつながらない', () => {
    // 同じ名前の線が消えたあとに続きが届いても、描き始めから引き直す
    const afterErase = applyDrawMessage(applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2)), { type: 'clear' })

    const result = applyDrawMessage(afterErase, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(result.strokes).toEqual([])
  })

  it('元の集まりは書き換えない', () => {
    const afterStart = applyDrawMessage(NO_STROKES, startDrawing('線1', 0.1, 0.2))

    applyDrawMessage(afterStart, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(afterStart.strokes.map(({ points }) => points.length)).toEqual([1])
  })
})

describe('isStroke', () => {
  /** 保存から読み出した1本ぶんの形（点の配列・色・太さの名前を持つ） */
  const savedStroke = { id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }

  it('保存から読み出した形の1本を受け入れる', () => {
    expect(isStroke(savedStroke)).toBe(true)
  })

  it('選べない色の名前を拒む', () => {
    // 既定に戻して描くと、配信画面に意図しない色の線が出たまま原因に気付けない
    expect(isStroke({ ...savedStroke, color: 'magenta' })).toBe(false)
  })

  it('選べない太さの名前を拒む', () => {
    expect(isStroke({ ...savedStroke, width: 'ものすごく太い' })).toBe(false)
  })

  it('点を1つも持たない線を拒む', () => {
    expect(isStroke({ ...savedStroke, points: [] })).toBe(false)
  })

  it('点が多すぎる線を拒む', () => {
    const tooManyPoints = Array.from({ length: MAX_POINTS_PER_STROKE + 1 }, () => ({ x: 0.5, y: 0.5 }))

    expect(isStroke({ ...savedStroke, points: tooManyPoints })).toBe(false)
  })

  it('座標が数でない点を持つ線を拒む', () => {
    expect(isStroke({ ...savedStroke, points: [{ x: '0.1', y: 0.2 }] })).toBe(false)
  })

  it('名前が空の線を拒む', () => {
    expect(isStroke({ ...savedStroke, id: '' })).toBe(false)
  })

  it('線でないものを拒む', () => {
    expect(isStroke(null)).toBe(false)
    expect(isStroke('線1')).toBe(false)
  })
})
