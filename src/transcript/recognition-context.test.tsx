// @vitest-environment jsdom
/**
 * アプリの枠で動かす音声認識（recognition-context.tsx）のテスト
 *
 * Chrome の音声認識・マイク・タブ間の鍵（Web Locks）・Worker への送信は代役に差し替える。
 * 確かめるのは、オン・オフが覚えられること、鍵を取れたタブだけが認識すること、確定した発話が Worker へ送られること。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptApi } from './api'
import { browserRecognitionDeps, RecognitionProvider, useRecognition, type RecognitionDeps } from './recognition-context'
import type { RecognitionLike, RecognitionResultEvent } from './recognizer'

/** 呼ばれた操作を記録する SpeechRecognition の代役 */
class FakeRecognition implements RecognitionLike {
  lang = ''
  continuous = false
  interimResults = false
  onstart: (() => void) | null = null
  onresult: ((event: RecognitionResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  starts = 0
  stops = 0

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
  }
}

/** 頼まれた鍵をすぐ渡すか、ずっと渡さないか（別のタブが持っている）を選べる Web Locks の代役 */
const createLocks = (available: boolean) => {
  const requested: string[] = []
  const locks: RecognitionDeps['locks'] = {
    request: async (name, _options, callback) => {
      requested.push(name)
      if (!available) return new Promise<never>(() => {})
      return callback()
    },
  }
  return { locks, requested }
}

const setup = ({ available = true, supported = true } = {}) => {
  const recognition = new FakeRecognition()
  const sent: { messageId: string; text: string }[] = []
  const api: TranscriptApi = {
    async send(messageId, text) {
      sent.push({ messageId, text })
      return true
    },
  }
  const { locks, requested } = createLocks(available)
  const microphone = { released: 0 }
  const deps: RecognitionDeps = {
    api,
    createRecognition: supported ? () => recognition : null,
    openMicrophone: async () => ({
      release: () => {
        microphone.released += 1
      },
    }),
    locks,
    storage: window.localStorage,
  }
  return { deps, recognition, sent, requested, microphone }
}

/** 文脈の中身を画面に出し、オン・オフを切り替えるボタンを置く */
const Probe = () => {
  const { enabled, setEnabled, phase, recognizer, lines } = useRecognition()
  return (
    <div>
      <p>状態: {phase}</p>
      <p>認識: {recognizer.status.kind}</p>
      <ul>
        {lines.map((line) => (
          <li key={line.id}>
            {line.text}（{line.state}）
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setEnabled(!enabled)}>
        {enabled ? '止める' : '始める'}
      </button>
    </div>
  )
}

const STORAGE_KEY = 'hdad:transcript-recognition'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('RecognitionProvider', () => {
  it('はじめはオフで、認識もマイクも使わない', () => {
    const { deps, requested } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )

    expect(screen.getByText('状態: off')).toBeTruthy()
    expect(requested).toEqual([])
  })

  it('オンにすると、タブ間の鍵を取ってから認識を始め、オンを覚える', async () => {
    const { deps, recognition, requested } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )

    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    expect(requested).toEqual(['hdad-transcript-recognition'])
    expect(recognition.starts).toBe(1)
    expect(screen.getByText('状態: running')).toBeTruthy()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('on')
  })

  it('前に開いたときオンにしていたなら、開いただけで認識を始める', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'on')
    const { deps, recognition } = setup()

    await act(async () => {
      render(
        <RecognitionProvider deps={deps}>
          <Probe />
        </RecognitionProvider>,
      )
    })

    expect(recognition.starts).toBe(1)
  })

  it('確定した発話を Worker へ送り、記録されたことを残す', async () => {
    const { deps, recognition, sent } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => {
      recognition.onstart?.()
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'こんばんは' } }] })
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe('こんばんは')
    expect(screen.getByText('こんばんは（recorded）')).toBeTruthy()
  })

  it('別のタブが鍵を持っていれば、認識を始めずに待つ', async () => {
    const { deps, recognition } = setup({ available: false })
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )

    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    expect(screen.getByText('状態: waiting')).toBeTruthy()
    expect(recognition.starts).toBe(0)
  })

  it('オフにすると認識を止め、オフを覚える', async () => {
    const { deps, recognition } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => screen.getByRole('button', { name: '止める' }).click())

    expect(recognition.stops).toBe(1)
    expect(screen.getByText('状態: off')).toBeTruthy()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('off')
  })

  it('ほかのタブでオフにされたら、このタブの認識も止める', async () => {
    const { deps, recognition } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => {
      window.localStorage.setItem(STORAGE_KEY, 'off')
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'off' }))
    })

    expect(recognition.stops).toBe(1)
    expect(screen.getByText('状態: off')).toBeTruthy()
  })

  it('音声認識の無いブラウザでは、オンにしても使えないと出す', async () => {
    const { deps, requested } = setup({ supported: false })
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )

    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    expect(screen.getByText('状態: unsupported')).toBeTruthy()
    expect(requested).toEqual([])
  })
})

describe('browserRecognitionDeps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const api: TranscriptApi = { send: () => Promise.resolve(true) }

  it('音声認識があり、タブ間の鍵も使えるブラウザでは、認識を作れる', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
    vi.stubGlobal('navigator', { ...navigator, locks: createLocks(true).locks })

    expect(browserRecognitionDeps(api).createRecognition).not.toBeNull()
  })

  it('音声認識があっても、タブ間の鍵（Web Locks）が無ければ使えないものとして扱う', () => {
    // 前提: https でないページなどでは navigator.locks が無い
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
    vi.stubGlobal('navigator', { ...navigator, locks: undefined })

    expect(browserRecognitionDeps(api).createRecognition).toBeNull()
  })
})
