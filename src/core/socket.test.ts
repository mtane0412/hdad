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
const createFakeWebSocket = (): SocketLike & { sent: string[]; closed: boolean; connect: () => void; serverClose: () => void; deliver: (data: unknown) => void } => {
  const socket: SocketLike & { sent: string[]; closed: boolean; connect: () => void; serverClose: () => void; deliver: (data: unknown) => void } = {
    sent: [],
    closed: false,
    onopen: null,
    onmessage: null,
    onclose: null,
    close: () => {
      socket.closed = true
    },
    send: (data) => socket.sent.push(data),
    connect: () => socket.onopen?.(new Event('open')),
    serverClose: () => socket.onclose?.(new CloseEvent('close')),
    deliver: (data) => socket.onmessage?.(new MessageEvent('message', { data })),
  }
  return socket
}

/** 何度でもつなぎ直せるよう、作られた偽物を順に覚えておく */
const createConnectionRecord = () => {
  const created: ReturnType<typeof createFakeWebSocket>[] = []
  const target: string[] = []
  return {
    created,
    target,
    open: (url: string): SocketLike => {
      target.push(url)
      const socket = createFakeWebSocket()
      created.push(socket)
      return socket
    },
    /** 最後に作られた偽物 */
    current: () => created[created.length - 1] as ReturnType<typeof createFakeWebSocket>,
  }
}

const noopHandlers = () => ({ onMessage: vi.fn(), onStatus: vi.fn(), onWarning: vi.fn() })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('connectSocket', () => {
  it('渡されたURLへつなぐ', () => {
    const record = createConnectionRecord()

    connectSocket('wss://例.example.com/api/overlay/draw', noopHandlers(), '手がかりの文', record.open)

    expect(record.target).toEqual(['wss://例.example.com/api/overlay/draw'])
  })

  it('届いた文字列をそのまま渡す', () => {
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    record.current().deliver('{"type":"start"}')

    expect(handlers.onMessage).toHaveBeenCalledWith('{"type":"start"}')
  })

  it('生存確認の返事は渡さない', () => {
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    record.current().deliver('')
    record.current().deliver('ping')
    record.current().deliver('pong')

    expect(handlers.onMessage).not.toHaveBeenCalled()
  })

  it('つないでいるあいだ、生存確認を送り続ける', () => {
    // 途中の経路が黙っている接続を切ることがあるため、こちらから合図を送る
    const record = createConnectionRecord()
    connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()
    vi.advanceTimersByTime(60000)

    expect(record.current().sent).toEqual(['ping', 'ping'])
  })

  it('切れたら、間を空けてつなぎ直す', () => {
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    record.current().serverClose()

    expect(handlers.onStatus).toHaveBeenCalledWith('disconnected')
    expect(record.created).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(record.created).toHaveLength(2)
  })

  it('つなぎ直せたら、そのことを知らせる', () => {
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    record.current().serverClose()
    vi.advanceTimersByTime(1000)
    record.current().connect()

    expect(handlers.onStatus).toHaveBeenLastCalledWith('reconnected')
  })

  it('つながるたびに（初めての接続でも、つなぎ直しでも）onOpen を呼ぶ', () => {
    const record = createConnectionRecord()
    const handlers = { ...noopHandlers(), onOpen: vi.fn() }
    connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    expect(handlers.onOpen).toHaveBeenCalledTimes(1)
    record.current().serverClose()
    vi.advanceTimersByTime(1000)
    record.current().connect()

    expect(handlers.onOpen).toHaveBeenCalledTimes(2)
  })

  it('つなぎ直しの間隔は、失敗のたびに延びる', () => {
    const record = createConnectionRecord()
    connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()
    record.current().serverClose()
    vi.advanceTimersByTime(1000)
    record.current().serverClose()

    // 2度目は1秒では戻らず、2秒待って戻る
    vi.advanceTimersByTime(1000)
    expect(record.created).toHaveLength(2)
    vi.advanceTimersByTime(1000)
    expect(record.created).toHaveLength(3)
  })

  it('一度もつながらないまま閉じたら、手がかりを知らせる', () => {
    // ブラウザのWebSocketは、つながらなかった理由（Workerの401など）を教えてくれない
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    connectSocket('wss://例', handlers, 'オーバーレイ用キーを確かめてください', record.open)

    record.current().serverClose()

    expect(handlers.onWarning).toHaveBeenCalledWith('オーバーレイ用キーを確かめてください')
    expect(handlers.onStatus).not.toHaveBeenCalled()
  })

  it('つながっていれば送れる', () => {
    const record = createConnectionRecord()
    const connection = connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()

    expect(connection.send('{"type":"start"}')).toBe(true)
    expect(record.current().sent).toEqual(['{"type":"start"}'])
  })

  it('閉じたら、つなぎ直さない', () => {
    // 描く画面から離れたあとも接続が残ると、画面を行き来するたびに接続が増えていく
    const record = createConnectionRecord()
    const connection = connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()
    connection.close()

    expect(record.current().closed).toBe(true)
    record.current().serverClose()
    vi.advanceTimersByTime(60000)
    expect(record.created).toHaveLength(1)
  })

  it('切れたあとに閉じたら、予約されていたつなぎ直しも起こさない', () => {
    // 先に切れて再接続が予約されてから画面を離れる順序でも、接続が生き返らないようにする
    const record = createConnectionRecord()
    const connection = connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()
    record.current().serverClose()
    connection.close()
    vi.advanceTimersByTime(60000)

    expect(record.created).toHaveLength(1)
  })

  it('閉じたあとは、生存確認も送らない', () => {
    const record = createConnectionRecord()
    const connection = connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    record.current().connect()
    connection.close()
    vi.advanceTimersByTime(60000)

    expect(record.current().sent).toEqual([])
  })

  it('閉じたあとは、切断も知らせない', () => {
    // 自分で閉じたのだから、配信画面に「接続が切れました」と出す理由がない
    const record = createConnectionRecord()
    const handlers = noopHandlers()
    const connection = connectSocket('wss://例', handlers, '手がかりの文', record.open)

    record.current().connect()
    connection.close()
    record.current().serverClose()

    expect(handlers.onStatus).not.toHaveBeenCalled()
  })

  it('つながっていなければ送らずに落とす', () => {
    // 描いている途中で切れることはある。貯めて後からまとめて流すと、時間のずれた線が現れる
    const record = createConnectionRecord()
    const connection = connectSocket('wss://例', noopHandlers(), '手がかりの文', record.open)

    expect(connection.send('{"type":"start"}')).toBe(false)
    expect(record.current().sent).toEqual([])
  })
})
