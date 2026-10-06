// @vitest-environment jsdom
/**
 * アプリの枠で動かす音声認識（recognition-context.tsx）のテスト
 *
 * Chrome の音声認識・マイク・タブ間の鍵（Web Locks）・Worker への送信は代役に差し替える。
 * 確かめるのは、オン・オフが覚えられること、鍵を取れたタブだけが認識すること、確定した発話が Worker へ送られること、
 * 話している途中の文と確定した文が字幕の中継先へ送られること（issue #190）、確定した文を直前の2件と一緒に訳してもらい、
 * 訳文を字幕の中継先へ送ること（issue #191）。OBS でマイクをミュートしたら認識を取りやめ、解除したら始め直すこと（issue #270）。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptionSocketHandlers } from '../caption/socket'
import type { CaptionMessage } from '../caption/message'
import type { TranscriptApi } from './api'
import type { ObsMuteState } from './obs-mute'
import type { TranslationApi } from './translation-api'
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
  aborts = 0

  start(): void {
    this.starts += 1
  }

  stop(): void {
    this.stops += 1
  }

  abort(): void {
    this.aborts += 1
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

/** 頼まれた訳を残し、決めた結果を返す翻訳の代役 */
const createTranslation = (result: (text: string) => Promise<string | null>) => {
  const requests: { text: string; context: readonly string[] }[] = []
  const translation: TranslationApi = {
    translate: (text, context) => {
      requests.push({ text, context })
      return result(text)
    },
  }
  return { translation, requests }
}

const setup = ({
  available = true,
  supported = true,
  translate = (): Promise<string | null> => Promise.resolve(null),
}: { available?: boolean; supported?: boolean; translate?: (text: string) => Promise<string | null> } = {}) => {
  const recognition = new FakeRecognition()
  const sent: { messageId: string; text: string }[] = []
  const api: TranscriptApi = {
    async send(messageId, text) {
      sent.push({ messageId, text })
      return true
    },
  }
  const { locks, requested } = createLocks(available)
  const { translation, requests: translationRequests } = createTranslation(translate)
  const microphone = { released: 0 }
  /** 字幕の中継先への接続の代役。送ったものと、閉じた回数と、つなぐときに渡された受け口を残す */
  const caption = { connects: 0, closes: 0, sent: [] as CaptionMessage[], handlers: null as CaptionSocketHandlers | null }
  /** OBS のミュートの見張りの代役。見張った入力の名前と、状態を知らせる口と、やめた回数を残す */
  const notWatchedYet: (state: ObsMuteState) => void = () => {}
  const obsMute = { inputNames: [] as string[], report: notWatchedYet, stops: 0 }
  const deps: RecognitionDeps = {
    api,
    translation,
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
    watchObsMute: (inputName, onChange) => {
      obsMute.inputNames.push(inputName)
      obsMute.report = onChange
      return {
        stop: () => {
          obsMute.stops += 1
        },
      }
    },
  }
  return { deps, recognition, sent, requested, microphone, caption, translationRequests, obsMute }
}

/** 文脈の中身を画面に出し、オン・オフを切り替えるボタンを置く */
const Probe = () => {
  const { enabled, setEnabled, phase, recognizer, lines, captionWarning, translationWarning, obsMute, setObsMuteInputName } = useRecognition()
  return (
    <div>
      <p>状態: {phase}</p>
      <p>OBSのミュート: {obsMute === null ? '見張っていない' : `${obsMute.state.kind}・${obsMute.muted ? 'ミュート中' : '音あり'}`}</p>
      <p>字幕: {captionWarning ?? 'つながっている'}</p>
      <p>翻訳: {translationWarning ?? '問題なし'}</p>
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
      <button type="button" onClick={() => setObsMuteInputName('マイク')}>
        OBSのマイクを見張る
      </button>
    </div>
  )
}

const STORAGE_KEY = 'hdad:transcript-recognition'
const OBS_MUTE_INPUT_KEY = 'hdad:transcript-obs-mute-input'

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
      { type: 'final', id: expect.any(String), text: 'こんばんは、今日は' },
      // 確定したので、話している途中の文が無くなったことも知らせる
      { type: 'interim', text: '' },
    ])
  })

  it('確定した文を直前の2件と一緒に訳してもらい、訳文を同じIDで字幕の中継先へ送る', async () => {
    const english: Record<string, string> = { こんばんは: 'Good evening', 配信はじめます: "Let's start the stream", ボスに挑みます: "I'll take on the boss" }
    const { deps, recognition, caption, translationRequests } = setup({ translate: (text) => Promise.resolve(english[text] ?? null) })
    render(
      <RecognitionProvider deps={deps}>
        <Probe />
      </RecognitionProvider>,
    )
    await act(async () => screen.getByRole('button', { name: '始める' }).click())

    await act(async () => {
      recognition.onstart?.()
      for (const text of ['こんばんは', '配信はじめます', 'ボスに挑みます']) {
        recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] })
      }
    })

    expect(translationRequests).toEqual([
      { text: 'こんばんは', context: [] },
      { text: '配信はじめます', context: ['こんばんは'] },
      { text: 'ボスに挑みます', context: ['こんばんは', '配信はじめます'] },
    ])
    const finals = caption.sent.filter((message) => message.type === 'final')
    const translations = caption.sent.filter((message) => message.type === 'translation')
    expect(translations).toEqual([
      { type: 'translation', id: finals[0]?.id, text: 'Good evening' },
      { type: 'translation', id: finals[1]?.id, text: "Let's start the stream" },
      { type: 'translation', id: finals[2]?.id, text: "I'll take on the boss" },
    ])
    expect(new Set(finals.map(({ id }) => id)).size).toBe(3)
  })

  it('訳さない設定なら、訳文を送らない', async () => {
    const { deps, recognition, caption } = setup()
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

    expect(caption.sent.filter((message) => message.type === 'translation')).toEqual([])
  })

  it('訳せなかったら理由を出し（原文の字幕と記録は止めない）、次に訳せたら消す', async () => {
    let fail = true
    const { deps, recognition, caption, sent } = setup({
      translate: () => (fail ? Promise.reject(new Error('DeepL が失敗を返しました（456）')) : Promise.resolve('Good evening')),
    })
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

    expect(screen.getByText('翻訳: 字幕の翻訳に失敗しました: DeepL が失敗を返しました（456）')).toBeTruthy()
    expect(caption.sent).toContainEqual({ type: 'final', id: expect.any(String), text: 'こんばんは' })
    expect(sent).toHaveLength(1)

    fail = false
    await act(async () => {
      recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'こんばんは' } }] })
    })

    expect(screen.getByText('翻訳: 問題なし')).toBeTruthy()
  })

  it('オフにしたあとに届いた訳の結果は、警告にも字幕にも使わない', async () => {
    let rejectLate: (reason: Error) => void = () => {}
    const { deps, recognition, caption } = setup({
      translate: () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectLate = reject
        }),
    })
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

    // 前提: 訳を待っているあいだにオフにする
    await act(async () => screen.getByRole('button', { name: '止める' }).click())
    await act(async () => rejectLate(new Error('DeepL が失敗を返しました（456）')))

    expect(screen.getByText('翻訳: 問題なし')).toBeTruthy()
    expect(caption.sent.filter((message) => message.type === 'translation')).toEqual([])
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

  describe('OBS のマイクのミュート（issue #270）', () => {
    /** 見張る入力を決めてからオンにし、ミュートしていない状態まで進める */
    const startWatching = async (setupResult: ReturnType<typeof setup>) => {
      window.localStorage.setItem(OBS_MUTE_INPUT_KEY, 'マイク')
      render(
        <RecognitionProvider deps={setupResult.deps}>
          <Probe />
        </RecognitionProvider>,
      )
      await act(async () => screen.getByRole('button', { name: '始める' }).click())
      await act(async () => setupResult.obsMute.report({ kind: 'watching', muted: false }))
    }

    it('見張る入力の名前が空なら、OBS を見張らない', async () => {
      const { deps, obsMute } = setup()
      render(
        <RecognitionProvider deps={deps}>
          <Probe />
        </RecognitionProvider>,
      )

      await act(async () => screen.getByRole('button', { name: '始める' }).click())

      expect(obsMute.inputNames).toEqual([])
      expect(screen.getByText('OBSのミュート: 見張っていない')).toBeTruthy()
    })

    it('見張る入力の名前を覚え、認識しているタブがその入力を見張る', async () => {
      const { deps, obsMute } = setup()
      render(
        <RecognitionProvider deps={deps}>
          <Probe />
        </RecognitionProvider>,
      )
      await act(async () => screen.getByRole('button', { name: '始める' }).click())

      await act(async () => screen.getByRole('button', { name: 'OBSのマイクを見張る' }).click())

      expect(window.localStorage.getItem(OBS_MUTE_INPUT_KEY)).toBe('マイク')
      expect(obsMute.inputNames).toEqual(['マイク'])
    })

    it('別のタブが認識しているあいだは、OBS を見張らない', async () => {
      window.localStorage.setItem(OBS_MUTE_INPUT_KEY, 'マイク')
      const { deps, obsMute } = setup({ available: false })
      render(
        <RecognitionProvider deps={deps}>
          <Probe />
        </RecognitionProvider>,
      )

      await act(async () => screen.getByRole('button', { name: '始める' }).click())

      expect(obsMute.inputNames).toEqual([])
    })

    it('ミュートしたら話している途中の文を捨てて認識を取りやめ、字幕からも消す', async () => {
      const result = setup()
      await startWatching(result)
      await act(async () => {
        result.recognition.onstart?.()
        result.recognition.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'もしもし' } }] })
      })

      await act(async () => result.obsMute.report({ kind: 'watching', muted: true }))

      expect(result.recognition.aborts).toBe(1)
      expect(result.caption.sent.at(-1)).toEqual({ type: 'interim', text: '' })
      expect(screen.getByText('OBSのミュート: watching・ミュート中')).toBeTruthy()
    })

    it('ミュートを解除したら、認識を始め直す', async () => {
      const result = setup()
      await startWatching(result)
      await act(async () => result.obsMute.report({ kind: 'watching', muted: true }))

      await act(async () => result.obsMute.report({ kind: 'watching', muted: false }))

      expect(result.recognition.starts).toBe(2)
      expect(screen.getByText('OBSのミュート: watching・音あり')).toBeTruthy()
    })

    it('ミュートしているあいだに OBS を見張れなくなっても、解除が分かるまで認識を始めない', async () => {
      // 通話中に OBS が落ちても、通話の声を字幕に出さないため
      const result = setup()
      await startWatching(result)
      await act(async () => result.obsMute.report({ kind: 'watching', muted: true }))

      await act(async () => result.obsMute.report({ kind: 'failed', message: 'ws://localhost:4455 との接続が切れました' }))

      expect(result.recognition.starts).toBe(1)
      expect(screen.getByText('OBSのミュート: failed・ミュート中')).toBeTruthy()
    })

    it('ミュートしていないときに OBS を見張れなくなっても、認識は続ける', async () => {
      const result = setup()
      await startWatching(result)

      await act(async () => result.obsMute.report({ kind: 'failed', message: 'ws://localhost:4455 につながりませんでした' }))

      expect(result.recognition.aborts).toBe(0)
      expect(screen.getByText('OBSのミュート: failed・音あり')).toBeTruthy()
    })

    it('オフにすると見張りをやめる', async () => {
      const result = setup()
      await startWatching(result)

      await act(async () => screen.getByRole('button', { name: '止める' }).click())

      expect(result.obsMute.stops).toBe(1)
      expect(screen.getByText('OBSのミュート: 見張っていない')).toBeTruthy()
    })
  })
})

describe('browserRecognitionDeps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const api: TranscriptApi = { send: () => Promise.resolve(true) }
  const { translation } = createTranslation(() => Promise.resolve(null))
  const loadObsSettings = () => Promise.resolve({ host: 'localhost', port: 4455, password: '' })

  it('音声認識があり、タブ間の鍵も使えるブラウザでは、認識を作れる', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
    vi.stubGlobal('navigator', { ...navigator, locks: createLocks(true).locks })

    expect(browserRecognitionDeps(api, translation, loadObsSettings).createRecognition).not.toBeNull()
  })

  it('音声認識があっても、タブ間の鍵（Web Locks）が無ければ使えないものとして扱う', () => {
    // 前提: https でないページなどでは navigator.locks が無い
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition)
    vi.stubGlobal('navigator', { ...navigator, locks: undefined })

    expect(browserRecognitionDeps(api, translation, loadObsSettings).createRecognition).toBeNull()
  })
})
