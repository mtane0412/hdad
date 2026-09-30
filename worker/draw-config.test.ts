/**
 * 手書きの線の保存（draw-config.ts）のテスト
 *
 * 描く画面が引き終えた線をまとめて送ってくるので、Workerはそれを検証して保存する。確かめるのは次の4点である。
 * - 描いた線をそのまま保存し、同じ形で読み出せること
 * - 一度も保存していないときは、線が無い状態として読めること
 * - 選べない色や太さ・点の無い線を拒むこと（保存を通ったものは検証せずに読み出すため、ここで止める）
 * - 問題点を最初の1件で止めず、すべて集めてから拒むこと
 */
import { describe, expect, it } from 'vitest'
import { MAX_STROKES } from '../src/draw/strokes'
import { loadStrokes, parseStrokes, saveStrokes } from './draw-config'
import { createFakeStore } from './fake-store'

/** 配信画面の左上に引いた短い線 */
const drawnStrokes = { id: '線1', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], color: 'red', width: 'bold' }

/** 検証で見つかった問題点の一覧を取り出す */
const issues = (input: unknown): readonly string[] => {
  try {
    parseStrokes(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseStrokes', () => {
  it('引いた線をそのまま保存用の形にする', () => {
    expect(parseStrokes({ strokes: [drawnStrokes] })).toEqual([drawnStrokes])
  })

  it('線が無い状態（全消しの直後）を受け付ける', () => {
    expect(parseStrokes({ strokes: [] })).toEqual([])
  })

  it('余分な項目は保存しない', () => {
    // 保存したものは検証せずに読み出すので、送り主が足したものをそのまま抱え込まない
    expect(parseStrokes({ strokes: [{ ...drawnStrokes, extra: '持ち込まれたもの' }] })).toEqual([drawnStrokes])
  })

  it('オブジェクトでないものを拒む', () => {
    expect(issues('線1')).toEqual(['保存する内容はオブジェクトで指定してください'])
  })

  it('線の配列を持たないものを拒む', () => {
    expect(issues({})).toEqual(['strokes: 描いた線の配列で指定してください'])
  })

  it('選べない色の線を、何本目かを添えて拒む', () => {
    expect(issues({ strokes: [drawnStrokes, { ...drawnStrokes, id: '線2', color: 'magenta' }] })).toEqual([
      'strokes[1]: 線は名前・点の配列・選べる色と太さの名前を持つ形で指定してください',
    ])
  })

  it('問題点を最初の1件で止めずに集める', () => {
    expect(issues({ strokes: [{ ...drawnStrokes, color: 'magenta' }, { ...drawnStrokes, id: '線2', points: [] }] })).toHaveLength(2)
  })

  it('線が多すぎるものを拒む', () => {
    const tooManyStrokes = Array.from({ length: MAX_STROKES + 1 }, (_, index) => ({ ...drawnStrokes, id: `線${index}` }))

    expect(issues({ strokes: tooManyStrokes })).toEqual([`strokes: 描いた線は${MAX_STROKES}本までにしてください`])
  })
})

describe('saveStrokes と loadStrokes', () => {
  it('保存した線を同じ形で読み出せる', async () => {
    const store = createFakeStore()

    await saveStrokes(store, [drawnStrokes])

    expect(await loadStrokes(store)).toEqual([drawnStrokes])
  })

  it('一度も保存していなければ、線が無い状態として読める', async () => {
    expect(await loadStrokes(createFakeStore())).toEqual([])
  })

  it('全消しのあとの状態（線が無い）を保存できる', async () => {
    const store = createFakeStore()
    await saveStrokes(store, [drawnStrokes])

    await saveStrokes(store, [])

    expect(await loadStrokes(store)).toEqual([])
  })
})
