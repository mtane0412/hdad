/**
 * 音声認識の持続（recognizer.ts）のテスト
 *
 * Chrome の Web Speech API とマイクは使わず、呼ばれた操作を記録する代役に差し替える。
 * 代役の発火（fireStart・fireResult・fireError・fireEnd）で、Chrome が起こす出来事の順番を再現する。
 */
import { describe, expect, it } from 'vitest'
import { createRecognizer, type RecognitionLike, type RecognitionResultEvent, type RecognizerState } from './recognizer'

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
  /** start() で投げる失敗（Chrome は始まっている最中に start() を呼ぶと InvalidStateError を投げる） */
  startError: Error | null = null

  start(): void {
    this.starts += 1
    if (this.startError) throw this.startError
  }

  stop(): void {
    this.stops += 1
  }

  abort(): void {
    this.aborts += 1
  }

  fireStart(): void {
    this.onstart?.()
  }

  /** 結果の一覧のうち、resultIndex より後ろが今回変わったものとして届く */
  fireResult(resultIndex: number, results: readonly { text: string; isFinal: boolean }[]): void {
    this.onresult?.({
      resultIndex,
      results: results.map((result) => ({ isFinal: result.isFinal, 0: { transcript: result.text } })),
    })
  }

  fireError(error: string): void {
    this.onerror?.({ error })
  }

  fireEnd(): void {
    this.onend?.()
  }
}

/** 認識の代役と、マイクを開いた・閉じた回数と、マイクを失ったことを知らせる口を用意する */
const setup = () => {
  const recognition = new FakeRecognition()
  const microphone = { opened: 0, released: 0, lose: (): void => {} }
  let time = 0
  const states: RecognizerState[] = []
  const finals: string[] = []
  const recognizer = createRecognizer({
    createRecognition: () => recognition,
    openMicrophone: async (onLost) => {
      microphone.opened += 1
      microphone.lose = onLost
      return {
        release: () => {
          microphone.released += 1
        },
      }
    },
    now: () => time,
    onChange: (state) => states.push(state),
    onFinal: (text) => finals.push(text),
  })
  const latest = (): RecognizerState => {
    const state = states.at(-1)
    if (!state) throw new Error('状態がまだ一度も知らされていません')
    return state
  }
  const advance = (milliseconds: number): void => {
    time += milliseconds
  }
  return { recognition, microphone, recognizer, latest, finals, advance }
}

describe('createRecognizer', () => {
  it('始めるとマイクを開いたまま、日本語・連続・暫定ありで認識を始め、始まったら聞いている状態になる', async () => {
    const { recognition, microphone, recognizer, latest } = setup()

    await recognizer.start()
    // Chrome が認識を始めたと知らせるまでは、まだ始めている途中である
    expect(latest().status).toEqual({ kind: 'starting' })
    recognition.fireStart()

    expect(microphone.opened).toBe(1)
    expect(recognition).toMatchObject({ lang: 'ja-JP', continuous: true, interimResults: true, starts: 1 })
    expect(latest().status).toEqual({ kind: 'listening' })
  })

  it('確定した結果だけを前後の空白を落として渡し、暫定の結果は画面に出す文として持つ', async () => {
    const { recognition, recognizer, latest, finals } = setup()
    await recognizer.start()
    recognition.fireStart()

    // 1件目が確定し、2件目はまだ話している途中
    recognition.fireResult(0, [
      { text: ' こんばんは ', isFinal: true },
      { text: '今日は雑談', isFinal: false },
    ])

    expect(finals).toEqual(['こんばんは'])
    expect(latest().interim).toBe('今日は雑談')

    // 2件目が確定した。resultIndex より前の1件目はもう渡さない
    recognition.fireResult(1, [
      { text: ' こんばんは ', isFinal: true },
      { text: '今日は雑談をします', isFinal: true },
    ])

    expect(finals).toEqual(['こんばんは', '今日は雑談をします'])
    expect(latest().interim).toBe('')
  })

  it('空白だけの確定は渡さない', async () => {
    const { recognition, recognizer, finals } = setup()
    await recognizer.start()
    recognition.fireResult(0, [{ text: '  ', isFinal: true }])
    expect(finals).toEqual([])
  })

  it('勝手に終わったら待たずにすぐ始め直し、途切れていた時間とつなぎ直した回数を数える', async () => {
    const { recognition, recognizer, latest, advance } = setup()
    await recognizer.start()
    recognition.fireStart()

    // 黙っていたので Chrome が認識を終えた
    recognition.fireError('no-speech')
    recognition.fireEnd()

    expect(recognition.starts).toBe(2)
    expect(latest().status).toEqual({ kind: 'reconnecting', since: 0, reason: 'no-speech' })

    advance(300)
    recognition.fireStart()

    expect(latest()).toMatchObject({ status: { kind: 'listening' }, restarts: 1, interruptedMs: 300 })
  })

  it('マイクを使えない失敗では始め直さず、止まって理由を出し、マイクを閉じる', async () => {
    const { recognition, microphone, recognizer, latest } = setup()
    await recognizer.start()
    recognition.fireStart()

    recognition.fireError('not-allowed')
    recognition.fireEnd()

    expect(recognition.starts).toBe(1)
    expect(latest().status).toMatchObject({ kind: 'failed' })
    expect(microphone.released).toBe(1)
  })

  it('始め直しが1分のうちに続きすぎたら、回り続けないよう止めて理由を出す', async () => {
    const { recognition, recognizer, latest } = setup()
    await recognizer.start()

    // 通信の失敗で、始めてもすぐ終わるのを繰り返す
    for (let attempt = 0; attempt < 100 && latest().status.kind !== 'failed'; attempt += 1) {
      recognition.fireError('network')
      recognition.fireEnd()
    }

    expect(latest().status).toMatchObject({ kind: 'failed' })
    expect(recognition.starts).toBeLessThan(100)
  })

  it('始め直しの start() が投げたら、止まって理由を出す', async () => {
    const { recognition, recognizer, latest } = setup()
    await recognizer.start()
    recognition.fireStart()

    recognition.startError = new Error('InvalidStateError')
    recognition.fireEnd()

    expect(latest().status).toEqual({ kind: 'failed', message: '音声認識を始め直せませんでした: InvalidStateError' })
  })

  it('マイクが外れたら止まって理由を出す', async () => {
    const { recognition, microphone, recognizer, latest, finals } = setup()
    await recognizer.start()
    recognition.fireStart()

    microphone.lose()
    // 止めたあとで Chrome が遅れて知らせてくる終わりと結果は、止まった理由を上書きせず、発話としても渡さない
    recognition.fireResult(0, [{ text: '外れた後の発話', isFinal: true }])
    recognition.fireEnd()

    expect(recognition.stops).toBe(1)
    expect(latest().status).toEqual({ kind: 'failed', message: 'マイクが外れました。マイクがつながっているか確かめてください' })
    expect(finals).toEqual([])
  })

  it('止めたら始め直さず、Chrome が終えたところで止まった状態になってマイクを閉じる', async () => {
    const { recognition, microphone, recognizer, latest } = setup()
    await recognizer.start()
    recognition.fireStart()

    recognizer.stop()
    recognition.fireEnd()

    expect(recognition.stops).toBe(1)
    expect(recognition.starts).toBe(1)
    expect(latest().status).toEqual({ kind: 'stopped' })
    expect(microphone.released).toBe(1)
  })

  it('取りやめたら、話している途中の文を確定させずに捨て、すぐ止まった状態になってマイクを閉じる', async () => {
    const { recognition, microphone, recognizer, latest, finals } = setup()
    await recognizer.start()
    recognition.fireStart()
    recognition.fireResult(0, [{ text: 'もしもし', isFinal: false }])

    recognizer.abort()
    // 取りやめたあとに Chrome が遅れて届けた結果と終わりは受け取らない
    recognition.fireResult(0, [{ text: 'もしもし、いま配信中で', isFinal: true }])
    recognition.fireEnd()

    expect(recognition.aborts).toBe(1)
    expect(recognition.stops).toBe(0)
    expect(recognition.starts).toBe(1)
    expect(finals).toEqual([])
    expect(latest()).toMatchObject({ status: { kind: 'stopped' }, interim: '' })
    expect(microphone.released).toBe(1)
  })

  it('取りやめたあとに始めれば、マイクを開き直して認識を始める', async () => {
    const { recognition, microphone, recognizer, latest } = setup()
    await recognizer.start()
    recognition.fireStart()
    recognizer.abort()

    await recognizer.start()
    recognition.fireStart()

    expect(recognition.starts).toBe(2)
    expect(microphone.opened).toBe(2)
    expect(latest().status).toEqual({ kind: 'listening' })
  })

  it('マイクを開いている途中で止めたら、認識を始めずにマイクを閉じて止まった状態になる', async () => {
    const { recognition, microphone, recognizer, latest } = setup()

    const starting = recognizer.start()
    recognizer.stop()
    await starting

    expect(recognition.starts).toBe(0)
    expect(microphone.released).toBe(1)
    expect(latest().status).toEqual({ kind: 'stopped' })
  })

  it('マイクを開けなければ、止まって理由を出す', async () => {
    const states: RecognizerState[] = []
    const recognizer = createRecognizer({
      createRecognition: () => new FakeRecognition(),
      openMicrophone: async () => {
        throw new Error('Permission denied')
      },
      now: () => 0,
      onChange: (state) => states.push(state),
      onFinal: () => {},
    })

    await recognizer.start()

    expect(states.at(-1)?.status).toEqual({ kind: 'failed', message: 'マイクを開けませんでした: Permission denied' })
  })
})
