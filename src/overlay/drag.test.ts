/**
 * 配置用の枠でのドラッグの計算（src/overlay/drag.ts）のテスト
 *
 * 確かめたいのは次の4点である。
 * - 入力欄の文字（％）を数として読めること・読めない素材はドラッグさせないこと
 * - 枠の中で動かした画素を、枠の幅・高さに対する割合（％）へ直すこと
 * - 四角を動かす・端をつまんで大きさを変える計算（はみ出させない・つぶさない）
 * - 計算した結果を入力欄の文字へ戻すこと（数値欄にも同じ値が出る）
 */
import { describe, expect, it } from 'vitest'
import { deltaPercent, dragRect, rectNumbersOf, toRectDraft, type RectNumbers } from './drag'

/** 右下に置いた時計くらいの四角 */
const 時計の四角: RectNumbers = { x: 70, y: 60, width: 20, height: 30 }

describe('rectNumbersOf', () => {
  it('入力欄の文字を数にする', () => {
    expect(rectNumbersOf({ x: '70', y: '60', width: '20', height: '30' })).toEqual(時計の四角)
  })

  it('小数もそのまま読む', () => {
    expect(rectNumbersOf({ x: '12.5', y: '0', width: '33.3', height: '100' })).toEqual({ x: 12.5, y: 0, width: 33.3, height: 100 })
  })

  it('数として読めない値が1つでもあれば undefined にする（ドラッグさせず、数値欄で直してもらう）', () => {
    expect(rectNumbersOf({ x: '', y: '0', width: '20', height: '30' })).toBeUndefined()
    expect(rectNumbersOf({ x: '0', y: '0', width: 'ひろく', height: '30' })).toBeUndefined()
  })
})

describe('deltaPercent', () => {
  it('動かした画素を、枠の幅・高さに対する割合（％）にする', () => {
    expect(deltaPercent(40, -30, 400, 300)).toEqual({ dx: 10, dy: -10 })
  })

  it('枠の大きさが取れないときは動かさない（0で割らない）', () => {
    expect(deltaPercent(40, 30, 0, 0)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('dragRect（四角そのものを動かす）', () => {
  it('大きさを変えずに位置だけを動かす', () => {
    expect(dragRect(時計の四角, 'move', -10, 5)).toEqual({ x: 60, y: 65, width: 20, height: 30 })
  })

  it('オーバーレイの外へは出さない（左と上は0で止める）', () => {
    expect(dragRect(時計の四角, 'move', -100, -100)).toEqual({ x: 0, y: 0, width: 20, height: 30 })
  })

  it('オーバーレイの外へは出さない（右と下は、はみ出さない位置で止める）', () => {
    expect(dragRect(時計の四角, 'move', 100, 100)).toEqual({ x: 80, y: 70, width: 20, height: 30 })
  })
})

describe('dragRect（端をつまんで大きさを変える）', () => {
  it('右端をつまむと幅だけが変わる', () => {
    expect(dragRect(時計の四角, 'e', 5, 99)).toEqual({ x: 70, y: 60, width: 25, height: 30 })
  })

  it('下端をつまむと高さだけが変わる', () => {
    expect(dragRect(時計の四角, 's', 99, -10)).toEqual({ x: 70, y: 60, width: 20, height: 20 })
  })

  it('左端をつまむと、左端の位置と幅が同時に変わる（右端は動かない）', () => {
    expect(dragRect(時計の四角, 'w', -10, 0)).toEqual({ x: 60, y: 60, width: 30, height: 30 })
  })

  it('上端をつまむと、上端の位置と高さが同時に変わる（下端は動かない）', () => {
    expect(dragRect(時計の四角, 'n', 0, 10)).toEqual({ x: 70, y: 70, width: 20, height: 20 })
  })

  it('角をつまむと縦横が同時に変わる', () => {
    expect(dragRect(時計の四角, 'se', 10, 5)).toEqual({ x: 70, y: 60, width: 30, height: 35 })
  })

  it('1％より小さくはしない（見えない素材を作らない）', () => {
    expect(dragRect(時計の四角, 'e', -100, 0)).toEqual({ x: 70, y: 60, width: 1, height: 30 })
  })

  it('左端・上端をつまんでも、反対の端を追い越さない', () => {
    expect(dragRect(時計の四角, 'nw', 100, 100)).toEqual({ x: 89, y: 89, width: 1, height: 1 })
  })

  it('オーバーレイの外へは広げない', () => {
    expect(dragRect(時計の四角, 'se', 100, 100)).toEqual({ x: 70, y: 60, width: 30, height: 40 })
    expect(dragRect(時計の四角, 'nw', -100, -100)).toEqual({ x: 0, y: 0, width: 90, height: 90 })
  })

  it('画素の端数は0.1％まで丸める（入力欄に長い小数を残さない）', () => {
    expect(dragRect(時計の四角, 'move', 1.23456, -0.98765)).toEqual({ x: 71.2, y: 59, width: 20, height: 30 })
  })
})

describe('toRectDraft', () => {
  it('計算した四角を入力欄の文字に戻す', () => {
    expect(toRectDraft({ x: 60, y: 65.5, width: 20, height: 30 })).toEqual({ x: '60', y: '65.5', width: '20', height: '30' })
  })
})
