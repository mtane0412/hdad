/**
 * 段でひとつにまとめたポーリング（src/overlay/poll.ts）のテスト
 *
 * サイドスーパー（30秒）と注目コメント（10秒）を同じ段に置くと、素直に書けばタイマーが2本になる。
 * 1本のタイマーで回すために、刻みの長さと「この刻みで読むもの」を決める計算を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { dueTasks, pollTickMs } from './poll'

const focusComment = { intervalMs: 10000, name: 'focus' }
const sideSuper = { intervalMs: 30000, name: 'sideSuper' }

describe('pollTickMs', () => {
  it('いちばん短い間隔を刻みにする（どの読み出しも遅れないようにする）', () => {
    expect(pollTickMs([sideSuper, focusComment])).toBe(10000)
  })

  it('読むものが1つなら、その間隔がそのまま刻みになる', () => {
    expect(pollTickMs([sideSuper])).toBe(30000)
  })
})

describe('dueTasks', () => {
  it('刻みごとに、その回で読むものだけを返す', () => {
    const tasks = [focusComment, sideSuper]
    const tick = pollTickMs(tasks)

    expect(dueTasks(tasks, tick, 1)).toEqual([focusComment])
    expect(dueTasks(tasks, tick, 2)).toEqual([focusComment])
    expect(dueTasks(tasks, tick, 3)).toEqual([focusComment, sideSuper])
    expect(dueTasks(tasks, tick, 6)).toEqual([focusComment, sideSuper])
  })

  it('刻みより短い間隔のものは、毎回読む（刻みを下回って読むことはできない）', () => {
    expect(dueTasks([{ intervalMs: 3000 }], 10000, 1)).toEqual([{ intervalMs: 3000 }])
  })
})
