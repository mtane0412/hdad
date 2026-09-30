/**
 * WebSocketへ配る共通の部分のテスト
 *
 * 確かめるのは、開いている接続すべてへ同じ文字列を送ること、1本が壊れていても残りへ配ること、
 * そして壊れた接続を閉じることである。
 */
import { describe, expect, it } from 'vitest'
import { broadcast, type SocketLike } from './socket-broadcast'

/** 送られた文字列を覚えておく、テスト用の接続 */
const createSocket = (): SocketLike & { sent: string[]; closeReasons: string[] } => {
  const sent: string[] = []
  const closeReasons: string[] = []
  return {
    sent,
    closeReasons,
    send: (message) => sent.push(message),
    close: (_code, reason) => closeReasons.push(reason ?? ''),
  }
}

/** 送ろうとすると必ず失敗する、テスト用の接続 */
const createBrokenSocket = (): SocketLike & { closeReasons: string[] } => {
  const closeReasons: string[] = []
  return {
    closeReasons,
    send: () => {
      throw new Error('この接続はもう使えません')
    },
    close: (_code, reason) => closeReasons.push(reason ?? ''),
  }
}

describe('broadcast', () => {
  it('開いている接続すべてへ同じ文字列を送る', () => {
    const socket1 = createSocket()
    const socket2 = createSocket()

    expect(broadcast([socket1, socket2], '{"text":"やあ"}', 'アラート')).toBe(2)

    expect(socket1.sent).toEqual(['{"text":"やあ"}'])
    expect(socket2.sent).toEqual(['{"text":"やあ"}'])
  })

  it('1本の接続が壊れていても、残りの接続へは送る', () => {
    const brokenSocket = createBrokenSocket()
    const aliveSocket = createSocket()

    expect(broadcast([brokenSocket, aliveSocket], '{"text":"やあ"}', 'アラート')).toBe(1)

    expect(aliveSocket.sent).toEqual(['{"text":"やあ"}'])
  })

  it('送れなかった接続は、呼び名を添えて閉じる', () => {
    const brokenSocket = createBrokenSocket()

    broadcast([brokenSocket], '{"type":"start"}', '手書きの線')

    expect(brokenSocket.closeReasons).toEqual(['手書きの線を配れませんでした'])
  })
})
