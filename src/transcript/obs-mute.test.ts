/**
 * OBS のマイクのミュートの見張り（src/transcript/obs-mute.ts）のテスト
 *
 * OBS への接続は代役に差し替え、つなぎ直しの待ちは偽のタイマーで進める。確かめるのは次のこと。
 * - つないだら、指定した入力のいまのミュートを問い合わせて知らせること
 * - 指定した入力のミュートが切り替わったら知らせ、ほかの入力の切り替えは無視すること
 * - つながらない・入力が無い・切れたときは理由を知らせ、間を置いてつなぎ直すこと
 * - 止めたあとは何も知らせず、つないだ接続を閉じること
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObsConnection } from '../screen/connection'
import { mutedOfEvent, OBS_MUTE_RETRY_MS, watchObsMute, type ObsMuteConnectHandlers, type ObsMuteState } from './obs-mute'

/** 問い合わせに決めた答えを返し、閉じた回数を残す OBS の接続の代役 */
const createConnection = (answer: (requestType: string, requestData: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
  const requests: { requestType: string; requestData: Record<string, unknown> }[] = []
  let closes = 0
  const connection: ObsConnection = {
    request: (requestType, requestData = {}) => {
      requests.push({ requestType, requestData })
      return answer(requestType, requestData)
    },
    isOpen: () => closes === 0,
    close: () => {
      closes += 1
    },
  }
  return { connection, requests, closes: () => closes }
}

/** つなぐたびに渡された受け口を残し、決めた結果を返す connect の代役 */
const createConnect = (results: (() => Promise<ObsConnection>)[]) => {
  const handlers: ObsMuteConnectHandlers[] = []
  const connect = (received: ObsMuteConnectHandlers): Promise<ObsConnection> => {
    handlers.push(received)
    const next = results.shift()
    if (!next) return new Promise<never>(() => {})
    return next()
  }
  return { connect, handlers }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mutedOfEvent', () => {
  it('指定した入力のミュートの切り替えなら、ミュートかどうかを返す', () => {
    expect(mutedOfEvent('InputMuteStateChanged', { inputName: 'マイク', inputMuted: true }, 'マイク')).toBe(true)
    expect(mutedOfEvent('InputMuteStateChanged', { inputName: 'マイク', inputMuted: false }, 'マイク')).toBe(false)
  })

  it('ほかの入力の切り替えは関係ないので null を返す', () => {
    expect(mutedOfEvent('InputMuteStateChanged', { inputName: 'デスクトップ音声', inputMuted: true }, 'マイク')).toBeNull()
  })

  it('ミュートの切り替えでない出来事は null を返す', () => {
    expect(mutedOfEvent('CurrentProgramSceneChanged', { sceneName: 'ゲーム' }, 'マイク')).toBeNull()
  })

  it('ミュートかどうかが読めない切り替えはエラーにする（黙って無視しない）', () => {
    expect(() => mutedOfEvent('InputMuteStateChanged', { inputName: 'マイク' }, 'マイク')).toThrow()
  })
})

describe('watchObsMute', () => {
  it('つないだら、指定した入力のいまのミュートを問い合わせて知らせる', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: true }))
    const { connect } = createConnect([() => Promise.resolve(obs.connection)])
    const states: ObsMuteState[] = []

    watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)

    expect(obs.requests).toEqual([{ requestType: 'GetInputMute', requestData: { inputName: 'マイク' } }])
    expect(states).toEqual([{ kind: 'connecting' }, { kind: 'watching', muted: true }])
  })

  it('指定した入力のミュートが切り替わったら知らせ、ほかの入力の切り替えは無視する', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: false }))
    const { connect, handlers } = createConnect([() => Promise.resolve(obs.connection)])
    const states: ObsMuteState[] = []
    watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)

    handlers[0]?.onEvent('InputMuteStateChanged', { inputName: 'デスクトップ音声', inputMuted: true })
    handlers[0]?.onEvent('InputMuteStateChanged', { inputName: 'マイク', inputMuted: true })

    expect(states.at(-1)).toEqual({ kind: 'watching', muted: true })
    expect(states.filter((state) => state.kind === 'watching')).toHaveLength(2)
  })

  it('つながらなければ理由を知らせ、間を置いてつなぎ直す', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: false }))
    const { connect, handlers } = createConnect([
      () => Promise.reject(new Error('ws://localhost:4455 につながりませんでした')),
      () => Promise.resolve(obs.connection),
    ])
    const states: ObsMuteState[] = []
    watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)

    expect(states.at(-1)).toEqual({ kind: 'failed', message: 'ws://localhost:4455 につながりませんでした' })

    await vi.advanceTimersByTimeAsync(OBS_MUTE_RETRY_MS)

    expect(handlers).toHaveLength(2)
    expect(states.at(-1)).toEqual({ kind: 'watching', muted: false })
  })

  it('指定した入力が OBS に無ければ、入力の名前を添えて知らせ、接続を閉じてつなぎ直す', async () => {
    const obs = createConnection(() => Promise.reject(new Error('GetInputMute が失敗しました（コード 600）: No source was found')))
    const { connect, handlers } = createConnect([() => Promise.resolve(obs.connection)])
    const states: ObsMuteState[] = []
    watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)

    const last = states.at(-1)
    expect(last?.kind).toBe('failed')
    expect(last?.kind === 'failed' ? last.message : '').toContain('「マイク」')
    expect(obs.closes()).toBe(1)

    await vi.advanceTimersByTimeAsync(OBS_MUTE_RETRY_MS)
    expect(handlers).toHaveLength(2)
  })

  it('つながったあとに切れたら理由を知らせ、間を置いてつなぎ直す', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: false }))
    const { connect, handlers } = createConnect([() => Promise.resolve(obs.connection)])
    const states: ObsMuteState[] = []
    watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)

    handlers[0]?.onClose(new Error('ws://localhost:4455 との接続が切れました'))

    expect(states.at(-1)).toEqual({ kind: 'failed', message: 'ws://localhost:4455 との接続が切れました' })
    await vi.advanceTimersByTimeAsync(OBS_MUTE_RETRY_MS)
    expect(handlers).toHaveLength(2)
  })

  it('古い接続が遅れて切れたことは、つなぎ直しの数に入れない', async () => {
    const obs = createConnection(() => Promise.reject(new Error('GetInputMute が失敗しました')))
    const { connect, handlers } = createConnect([() => Promise.resolve(obs.connection)])
    watchObsMute({ inputName: 'マイク', connect, onChange: () => {} })
    await vi.advanceTimersByTimeAsync(0)

    // 問い合わせに失敗して閉じた接続から、遅れて「切れた」が届く
    handlers[0]?.onClose(new Error('ws://localhost:4455 との接続が切れました'))
    await vi.advanceTimersByTimeAsync(OBS_MUTE_RETRY_MS)

    expect(handlers).toHaveLength(2)
  })

  it('止めたら接続を閉じ、そのあとの出来事も切断も知らせず、つなぎ直さない', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: false }))
    const { connect, handlers } = createConnect([() => Promise.resolve(obs.connection)])
    const states: ObsMuteState[] = []
    const watcher = watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })
    await vi.advanceTimersByTimeAsync(0)
    const before = states.length

    watcher.stop()
    handlers[0]?.onEvent('InputMuteStateChanged', { inputName: 'マイク', inputMuted: true })
    handlers[0]?.onClose(new Error('ws://localhost:4455 との接続が切れました'))
    await vi.advanceTimersByTimeAsync(OBS_MUTE_RETRY_MS)

    expect(obs.closes()).toBe(1)
    expect(states).toHaveLength(before)
    expect(handlers).toHaveLength(1)
  })

  it('つないでいる途中で止めたら、あとからつながった接続を閉じる', async () => {
    const obs = createConnection(() => Promise.resolve({ inputMuted: false }))
    let finishConnect: (connection: ObsConnection) => void = () => {}
    const { connect } = createConnect([() => new Promise<ObsConnection>((resolve) => (finishConnect = resolve))])
    const states: ObsMuteState[] = []
    const watcher = watchObsMute({ inputName: 'マイク', connect, onChange: (state) => states.push(state) })

    watcher.stop()
    finishConnect(obs.connection)
    await vi.advanceTimersByTimeAsync(0)

    expect(obs.closes()).toBe(1)
    expect(obs.requests).toHaveLength(0)
    expect(states).toEqual([{ kind: 'connecting' }])
  })
})
