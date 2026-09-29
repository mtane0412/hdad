// @vitest-environment jsdom
/**
 * WebSocketの接続の続け方のテスト
 *
 * 配信中は切断が普通に起こるので、確かめるのは「つなぎ直し続けること」と「その間の知らせ方」である。
 * 本物のWebSocketは使わず、つながる・閉じるの合図を手で起こせる偽物を渡して確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSocket, type SocketLike } from './socket'

/** つながる・閉じる・届くの合図を手で起こせる、テスト用のWebSocket */
const 偽のWebSocketを作る = (): SocketLike & { 送ったもの: string[]; 閉じられた: boolean; つなぐ: () => void; 閉じる: () => void; 届ける: (data: unknown) => void } => {
  const socket: SocketLike & { 送ったもの: string[]; 閉じられた: boolean; つなぐ: () => void; 閉じる: () => void; 届ける: (data: unknown) => void } = {
    送ったもの: [],
    閉じられた: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    close: () => {
      socket.閉じられた = true
    },
    send: (data) => socket.送ったもの.push(data),
    つなぐ: () => socket.onopen?.(new Event('open')),
    閉じる: () => socket.onclose?.(new CloseEvent('close')),
    届ける: (data) => socket.onmessage?.(new MessageEvent('message', { data })),
  }
  return socket
}

/** 何度でもつなぎ直せるよう、作られた偽物を順に覚えておく */
const 接続の記録を作る = () => {
  const 作られたもの: ReturnType<typeof 偽のWebSocketを作る>[] = []
  const つなぎ先: string[] = []
  return {
    作られたもの,
    つなぎ先,
    open: (url: string): SocketLike => {
      つなぎ先.push(url)
      const socket = 偽のWebSocketを作る()
      作られたもの.push(socket)
      return socket
    },
    /** 最後に作られた偽物 */
    いま: () => 作られたもの[作られたもの.length - 1] as ReturnType<typeof 偽のWebSocketを作る>,
  }
}

const 何もしないハンドラ = () => ({ onMessage: vi.fn(), onStatus: vi.fn(), onWarning: vi.fn() })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('connectSocket', () => {
  it('渡されたURLへつなぐ', () => {
    const 記録 = 接続の記録を作る()

    connectSocket('wss://例.example.com/api/overlay/draw', 何もしないハンドラ(), '手がかりの文', 記録.open)

    expect(記録.つなぎ先).toEqual(['wss://例.example.com/api/overlay/draw'])
  })

  it('届いた文字列をそのまま渡す', () => {
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    connectSocket('wss://例', ハンドラ, '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().届ける('{"type":"start"}')

    expect(ハンドラ.onMessage).toHaveBeenCalledWith('{"type":"start"}')
  })

  it('生存確認の返事は渡さない', () => {
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    connectSocket('wss://例', ハンドラ, '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().届ける('')
    記録.いま().届ける('ping')
    記録.いま().届ける('pong')

    expect(ハンドラ.onMessage).not.toHaveBeenCalled()
  })

  it('つないでいるあいだ、生存確認を送り続ける', () => {
    // 途中の経路が黙っている接続を切ることがあるため、こちらから合図を送る
    const 記録 = 接続の記録を作る()
    connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    vi.advanceTimersByTime(60000)

    expect(記録.いま().送ったもの).toEqual(['ping', 'ping'])
  })

  it('切れたら、間を空けてつなぎ直す', () => {
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    connectSocket('wss://例', ハンドラ, '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().閉じる()

    expect(ハンドラ.onStatus).toHaveBeenCalledWith('disconnected')
    expect(記録.作られたもの).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(記録.作られたもの).toHaveLength(2)
  })

  it('つなぎ直せたら、そのことを知らせる', () => {
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    connectSocket('wss://例', ハンドラ, '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().閉じる()
    vi.advanceTimersByTime(1000)
    記録.いま().つなぐ()

    expect(ハンドラ.onStatus).toHaveBeenLastCalledWith('reconnected')
  })

  it('つなぎ直しの間隔は、失敗のたびに延びる', () => {
    const 記録 = 接続の記録を作る()
    connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().閉じる()
    vi.advanceTimersByTime(1000)
    記録.いま().閉じる()

    // 2度目は1秒では戻らず、2秒待って戻る
    vi.advanceTimersByTime(1000)
    expect(記録.作られたもの).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    expect(記録.作られたもの).toHaveLength(3)
  })

  it('一度もつながらないまま閉じたら、手がかりを知らせる', () => {
    // ブラウザのWebSocketは、つながらなかった理由（Workerの401など）を教えてくれない
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    connectSocket('wss://例', ハンドラ, 'オーバーレイ用キーを確かめてください', 記録.open)

    記録.いま().閉じる()

    expect(ハンドラ.onWarning).toHaveBeenCalledWith('オーバーレイ用キーを確かめてください')
    expect(ハンドラ.onStatus).not.toHaveBeenCalled()
  })

  it('つながっていれば送れる', () => {
    const 記録 = 接続の記録を作る()
    const 接続 = connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()

    expect(接続.send('{"type":"start"}')).toBe(true)
    expect(記録.いま().送ったもの).toEqual(['{"type":"start"}'])
  })

  it('閉じたら、つなぎ直さない', () => {
    // 描く画面から離れたあとも接続が残ると、画面を行き来するたびに接続が増えていく
    const 記録 = 接続の記録を作る()
    const 接続 = connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    接続.close()

    expect(記録.いま().閉じられた).toBe(true)
    記録.いま().閉じる()
    vi.advanceTimersByTime(60000)
    expect(記録.作られたもの).toHaveLength(1)
  })

  it('切れたあとに閉じたら、予約されていたつなぎ直しも起こさない', () => {
    // 先に切れて再接続が予約されてから画面を離れる順序でも、接続が生き返らないようにする
    const 記録 = 接続の記録を作る()
    const 接続 = connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    記録.いま().閉じる()
    接続.close()
    vi.advanceTimersByTime(60000)

    expect(記録.作られたもの).toHaveLength(1)
  })

  it('閉じたあとは、生存確認も送らない', () => {
    const 記録 = 接続の記録を作る()
    const 接続 = connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    接続.close()
    vi.advanceTimersByTime(60000)

    expect(記録.いま().送ったもの).toEqual([])
  })

  it('閉じたあとは、切断も知らせない', () => {
    // 自分で閉じたのだから、配信画面に「接続が切れました」と出す理由がない
    const 記録 = 接続の記録を作る()
    const ハンドラ = 何もしないハンドラ()
    const 接続 = connectSocket('wss://例', ハンドラ, '手がかりの文', 記録.open)

    記録.いま().つなぐ()
    接続.close()
    記録.いま().閉じる()

    expect(ハンドラ.onStatus).not.toHaveBeenCalled()
  })

  it('つながっていなければ送らずに落とす', () => {
    // 描いている途中で切れることはある。貯めて後からまとめて流すと、時間のずれた線が現れる
    const 記録 = 接続の記録を作る()
    const 接続 = connectSocket('wss://例', 何もしないハンドラ(), '手がかりの文', 記録.open)

    expect(接続.send('{"type":"start"}')).toBe(false)
    expect(記録.いま().送ったもの).toEqual([])
  })
})
