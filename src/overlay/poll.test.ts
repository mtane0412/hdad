/**
 * 段でひとつにまとめたポーリング（src/overlay/poll.ts）のテスト
 *
 * サイドスーパー（30秒）と注目コメント（10秒）を同じ段に置くと、素直に書けばタイマーが2本になる。
 * 1本のタイマーで回すために、刻みの長さと「この刻みで読むもの」を決める計算を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { dueTasks, pollTickMs } from './poll'

const 注目コメント = { intervalMs: 10000, name: 'focus' }
const サイドスーパー = { intervalMs: 30000, name: 'sideSuper' }

describe('pollTickMs', () => {
  it('いちばん短い間隔を刻みにする（どの読み出しも遅れないようにする）', () => {
    expect(pollTickMs([サイドスーパー, 注目コメント])).toBe(10000)
  })

  it('読むものが1つなら、その間隔がそのまま刻みになる', () => {
    expect(pollTickMs([サイドスーパー])).toBe(30000)
  })
})

describe('dueTasks', () => {
  it('刻みごとに、その回で読むものだけを返す', () => {
    const tasks = [注目コメント, サイドスーパー]
    const 刻み = pollTickMs(tasks)

    expect(dueTasks(tasks, 刻み, 1)).toEqual([注目コメント])
    expect(dueTasks(tasks, 刻み, 2)).toEqual([注目コメント])
    expect(dueTasks(tasks, 刻み, 3)).toEqual([注目コメント, サイドスーパー])
    expect(dueTasks(tasks, 刻み, 6)).toEqual([注目コメント, サイドスーパー])
  })

  it('刻みより短い間隔のものは、毎回読む（刻みを下回って読むことはできない）', () => {
    expect(dueTasks([{ intervalMs: 3000 }], 10000, 1)).toEqual([{ intervalMs: 3000 }])
  })
})
