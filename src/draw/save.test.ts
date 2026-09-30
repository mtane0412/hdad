/**
 * 描いたものの保存の間引き（save.ts）のテスト
 *
 * KVは書き込みが他の拠点へ届くまで時間がかかるうえ、描いている最中の点ひとつごとには書けない。
 * そこで書くのは線を1本引き終えた時点とし、そこから数秒まとめてから書く。確かめるのは次の4点である。
 * - 引き終えてすぐには書かず、数秒待ってから最後の状態だけを書くこと
 * - 全消しは待たずにすぐ書くこと（残っていると困る向きの操作なので遅らせない）
 * - 前の書き込みが終わるまで次の書き込みを始めないこと（順番が入れ替わると古い状態が残る）
 * - 書き込みの失敗を知らせること（黙って落とすと、残っていないことに気付けない）
 * - 画面を離れるときに、待っている書き込みを書き切ること（捨てると、最後に引いた線が残らない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVE_DELAY_MS, createStrokeSaver } from './save'
import type { Strokes } from './strokes'

/** 引いた線1本ぶんの集まり */
const singleStroke = (id: string): Strokes => ({ strokes: [{ id, points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }] })

const emptyDrawing: Strokes = { strokes: [] }

/** 書き込みを記録する、テスト用の保存先。応答を保留できるようにしてある */
const createSaveTarget = () => {
  const written: Strokes[] = []
  const pending: (() => void)[] = []
  let hold = false
  const save = async (strokes: Strokes): Promise<void> => {
    written.push(strokes)
    if (!hold) return
    await new Promise<void>((resolve) => pending.push(resolve))
  }
  return {
    written,
    save,
    startHolding: () => {
      hold = true
    },
    releaseHold: () => pending.shift()?.(),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStrokeSaver', () => {
  it('引き終えてすぐには書かない', () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))

    expect(saveTarget.written).toEqual([])
  })

  it('数秒待ってから書く', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(saveTarget.written).toEqual([singleStroke('線1')])
  })

  it('待っているあいだに続けて引き終えたら、最後の状態だけを1度書く', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 2)
    saver.finished(singleStroke('線2'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(saveTarget.written).toEqual([singleStroke('線2')])
  })

  it('全消しは待たずにすぐ書く', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.saveNow(emptyDrawing)
    // 前の書き込みの完了を待ってから始めるので、待つのは1回ぶんの間だけ（時間は進めない）
    await vi.advanceTimersByTimeAsync(0)

    expect(saveTarget.written).toEqual([emptyDrawing])
  })

  it('全消しは、待っている書き込みを取り消して置き換える', async () => {
    // 消したあとに、待たせていた「線がある状態」を書いてしまうと、消した図が戻ってくる
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    saver.saveNow(emptyDrawing)
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(saveTarget.written).toEqual([emptyDrawing])
  })

  it('前の書き込みが終わるまで、次の書き込みを始めない', async () => {
    const saveTarget = createSaveTarget()
    saveTarget.startHolding()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.saveNow(singleStroke('線1'))
    saver.saveNow(emptyDrawing)
    await vi.advanceTimersByTimeAsync(0)

    expect(saveTarget.written).toEqual([singleStroke('線1')])

    saveTarget.releaseHold()
    await vi.advanceTimersByTimeAsync(0)

    expect(saveTarget.written).toEqual([singleStroke('線1'), emptyDrawing])
  })

  it('書き込みの失敗を、理由を添えて知らせる', async () => {
    const notice: string[] = []
    const saver = createStrokeSaver({
      save: async () => {
        throw new Error('ログインが切れています')
      },
      onFailure: (message) => notice.push(message),
    })

    saver.saveNow(singleStroke('線1'))
    await vi.advanceTimersByTimeAsync(0)

    expect(notice).toEqual(['ログインが切れています'])
  })

  it('待っている書き込みを、待たずに書き切れる', async () => {
    // 画面を離れるときに捨てると、最後に引いた数本が残らない
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    saver.flush()
    await vi.advanceTimersByTimeAsync(0)

    expect(saveTarget.written).toEqual([singleStroke('線1')])
  })

  it('待っている書き込みが無ければ、書き切っても何も書かない', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.flush()
    await vi.advanceTimersByTimeAsync(0)

    expect(saveTarget.written).toEqual([])
  })

  it('書き切ったあとは、待っていた書き込みを二度書かない', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    saver.flush()
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(saveTarget.written).toEqual([singleStroke('線1')])
  })

  it('待っている書き込みをやめられる', async () => {
    const saveTarget = createSaveTarget()
    const saver = createStrokeSaver({ save: saveTarget.save, onFailure: () => {} })

    saver.finished(singleStroke('線1'))
    saver.cancel()
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(saveTarget.written).toEqual([])
  })
})
