/**
 * アプリの枠で動かす音声認識（issue #189）
 *
 * アプリのページはどれも1つの React アプリで、ページを移っても読み込み直さない（router.tsx）。認識をページではなく
 * 枠（app.tsx の Shell）に置くことで、どのページを見ていても認識が続く。状態はサイドバー（recognition-status.tsx）に、
 * オン・オフと詳しい様子はコネクターのページの区画（recognition-section.tsx）に出す。
 *
 * - オン・オフはこのブラウザの localStorage に覚える。開き直したときに、オンなら開いただけで始め直す
 *   （別の端末でアプリを開いても、そこで勝手に認識を始めない）
 * - 認識するのは、タブ間の鍵（Web Locks の hdad-transcript-recognition）を取れた1つのタブだけにする。
 *   アプリを2つのタブで開いて両方が認識すると、同じ発話が二重に記録されるためである。鍵を待つタブは、
 *   認識しているタブが閉じられたら代わりに始める
 * - ほかのタブでオン・オフを切り替えたら、storage の出来事で知り、このタブも合わせる
 * - 認識しているタブは、話している途中の文と確定した文を字幕の中継先へも送る（issue #190。合成ページの字幕の素材が映す）。
 *   途中の文は変わったときだけ送り、空になったことも送る（字幕から消すため）。字幕は流れていくものなので、
 *   つながっていないあいだの分は貯めずに落とす
 *
 * 注意: Chrome の音声認識・マイク・鍵・localStorage・Worker への送信は deps で受け取る（テストで差し替えるため）。
 * ブラウザのものは browserRecognitionDeps が組み立てる。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { connectCaptionWriter, type CaptionSocketHandlers, type CaptionWriter } from '../caption/socket'
import type { TranscriptApi } from './api'
import { createTranscriptDelivery, type DeliveredLine } from './delivery'
import { createRecognizer, type MicrophoneHold, type RecognitionLike, type RecognizerState } from './recognizer'

/** オン・オフを覚えておく localStorage の名前 */
const STORAGE_KEY = 'hdad:transcript-recognition'

/** 認識するタブを1つに決めるための、タブ間の鍵の名前 */
const LOCK_NAME = 'hdad-transcript-recognition'

export interface RecognitionDeps {
  api: TranscriptApi
  /** 認識を作る。このブラウザに音声認識が無ければ null */
  createRecognition: (() => RecognitionLike) | null
  openMicrophone(onLost: () => void): Promise<MicrophoneHold>
  /** タブ間の鍵（navigator.locks のうち使う部分） */
  locks: { request(name: string, options: { signal: AbortSignal }, callback: () => Promise<void>): Promise<void> }
  storage: Pick<Storage, 'getItem' | 'setItem'>
  /** 字幕の中継先へ送る側としてつなぐ */
  connectCaption(handlers: CaptionSocketHandlers): CaptionWriter
}

/**
 * このタブで認識がどこまで進んでいるか。
 * - off: オフにしてある
 * - unsupported: オンだが、このブラウザに音声認識が無い
 * - waiting: オンだが、別のタブが認識している（鍵を待っている）
 * - running: このタブが認識している（詳しい状態は recognizer）
 * - failed: 鍵を取れなかった（error に理由）
 */
export type RecognitionPhase = 'off' | 'unsupported' | 'waiting' | 'running' | 'failed'

export interface RecognitionContextValue {
  enabled: boolean
  setEnabled(enabled: boolean): void
  /** 止まってしまった認識を始め直す（マイクの許可を求めるのは、ボタンを押したときでないと通らないことがある） */
  restart(): void
  phase: RecognitionPhase
  /** phase が failed のときの理由 */
  error: string | null
  recognizer: RecognizerState
  /** 送った発話（新しいものが先頭） */
  lines: readonly DeliveredLine[]
  /** 字幕の中継先へ送れていない理由（送れているか、認識していなければ null） */
  captionWarning: string | null
}

const INITIAL_RECOGNIZER_STATE: RecognizerState = { status: { kind: 'stopped' }, interim: '', restarts: 0, interruptedMs: 0 }

const RecognitionContext = createContext<RecognitionContextValue | null>(null)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 音声認識の状態を読む。RecognitionProvider の内側でしか使えない */
export const useRecognition = (): RecognitionContextValue => {
  const value = useContext(RecognitionContext)
  if (!value) throw new Error('useRecognition は RecognitionProvider の内側で使ってください')
  return value
}

export const RecognitionProvider = ({ deps, children }: { deps: RecognitionDeps; children: React.ReactNode }) => {
  const [enabled, setEnabledState] = useState(() => deps.storage.getItem(STORAGE_KEY) === 'on')
  /** 始め直すたびに増やし、鍵の取り直しから走らせ直す */
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<RecognitionPhase>(enabled ? 'waiting' : 'off')
  const [error, setError] = useState<string | null>(null)
  const [recognizer, setRecognizer] = useState<RecognizerState>(INITIAL_RECOGNIZER_STATE)
  const [lines, setLines] = useState<readonly DeliveredLine[]>([])
  const [captionWarning, setCaptionWarning] = useState<string | null>(null)

  const delivery = useMemo(
    () =>
      createTranscriptDelivery({
        api: deps.api,
        createId: () => crypto.randomUUID(),
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        onChange: setLines,
      }),
    [deps.api],
  )

  const setEnabled = useCallback(
    (next: boolean) => {
      deps.storage.setItem(STORAGE_KEY, next ? 'on' : 'off')
      setEnabledState(next)
    },
    [deps.storage],
  )

  // ほかのタブで切り替えたオン・オフに合わせる（storage の出来事は、書いたタブ以外にだけ届く）
  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === STORAGE_KEY) setEnabledState(event.newValue === 'on')
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setPhase('off')
      return
    }
    const { createRecognition } = deps
    if (!createRecognition) {
      setPhase('unsupported')
      return
    }
    const controller = new AbortController()
    let running: ReturnType<typeof createRecognizer> | null = null
    let caption: CaptionWriter | null = null
    let releaseLock: (() => void) | null = null
    setPhase('waiting')
    setError(null)
    deps.locks
      .request(LOCK_NAME, { signal: controller.signal }, async () => {
        if (controller.signal.aborted) return
        setPhase('running')
        const writer = deps.connectCaption({
          onStatus: (status) => setCaptionWarning(status === 'disconnected' ? '字幕の中継先との接続が切れました。つなぎ直しています' : null),
          onWarning: setCaptionWarning,
        })
        caption = writer
        /** 最後に送った話している途中の文。状態は途中の文のほかにも変わるので、変わったときだけ送る */
        let sentInterim = ''
        running = createRecognizer({
          createRecognition,
          openMicrophone: (onLost) => deps.openMicrophone(onLost),
          now: () => Date.now(),
          onChange: (state) => {
            setRecognizer(state)
            if (state.interim === sentInterim) return
            sentInterim = state.interim
            writer.send({ type: 'interim', text: state.interim })
          },
          onFinal: (text) => {
            writer.send({ type: 'final', text })
            void delivery.deliver(text)
          },
        })
        void running.start()
        // オフにする・始め直す・枠が消えるまで鍵を持ち続ける
        await new Promise<void>((resolve) => {
          releaseLock = resolve
        })
      })
      .catch((reason: unknown) => {
        // 片付けで鍵の待ちを取り消したときの失敗は、知らせるものではない
        if (controller.signal.aborted) return
        setPhase('failed')
        setError(`ほかのタブと認識を分け合えませんでした: ${errorMessage(reason)}`)
      })
    return () => {
      controller.abort()
      running?.stop()
      caption?.close()
      setCaptionWarning(null)
      releaseLock?.()
    }
  }, [enabled, attempt, deps, delivery])

  const value = useMemo<RecognitionContextValue>(
    () => ({ enabled, setEnabled, restart: () => setAttempt((current) => current + 1), phase, error, recognizer, lines, captionWarning }),
    [enabled, setEnabled, phase, error, recognizer, lines, captionWarning],
  )
  return <RecognitionContext.Provider value={value}>{children}</RecognitionContext.Provider>
}

/** Chrome の音声認識の作り方。標準の名前が無い Chrome では webkit 付きの名前で探す */
const findRecognitionConstructor = (): (new () => RecognitionLike) | null => {
  const candidates: unknown[] = [Reflect.get(window, 'SpeechRecognition'), Reflect.get(window, 'webkitSpeechRecognition')]
  const found = candidates.find((candidate) => typeof candidate === 'function')
  // 見つけたのはブラウザの SpeechRecognition なので、使う部分（RecognitionLike）を持っている
  return found ? (found as new () => RecognitionLike) : null
}

/**
 * このブラウザの音声認識・マイク・鍵・localStorage と、Worker への送信を組み立てる。
 *
 * 注意: タブ間の鍵（navigator.locks）が無いブラウザ（https でないページなど）では、音声認識があっても
 * 使えないものとして扱う（createRecognition を null にする）。鍵なしで認識すると、2つのタブで二重に記録してしまうためである。
 */
export const browserRecognitionDeps = (api: TranscriptApi): RecognitionDeps => {
  const Recognition = findRecognitionConstructor()
  // DOM の型では navigator.locks は必ずあることになっているが、実際には無いブラウザがある
  const hasLocks: boolean = Reflect.get(navigator, 'locks') !== undefined
  return {
    api,
    createRecognition: Recognition && hasLocks ? () => new Recognition() : null,
    async openMicrophone(onLost) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', onLost)
      return {
        release: () => {
          for (const track of stream.getTracks()) track.stop()
        },
      }
    },
    locks: navigator.locks,
    storage: window.localStorage,
    connectCaption: connectCaptionWriter,
  }
}
