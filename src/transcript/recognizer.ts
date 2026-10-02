/**
 * アプリのページで動かす音声認識（Chrome の Web Speech API）を、配信の長さのあいだ切らさずに続ける
 *
 * 確定した発話を onFinal で1件ずつ渡し、状態（聞いている・途切れてつなぎ直している・止まった）と
 * 暫定の文・つなぎ直した回数・途切れていた時間の合計を onChange で知らせる。送るのは呼び出し側
 * （recognition-context.tsx）が受け持つ（issue #189）。
 *
 * Chrome の認識は、黙っている・通信が切れるなどで勝手に終わる（onend）。続けるための対策は2つ（issue #188）。
 * - 終わったら、タイマーを挟まずすぐ start() を呼ぶ。裏に回したタブではタイマーが抑えられ、つなぎ直しが遅れるため
 * - getUserMedia でマイクを開いたままにする。マイクを使っているタブは、Chrome が裏で凍らせる対象から外れるため
 *
 * 注意: マイクを使えない・言語が使えないなどの失敗では始め直さず止まり、理由を出す（Fail-Fast）。
 * 始め直しが短い間に続きすぎたときも、回り続けないよう止める（通信が切れていると始めてもすぐ終わる）。
 * 注意: Chrome と マイクは引数で受け取る。テストで差し替えるためである。
 */

/** 結果の1件（SpeechRecognitionResult のうち使う部分）。[0] が最も確からしい候補 */
export interface RecognitionResultLike {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}

/** onresult に届く出来事（SpeechRecognitionEvent のうち使う部分） */
export interface RecognitionResultEvent {
  /** results のうち、今回変わった最初の位置。これより前はもう確定して渡し済みである */
  readonly resultIndex: number
  readonly results: ArrayLike<RecognitionResultLike>
}

/**
 * SpeechRecognition のうち使う部分。
 *
 * 注意: TypeScript の DOM の型には、出来事の型はあっても SpeechRecognition そのものが無いので、ここで定義する。
 */
export interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

/** 開いたままにしているマイク */
export interface MicrophoneHold {
  release(): void
}

export type RecognizerStatus =
  | { kind: 'stopped' }
  /** start() を呼び、Chrome が始めたと知らせるのを待っている */
  | { kind: 'starting' }
  | { kind: 'listening' }
  /** 勝手に終わり、つなぎ直している。since は途切れた時刻、reason は直前の失敗（無ければ null） */
  | { kind: 'reconnecting'; since: number; reason: string | null }
  | { kind: 'failed'; message: string }

export interface RecognizerState {
  status: RecognizerStatus
  /** まだ確定していない、話している途中の文 */
  interim: string
  /** 始めてから勝手に終わってつなぎ直した回数 */
  restarts: number
  /** 始めてから途切れていた時間の合計（ミリ秒） */
  interruptedMs: number
}

export interface RecognizerOptions {
  createRecognition(): RecognitionLike
  /** マイクを開く。開いたマイクが外れたら onLost を呼ぶ */
  openMicrophone(onLost: () => void): Promise<MicrophoneHold>
  now(): number
  onChange(state: RecognizerState): void
  onFinal(text: string): void
}

export interface Recognizer {
  start(): Promise<void>
  stop(): void
}

const LANGUAGE = 'ja-JP'

/** つなぎ直しが回り続けていると見なす、1分あたりの回数。黙っているだけなら数秒ごとの終わりが続く程度である */
const MAX_RESTARTS_PER_MINUTE = 30
const MINUTE_MS = 60_000

/** 始め直しても直らない失敗（Chrome の SpeechRecognitionErrorCode のうち、設定や許可の誤り） */
const FATAL_ERRORS: Readonly<Record<string, string>> = {
  'not-allowed': 'マイクの使用が許可されていません。アドレスバーのサイトの設定でマイクを許可してください',
  'service-not-allowed': 'このブラウザでは音声認識の通信が許可されていません',
  'audio-capture': 'マイクから音を取れませんでした。マイクがつながっているか確かめてください',
  'language-not-supported': `音声認識が言語 ${LANGUAGE} に対応していません`,
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const createRecognizer = (options: RecognizerOptions): Recognizer => {
  const { now, onChange, onFinal } = options
  let state: RecognizerState = { status: { kind: 'stopped' }, interim: '', restarts: 0, interruptedMs: 0 }
  let recognition: RecognitionLike | null = null
  let microphone: MicrophoneHold | null = null
  /** 配信者が止めるまで続けるかどうか。止めた後や失敗の後に届く onend で始め直さないために持つ */
  let running = false
  /** 直前の onerror の値。続く onend で、始め直すかどうかと途切れた理由に使う */
  let lastError: string | null = null
  /** 直近1分に始め直した時刻 */
  let recentRestarts: number[] = []

  const update = (next: Partial<RecognizerState>): void => {
    state = { ...state, ...next }
    onChange(state)
  }

  const releaseMicrophone = (): void => {
    microphone?.release()
    microphone = null
  }

  /** 止めて理由を出す。Chrome の認識がまだ動いていれば止める */
  const fail = (message: string): void => {
    running = false
    recognition?.stop()
    releaseMicrophone()
    update({ status: { kind: 'failed', message }, interim: '' })
  }

  const handleResult = (event: RecognitionResultEvent): void => {
    let interim = ''
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]
      if (!result) continue
      if (!result.isFinal) {
        interim += result[0].transcript
        continue
      }
      const text = result[0].transcript.trim()
      if (text !== '') onFinal(text)
    }
    update({ interim: interim.trim() })
  }

  const handleEnd = (): void => {
    if (!running) {
      releaseMicrophone()
      update({ status: { kind: 'stopped' }, interim: '' })
      return
    }
    const fatal = lastError === null ? undefined : FATAL_ERRORS[lastError]
    if (fatal) {
      fail(fatal)
      return
    }
    const time = now()
    recentRestarts = [...recentRestarts.filter((at) => time - at < MINUTE_MS), time]
    if (recentRestarts.length > MAX_RESTARTS_PER_MINUTE) {
      fail(`音声認識が1分のうちに${MAX_RESTARTS_PER_MINUTE}回を超えて途切れたので止めました（直前の失敗: ${lastError ?? 'なし'}）`)
      return
    }
    // 途切れたのが続けて起きたなら、最初に途切れた時刻を残す（途切れていた時間を短く数えないため）
    const since = state.status.kind === 'reconnecting' ? state.status.since : time
    update({ status: { kind: 'reconnecting', since, reason: lastError }, interim: '', restarts: state.restarts + 1 })
    lastError = null
    try {
      // 裏に回ったタブではタイマーが抑えられるので、待たずにこの場で始め直す
      recognition?.start()
    } catch (error) {
      fail(`音声認識を始め直せませんでした: ${errorMessage(error)}`)
    }
  }

  const handleStart = (): void => {
    if (!running) return
    const interrupted = state.status.kind === 'reconnecting' ? now() - state.status.since : 0
    update({ status: { kind: 'listening' }, interruptedMs: state.interruptedMs + interrupted })
  }

  return {
    async start() {
      if (running) return
      running = true
      lastError = null
      recentRestarts = []
      update({ status: { kind: 'starting' }, interim: '', restarts: 0, interruptedMs: 0 })
      try {
        microphone = await options.openMicrophone(() => {
          if (running) fail('マイクが外れました。マイクがつながっているか確かめてください')
        })
      } catch (error) {
        fail(`マイクを開けませんでした: ${errorMessage(error)}`)
        return
      }
      // マイクを開いているあいだに止められた
      if (!running) {
        releaseMicrophone()
        update({ status: { kind: 'stopped' } })
        return
      }
      const created = options.createRecognition()
      created.lang = LANGUAGE
      created.continuous = true
      created.interimResults = true
      created.onstart = handleStart
      created.onresult = handleResult
      created.onerror = (event) => {
        lastError = event.error
      }
      created.onend = handleEnd
      recognition = created
      try {
        created.start()
      } catch (error) {
        fail(`音声認識を始められませんでした: ${errorMessage(error)}`)
      }
    },
    stop() {
      if (!running) return
      running = false
      // 止めると Chrome が onend を呼ぶので、そこで止まった状態にしてマイクを閉じる
      recognition?.stop()
    },
  }
}
