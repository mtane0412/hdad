/**
 * 描いたものの保存の間引き（save.ts）のテスト
 *
 * KVは書き込みが他の拠点へ届くまで時間がかかるうえ、描いている最中の点ひとつごとには書けない。
 * そこで書くのは線を1本引き終えた時点とし、そこから数秒まとめてから書く。確かめるのは次の4点である。
 * - 引き終えてすぐには書かず、数秒待ってから最後の状態だけを書くこと
 * - 全消しは待たずにすぐ書くこと（残っていると困る向きの操作なので遅らせない）
 * - 前の書き込みが終わるまで次の書き込みを始めないこと（順番が入れ替わると古い状態が残る）
 * - 書き込みの失敗を知らせること（黙って落とすと、残っていないことに気付けない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAVE_DELAY_MS, createStrokeSaver } from './save'
import type { Strokes } from './strokes'

/** 引いた線1本ぶんの集まり */
const 線1本 = (id: string): Strokes => ({ strokes: [{ id, points: [{ x: 0.1, y: 0.2 }], color: 'red', width: 'bold' }] })

const 何も描いていない: Strokes = { strokes: [] }

/** 書き込みを記録する、テスト用の保存先。応答を保留できるようにしてある */
const 保存先を作る = () => {
  const 書かれたもの: Strokes[] = []
  const 保留: (() => void)[] = []
  let 保留する = false
  const save = async (strokes: Strokes): Promise<void> => {
    書かれたもの.push(strokes)
    if (!保留する) return
    await new Promise<void>((resolve) => 保留.push(resolve))
  }
  return {
    書かれたもの,
    save,
    保留を始める: () => {
      保留する = true
    },
    保留を解く: () => 保留.shift()?.(),
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStrokeSaver', () => {
  it('引き終えてすぐには書かない', () => {
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.finished(線1本('線1'))

    expect(保存先.書かれたもの).toEqual([])
  })

  it('数秒待ってから書く', async () => {
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.finished(線1本('線1'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(保存先.書かれたもの).toEqual([線1本('線1')])
  })

  it('待っているあいだに続けて引き終えたら、最後の状態だけを1度書く', async () => {
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.finished(線1本('線1'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS / 2)
    saver.finished(線1本('線2'))
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(保存先.書かれたもの).toEqual([線1本('線2')])
  })

  it('全消しは待たずにすぐ書く', async () => {
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.saveNow(何も描いていない)
    // 前の書き込みの完了を待ってから始めるので、待つのは1回ぶんの間だけ（時間は進めない）
    await vi.advanceTimersByTimeAsync(0)

    expect(保存先.書かれたもの).toEqual([何も描いていない])
  })

  it('全消しは、待っている書き込みを取り消して置き換える', async () => {
    // 消したあとに、待たせていた「線がある状態」を書いてしまうと、消した図が戻ってくる
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.finished(線1本('線1'))
    saver.saveNow(何も描いていない)
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(保存先.書かれたもの).toEqual([何も描いていない])
  })

  it('前の書き込みが終わるまで、次の書き込みを始めない', async () => {
    const 保存先 = 保存先を作る()
    保存先.保留を始める()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.saveNow(線1本('線1'))
    saver.saveNow(何も描いていない)
    await vi.advanceTimersByTimeAsync(0)

    expect(保存先.書かれたもの).toEqual([線1本('線1')])

    保存先.保留を解く()
    await vi.advanceTimersByTimeAsync(0)

    expect(保存先.書かれたもの).toEqual([線1本('線1'), 何も描いていない])
  })

  it('書き込みの失敗を、理由を添えて知らせる', async () => {
    const 知らせ: string[] = []
    const saver = createStrokeSaver({
      save: async () => {
        throw new Error('ログインが切れています')
      },
      onFailure: (message) => 知らせ.push(message),
    })

    saver.saveNow(線1本('線1'))
    await vi.advanceTimersByTimeAsync(0)

    expect(知らせ).toEqual(['ログインが切れています'])
  })

  it('画面を離れたら、待っている書き込みをやめる', async () => {
    const 保存先 = 保存先を作る()
    const saver = createStrokeSaver({ save: 保存先.save, onFailure: () => {} })

    saver.finished(線1本('線1'))
    saver.cancel()
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS)

    expect(保存先.書かれたもの).toEqual([])
  })
})
