/**
 * WebSocketへ配る共通の部分のテスト
 *
 * 確かめるのは、開いている接続すべてへ同じ文字列を送ること、1本が壊れていても残りへ配ること、
 * そして壊れた接続を閉じることである。
 */
import { describe, expect, it } from 'vitest'
import { broadcast, type SocketLike } from './socket-broadcast'

/** 送られた文字列を覚えておく、テスト用の接続 */
const 接続を作る = (): SocketLike & { 送られたもの: string[]; 閉じた理由: string[] } => {
  const 送られたもの: string[] = []
  const 閉じた理由: string[] = []
  return {
    送られたもの,
    閉じた理由,
    send: (message) => 送られたもの.push(message),
    close: (_code, reason) => 閉じた理由.push(reason ?? ''),
  }
}

/** 送ろうとすると必ず失敗する、テスト用の接続 */
const 壊れた接続を作る = (): SocketLike & { 閉じた理由: string[] } => {
  const 閉じた理由: string[] = []
  return {
    閉じた理由,
    send: () => {
      throw new Error('この接続はもう使えません')
    },
    close: (_code, reason) => 閉じた理由.push(reason ?? ''),
  }
}

describe('broadcast', () => {
  it('開いている接続すべてへ同じ文字列を送る', () => {
    const 接続1 = 接続を作る()
    const 接続2 = 接続を作る()

    expect(broadcast([接続1, 接続2], '{"text":"やあ"}', 'アラート')).toBe(2)

    expect(接続1.送られたもの).toEqual(['{"text":"やあ"}'])
    expect(接続2.送られたもの).toEqual(['{"text":"やあ"}'])
  })

  it('1本の接続が壊れていても、残りの接続へは送る', () => {
    const 壊れた接続 = 壊れた接続を作る()
    const 生きている接続 = 接続を作る()

    expect(broadcast([壊れた接続, 生きている接続], '{"text":"やあ"}', 'アラート')).toBe(1)

    expect(生きている接続.送られたもの).toEqual(['{"text":"やあ"}'])
  })

  it('送れなかった接続は、呼び名を添えて閉じる', () => {
    const 壊れた接続 = 壊れた接続を作る()

    broadcast([壊れた接続], '{"type":"start"}', '手書きの線')

    expect(壊れた接続.閉じた理由).toEqual(['手書きの線を配れませんでした'])
  })
})
