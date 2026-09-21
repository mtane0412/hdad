/**
 * 認可を待つ間の問い合わせの間隔（poll.ts）のテスト
 *
 * RFC 8628 では、Twitch から slow_down を受け取ったら、以降の問い合わせの間隔を5秒延ばすことが求められる。
 * 延ばさずに問い合わせ続けると、また slow_down を返されて認可がいつまでも済まない。
 */
import { describe, expect, it } from 'vitest'
import { nextIntervalSeconds } from './poll'

describe('nextIntervalSeconds', () => {
  it('まだ認可されていないだけなら、間隔を変えない', () => {
    expect(nextIntervalSeconds(5, { status: 'pending' })).toBe(5)
  })

  it('問い合わせが速すぎると言われたら、間隔を5秒延ばす', () => {
    expect(nextIntervalSeconds(5, { status: 'slow-down' })).toBe(10)
  })

  it('速すぎると繰り返し言われたら、そのたびに5秒ずつ延ばす', () => {
    const 一度目 = nextIntervalSeconds(5, { status: 'slow-down' })
    expect(nextIntervalSeconds(一度目, { status: 'slow-down' })).toBe(15)
  })

  it('接続できたら、間隔を変えない（もう問い合わせないため）', () => {
    const bot = { userId: '67890', login: 'haishinsha_bot', missingScopes: [], isModerator: true }
    expect(nextIntervalSeconds(5, { status: 'connected', bot })).toBe(5)
  })
})
