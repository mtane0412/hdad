// @vitest-environment jsdom
/**
 * アプリの枠で動かす音声認識（recognition-context.tsx）のテスト
 *
 * Chrome の音声認識・マイク・タブ間の鍵（Web Locks）・Worker への送信は代役に差し替える。
 * 確かめるのは、オン・オフが覚えられること、鍵を取れたタブだけが認識すること、確定した発話が Worker へ送られること、
 * 話している途中の文と確定した文が字幕の中継先へ送られること（issue #190）。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSocketHandlers } from '../caption/socket'
import type { CaptionMessage } from '../caption/message'
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
  /** 字幕の中継先への接続の代役。送ったものと、閉じた回数と、つなぐときに渡された受け口を残す */
  const caption = { connects: 0, closes: 0, sent: [] as CaptionMessage[], handlers: null as CaptionSocketHandlers | null }
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
    connectCaption: (handlers) => {
      caption.connects += 1
      caption.handlers = handlers
      return {
        send: (message) => {
          caption.sent.push(message)
          return true
        },
        close: () => {
          caption.closes += 1
        },
      }
    },
  }
  return { deps, recognition, sent, requested, microphone, caption }
}

/** 文脈の中身を画面に出し、オン・オフを切り替えるボタンを置く */
const Probe = () => {
  const { enabled, setEnabled, phase, recognizer, lines, captionWarning } = useRecognition()
  return (
    <div>
      <p>状態: {phase}</p>
      <p>字幕: {captionWarning ?? 'つながっている'}</p>
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

  it('話している途中の文と確定した文を、字幕の中継先へ順に送る', async () => {
    const { deps, recognition, caption } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => {
      recognition.onstart?.()
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'こんばん' } }] })
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'こんばんは今日は' } }] })
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'こんばんは、今日は' } }] })
    })

    expect(caption.connects).toBe(1)
    expect(caption.sent).toEqual([
      { type: 'interim', text: 'こんばん' },
      { type: 'interim', text: 'こんばんは今日は' },
      { type: 'final', text: 'こんばんは、今日は' },
      // 確定したので、話している途中の文が無くなったことも知らせる
      { type: 'interim', text: '' },
    ])
  })

  it('話している途中の文が変わらなければ、字幕の中継先へ送り直さない', async () => {
    const { deps, recognition, caption } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => {
      // 認識が始まったという知らせでも状態は変わるが、話している途中の文は空のまま
      recognition.onstart?.()
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'こんばん' } }] })
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'こんばん' } }] })
    })

    expect(caption.sent).toEqual([{ type: 'interim', text: 'こんばん' }])
  })

  it('字幕の中継先につながらなければ、その理由を出し、つなぎ直せたら消す', async () => {
    const { deps, caption } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => caption.handlers?.onWarning('字幕の中継先につながりません'))
    expect(screen.getByText('字幕: 字幕の中継先につながりません')).toBeTruthy()

    await act(async () => caption.handlers?.onStatus('reconnected'))
    expect(screen.getByText('字幕: つながっている')).toBeTruthy()
  })

  it('オフにすると、字幕の中継先への接続も閉じる', async () => {
    const { deps, caption } = setup()
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => screen.getByRole('button', { name: '止める' }).click())

    expect(caption.closes).toBe(1)
  })

  it('別のタブが鍵を持っていれば、認識を始めずに待つ', async () => {
    const { deps, recognition, caption } = setup({ available: false })
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )

    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    expect(screen.getByText('状態: waiting')).toBeTruthy()
    expect(recognition.starts).toBe(0)
    // 字幕を送るのも認識しているタブだけ（2つのタブがつなぐと、片方の空の知らせがもう片方の字幕を消してしまう）
    expect(caption.connects).toBe(0)
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
