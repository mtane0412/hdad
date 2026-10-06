/**
 * OBS（obs-websocket）への接続（src/screen/connection.ts）のテスト
 *
 * WebSocket を差し替えて確かめる。特に重要なのは次の4点である。
 * - 認証を求められたら応答を返し、求められなければ名乗るだけで済ませること
 * - 名乗りが通る（Identified）まで、つながったことにしないこと
 * - 要求と応答を requestId で結び付けること（撮影と場面の問い合わせが入れ違わないため）
 * - つながらないまま閉じたときに、待っている呼び出しを失敗させること（黙って待ち続けない）
 * - 閉じられた理由（クローズコード）を文面に反映すること（パスワード違いを接続の失敗と取り違えないため）
 * - 名乗りへの答えが返ってこないまま時間が過ぎたら、待ち続けずに失敗させること
 * - つながったあとに届いたイベントと、つながったあとに切れたことを知らせること（文字起こしがマイクのミュートを見張るため）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_TIMEOUT_MS, connectObs, type ObsSocketLike } from './connection'
import { authenticationOf } from './protocol'

/** 押し込まれた文字列を覚える、テスト用の WebSocket */
const createFakeSocket = () => {
  const sent: Record<string, unknown>[] = []
  /** 受け手の形はイベントごとに違うので、まとめて持つためにここだけ緩く扱う */
  const receiver = new Map<string, ((event: never) => void)[]>()
  let closed = false

  const socket: ObsSocketLike = {
    send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
    close: () => {
      closed = true
    },
    addEventListener: (type, listener) => {
      receiver.set(type, [...(receiver.get(type) ?? []), listener as (event: never) => void])
    },
  }

  const emit = (type: string, event: unknown = {}): void => {
    for (const listener of receiver.get(type) ?? []) (listener as (event: unknown) => void)(event)
  }

  return {
    socket,
    sent,
    closed: () => closed,
    open: () => emit('open'),
    deliver: (message: unknown) => emit('message', { data: JSON.stringify(message) }),
    close: (event: { code?: number; reason?: string } = {}) => emit('close', event),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

const helloWithoutAuth = { op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }
const helloWithAuth = {
  op: 0,
  d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge: 'チャレンジ', salt: 'ソルト' } },
}
const Identified = { op: 2, d: { negotiatedRpcVersion: 1 } }

describe('connectObs', () => {
  it('認証を求められなければ、認証を載せずに名乗る', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })

    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    await connect

    expect(fakeSocket.sent[0]).toEqual({ op: 1, d: { rpcVersion: 1 } })
  })

  it('認証を求められたら、パスワードから作った応答を載せて名乗る', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: 'obsのパスワード', createSocket: () => fakeSocket.socket })

    fakeSocket.open()
    fakeSocket.deliver(helloWithAuth)
    // 認証の応答を作るのに待ちが入るので、名乗りが送られるまで待つ
    await vi.waitFor(() => expect(fakeSocket.sent).toHaveLength(1))
    fakeSocket.deliver(Identified)
    await connect

    expect(fakeSocket.sent[0]).toEqual({
      op: 1,
      d: { rpcVersion: 1, authentication: await authenticationOf('obsのパスワード', 'ソルト', 'チャレンジ') },
    })
  })

  it('名乗りが通るまで、つながったことにしない', async () => {
    const fakeSocket = createFakeSocket()
    let connected = false
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket }).then((connection) => {
      connected = true
      return connection
    })

    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    await Promise.resolve()
    expect(connected).toBe(false)

    fakeSocket.deliver(Identified)
    await connect
    expect(connected).toBe(true)
  })

  it('要求と応答を requestId で結び付ける', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    const connection = await connect

    const scene = connection.request('GetCurrentProgramScene')
    const shoot = connection.request('GetSourceScreenshot', { sourceName: 'ゲーム' })
    const sceneRequestId = (fakeSocket.sent[1]?.d as { requestId: string }).requestId
    const shootRequestId = (fakeSocket.sent[2]?.d as { requestId: string }).requestId

    // 先に撮影の応答を返しても、待っているものを取り違えない
    fakeSocket.deliver({ op: 7, d: { requestType: 'GetSourceScreenshot', requestId: shootRequestId, requestStatus: { result: true }, responseData: { imageData: 'data:image/png;base64,iVBORw0KGgo=' } } })
    fakeSocket.deliver({ op: 7, d: { requestType: 'GetCurrentProgramScene', requestId: sceneRequestId, requestStatus: { result: true }, responseData: { sceneName: 'ゲーム' } } })

    expect(await scene).toEqual({ sceneName: 'ゲーム' })
    expect(await shoot).toEqual({ imageData: 'data:image/png;base64,iVBORw0KGgo=' })
  })

  it('要求が失敗したら、その理由を添えて失敗させる', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    const connection = await connect

    const shoot = connection.request('GetSourceScreenshot', { sourceName: '無い場面' })
    const requestId = (fakeSocket.sent[1]?.d as { requestId: string }).requestId
    fakeSocket.deliver({ op: 7, d: { requestType: 'GetSourceScreenshot', requestId, requestStatus: { result: false, code: 600, comment: '存在しないソースです' } } })

    await expect(shoot).rejects.toThrow(/存在しないソースです/)
  })

  it('つながらないまま閉じたら、つなぎに行った呼び出しを失敗させる', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })

    fakeSocket.close()

    await expect(connect).rejects.toThrow(/ws:\/\/localhost:4455/)
  })

  it('パスワードが違って閉じられたら、パスワードが違うと分かる文面で失敗させる', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '違うパスワード', createSocket: () => fakeSocket.socket })

    // obs-websocket はパスワードが違うと、つないだ直後にクローズコード 4009 で切る
    fakeSocket.close({ code: 4009, reason: 'Authentication failed.' })

    await expect(connect).rejects.toThrow(/パスワード/)
  })

  it('ほかの理由で閉じられたら、クローズコードを文面に添える', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })

    fakeSocket.close({ code: 4010, reason: 'Unsupported RPC version.' })

    await expect(connect).rejects.toThrow(/4010/)
  })

  it('つながる前に閉じられたときも、クローズコードを文面に添える', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })

    // ブラウザはつなげなかったとき 1006（異常終了）で閉じる
    fakeSocket.close({ code: 1006 })

    await expect(connect).rejects.toThrow(/1006/)
  })

  it('名乗りへの答えが返ってこないまま時間が過ぎたら、待ち続けずに失敗させる', async () => {
    vi.useFakeTimers()
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })
    // 失敗を受け取る用意を、タイマーを進める前に済ませる
    // （進めたあとに付けると、受け取り手のいない拒否として扱われる一瞬ができる）
    const waitForFailure = expect(connect).rejects.toThrow(/応答がありません/)
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)

    // OBS が Identified を返さないまま、待ち時間が過ぎる
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

    await waitForFailure
    expect(fakeSocket.closed()).toBe(true)
  })

  it('接続が閉じたら、答えを待っている要求を失敗させる', async () => {
    const fakeSocket = createFakeSocket()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket })
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    const connection = await connect

    const shoot = connection.request('GetSourceScreenshot', { sourceName: 'ゲーム' })
    fakeSocket.close()

    await expect(shoot).rejects.toThrow()
    expect(connection.isOpen()).toBe(false)
  })

  it('つながったあとに届いたイベントを、種類と中身とともに知らせる', async () => {
    const fakeSocket = createFakeSocket()
    const events: { eventType: string; data: Record<string, unknown> }[] = []
    const connect = connectObs({
      url: 'ws://localhost:4455',
      password: '',
      createSocket: () => fakeSocket.socket,
      onEvent: (eventType, data) => events.push({ eventType, data }),
    })
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    await connect

    fakeSocket.deliver({ op: 5, d: { eventType: 'InputMuteStateChanged', eventIntent: 8, eventData: { inputName: 'マイク', inputMuted: true } } })

    expect(events).toEqual([{ eventType: 'InputMuteStateChanged', data: { inputName: 'マイク', inputMuted: true } }])
  })

  it('つながったあとに切れたら、そのことを知らせる', async () => {
    const fakeSocket = createFakeSocket()
    const closes: string[] = []
    const connect = connectObs({
      url: 'ws://localhost:4455',
      password: '',
      createSocket: () => fakeSocket.socket,
      onClose: (error) => closes.push(error.message),
    })
    fakeSocket.open()
    fakeSocket.deliver(helloWithoutAuth)
    fakeSocket.deliver(Identified)
    await connect

    fakeSocket.close({ code: 1001 })

    expect(closes).toEqual(['ws://localhost:4455 との接続が切れました'])
  })

  it('つながる前に閉じたときは、切れたことを知らせず、つなぎに行った呼び出しだけを失敗させる', async () => {
    const fakeSocket = createFakeSocket()
    const onClose = vi.fn()
    const connect = connectObs({ url: 'ws://localhost:4455', password: '', createSocket: () => fakeSocket.socket, onClose })

    fakeSocket.close({ code: 1006 })

    await expect(connect).rejects.toThrow(/1006/)
    expect(onClose).not.toHaveBeenCalled()
  })
})
