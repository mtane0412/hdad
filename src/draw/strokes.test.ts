/**
 * 描かれた線の集まりのテスト
 *
 * 合成ページは、届いた1通ずつをこの形に積み上げ、毎フレームここから描き直す。
 * 積み上げ方が正しいこと、そして合成ページを途中で開いたときに起こることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { NO_STROKES, MAX_STROKES, applyDrawMessage } from './strokes'
import type { StrokeStart } from './stroke'

/** 色と太さを省いて書けるようにする（この検査の主題ではないため） */
const 描き始め = (id: string, x: number, y: number, color = 'white', width = 'medium'): StrokeStart => ({
  type: 'start',
  id,
  point: { x, y },
  color,
  width,
})

describe('applyDrawMessage', () => {
  it('描き始めで、点を1つ持つ線ができる', () => {
    const 結果 = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    expect(結果.strokes).toEqual([{ id: '線1', points: [{ x: 0.1, y: 0.2 }], color: 'white', width: 'medium' }])
  })

  it('続きで、同じ線の末尾に点が足される', () => {
    const 描き始めたあと = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    const 結果 = applyDrawMessage(描き始めたあと, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(結果.strokes).toEqual([
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
    const 一本目 = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    const 結果 = applyDrawMessage(一本目, 描き始め('線2', 0.5, 0.6))

    expect(結果.strokes.map(({ id }) => id)).toEqual(['線1', '線2'])
  })

  it('描き始めを受け取っていない線の続きは、捨てる', () => {
    // 合成ページを線の途中で開くと起こる。描き始めが分からない線は描きようがないので、次の線から描く
    const 結果 = applyDrawMessage(NO_STROKES, { type: 'extend', id: '見ていない線', points: [{ x: 0.3, y: 0.4 }] })

    expect(結果.strokes).toEqual([])
  })

  it('同じ名前で描き始めが来たら、その線を引き直す', () => {
    // 描く画面がつなぎ直したあと、同じ名前を振り直すことがありうる。古い点が残ると線がつながって見える
    const 描き始めたあと = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    const 結果 = applyDrawMessage(描き始めたあと, 描き始め('線1', 0.8, 0.9))

    expect(結果.strokes).toEqual([{ id: '線1', points: [{ x: 0.8, y: 0.9 }], color: 'white', width: 'medium' }])
  })

  it('線が上限を超えたら、古いものから落とす', () => {
    let 積み上げたもの = NO_STROKES
    for (let 番号 = 0; 番号 <= MAX_STROKES; 番号 += 1) {
      積み上げたもの = applyDrawMessage(積み上げたもの, 描き始め(`線${番号}`, 0.1, 0.1))
    }

    expect(積み上げたもの.strokes).toHaveLength(MAX_STROKES)
    expect(積み上げたもの.strokes.map(({ id }) => id)[0]).toBe('線1')
  })

  it('線ごとに、選ばれた色と太さを覚えておく', () => {
    const 赤い太線 = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2, 'red', 'bold'))

    const 結果 = applyDrawMessage(赤い太線, 描き始め('線2', 0.5, 0.6, 'blue', 'thin'))

    expect(結果.strokes.map(({ color, width }) => `${color}/${width}`)).toEqual(['red/bold', 'blue/thin'])
  })

  it('全消しで、線がすべて消える', () => {
    const 描き始めたあと = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    const 結果 = applyDrawMessage(描き始めたあと, { type: 'clear' })

    expect(結果.strokes).toEqual([])
  })

  it('全消しのあとに描いた線は、前の線とつながらない', () => {
    // 同じ名前の線が消えたあとに続きが届いても、描き始めから引き直す
    const 消したあと = applyDrawMessage(applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2)), { type: 'clear' })

    const 結果 = applyDrawMessage(消したあと, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(結果.strokes).toEqual([])
  })

  it('元の集まりは書き換えない', () => {
    const 描き始めたあと = applyDrawMessage(NO_STROKES, 描き始め('線1', 0.1, 0.2))

    applyDrawMessage(描き始めたあと, { type: 'extend', id: '線1', points: [{ x: 0.3, y: 0.4 }] })

    expect(描き始めたあと.strokes.map(({ points }) => points.length)).toEqual([1])
  })
})
