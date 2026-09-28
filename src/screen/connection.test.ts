/**
 * OBS（obs-websocket）への接続（src/screen/connection.ts）のテスト
 *
 * WebSocket を差し替えて確かめる。特に重要なのは次の4点である。
 * - 認証を求められたら応答を返し、求められなければ名乗るだけで済ませること
 * - 名乗りが通る（Identified）まで、つながったことにしないこと
 * - 要求と応答を requestId で結び付けること（撮影と場面の問い合わせが入れ違わないため）
 * - つながらないまま閉じたときに、待っている呼び出しを失敗させること（黙って待ち続けない）
 * - 名乗りへの答えが返ってこないまま時間が過ぎたら、待ち続けずに失敗させること
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_TIMEOUT_MS, connectObs, type ObsSocketLike } from './connection'
import { authenticationOf } from './protocol'

/** 押し込まれた文字列を覚える、テスト用の WebSocket */
const 作る偽のソケット = () => {
  const 送ったもの: Record<string, unknown>[] = []
  /** 受け手の形はイベントごとに違うので、まとめて持つためにここだけ緩く扱う */
  const 受け手 = new Map<string, ((event: never) => void)[]>()
  let 閉じた = false

  const socket: ObsSocketLike = {
    send: (data) => 送ったもの.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {
      閉じた = true
    },
    addEventListener: (type, listener) => {
      受け手.set(type, [...(受け手.get(type) ?? []), listener as (event: never) => void])
    },
  }

  const 起こす = (type: string, event: unknown = {}): void => {
    for (const listener of 受け手.get(type) ?? []) (listener as (event: unknown) => void)(event)
  }

  return {
    socket,
    送ったもの,
    閉じた: () => 閉じた,
    開く: () => 起こす('open'),
    届ける: (メッセージ: unknown) => 起こす('message', { data: JSON.stringify(メッセージ) }),
    閉じる: () => 起こす('close'),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

const 認証なしのHello = { op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }
const 認証ありのHello = {
  op: 0,
  d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge: 'チャレンジ', salt: 'ソルト' } },
}
const Identified = { op: 2, d: { negotiatedRpcVersion: 1 } }

describe('connectObs', () => {
  it('認証を求められなければ、認証を載せずに名乗る', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })

    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    偽のソケット.届ける(Identified)
    await つなぐ

    expect(偽のソケット.送ったもの[0]).toEqual({ op: 1, d: { rpcVersion: 1 } })
  })

  it('認証を求められたら、パスワードから作った応答を載せて名乗る', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: 'obsのパスワード', createSocket: () => 偽のソケット.socket })

    偽のソケット.開く()
    偽のソケット.届ける(認証ありのHello)
    // 認証の応答を作るのに待ちが入るので、名乗りが送られるまで待つ
    await vi.waitFor(() => expect(偽のソケット.送ったもの).toHaveLength(1))
    偽のソケット.届ける(Identified)
    await つなぐ

    expect(偽のソケット.送ったもの[0]).toEqual({
      op: 1,
      d: { rpcVersion: 1, authentication: await authenticationOf('obsのパスワード', 'ソルト', 'チャレンジ') },
    })
  })

  it('名乗りが通るまで、つながったことにしない', async () => {
    const 偽のソケット = 作る偽のソケット()
    let つながった = false
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket }).then((接続) => {
      つながった = true
      return 接続
    })

    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    await Promise.resolve()
    expect(つながった).toBe(false)

    偽のソケット.届ける(Identified)
    await つなぐ
    expect(つながった).toBe(true)
  })

  it('要求と応答を requestId で結び付ける', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })
    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    偽のソケット.届ける(Identified)
    const 接続 = await つなぐ

    const 場面 = 接続.request('GetCurrentProgramScene')
    const 撮影 = 接続.request('GetSourceScreenshot', { sourceName: 'ゲーム' })
    const 場面の要求ID = (偽のソケット.送ったもの[1]?.d as { requestId: string }).requestId
    const 撮影の要求ID = (偽のソケット.送ったもの[2]?.d as { requestId: string }).requestId

    // 先に撮影の応答を返しても、待っているものを取り違えない
    偽のソケット.届ける({ op: 7, d: { requestType: 'GetSourceScreenshot', requestId: 撮影の要求ID, requestStatus: { result: true }, responseData: { imageData: 'data:image/png;base64,iVBORw0KGgo=' } } })
    偽のソケット.届ける({ op: 7, d: { requestType: 'GetCurrentProgramScene', requestId: 場面の要求ID, requestStatus: { result: true }, responseData: { sceneName: 'ゲーム' } } })

    expect(await 場面).toEqual({ sceneName: 'ゲーム' })
    expect(await 撮影).toEqual({ imageData: 'data:image/png;base64,iVBORw0KGgo=' })
  })

  it('要求が失敗したら、その理由を添えて失敗させる', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })
    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    偽のソケット.届ける(Identified)
    const 接続 = await つなぐ

    const 撮影 = 接続.request('GetSourceScreenshot', { sourceName: '無い場面' })
    const 要求ID = (偽のソケット.送ったもの[1]?.d as { requestId: string }).requestId
    偽のソケット.届ける({ op: 7, d: { requestType: 'GetSourceScreenshot', requestId: 要求ID, requestStatus: { result: false, code: 600, comment: '存在しないソースです' } } })

    await expect(撮影).rejects.toThrow(/存在しないソースです/)
  })

  it('つながらないまま閉じたら、つなぎに行った呼び出しを失敗させる', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })

    偽のソケット.閉じる()

    await expect(つなぐ).rejects.toThrow(/ws:\/\/localhost:4455/)
  })

  it('名乗りへの答えが返ってこないまま時間が過ぎたら、待ち続けずに失敗させる', async () => {
    vi.useFakeTimers()
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })
    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    // OBS が Identified を返さないまま、待ち時間が過ぎる
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

    await expect(つなぐ).rejects.toThrow(/応答がありません/)
    expect(偽のソケット.閉じた()).toBe(true)
  })

  it('接続が閉じたら、答えを待っている要求を失敗させる', async () => {
    const 偽のソケット = 作る偽のソケット()
    const つなぐ = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => 偽のソケット.socket })
    偽のソケット.開く()
    偽のソケット.届ける(認証なしのHello)
    偽のソケット.届ける(Identified)
    const 接続 = await つなぐ

    const 撮影 = 接続.request('GetSourceScreenshot', { sourceName: 'ゲーム' })
    偽のソケット.閉じる()

    await expect(撮影).rejects.toThrow()
    expect(接続.isOpen()).toBe(false)
  })
})
