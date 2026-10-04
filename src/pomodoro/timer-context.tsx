/**
 * アプリの枠で持つ、ポモドーロのタイマー（issue #237）
 *
 * ポモドーロは下部バー（pomodoro-bar.tsx）とポモドーロのページ（pomodoro-page.tsx）の2か所で操作する。
 * どちらも同じタイマーを映すように、タイマーと押し出しの接続をこの Provider だけが持ち、アプリの枠（app.tsx の Shell）に置く。
 * ページを移っても枠は作り直されないので、接続は1本のまま続く（BGM の player-context.tsx と同じ形）。
 *
 * - 開いたときに Worker から読み、別の窓での操作や、配信していないときの区切りで Worker が止めたことは、
 *   合成ページと同じ押し出し（socket.ts）で受け取る
 * - つなぎ直したら読み直す（つながっていない間に変わっていたかもしれないため）
 * - 操作は Worker へ送り、返ってきたタイマーを映す。断られたのは画面の状態が古いためなので、今の状態を読み直してから
 *   投げ直す（理由の出し方は呼び出し側が決める）
 *
 * 区間と残り時間はここでは持たず、使う側が現在時刻を渡して phase.ts の phaseAt で計算する。
 *
 * 注意: 操作の応答（HTTP）は Worker が押し出したあとに返るので、別の窓の操作によるもっと新しい押し出しより遅れて届くことがある。
 *   押し出しが届くたび・タイマーを取りに行くたびに世代を進め、取りに行ったときから世代が進んでいたら、その応答は古いので映さない。
 * 注意: 読めなかったとき・押し出しを受け取れていないときは、黙らずに理由を持つ（Fail-Fast。表示は使う側）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import type { PomodoroApi, PomodoroCommand } from './api'
import { parsePomodoroSnapshot, type PomodoroTimer } from './phase'

/** 押し出しの接続から受け取るもの（src/core/socket.ts の SocketHandlers と同じ形） */
export interface PomodoroWatchHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** タイマーの押し出しにつなぐ（本番は socket.ts の connectPomodoroWatch） */
export type PomodoroConnect = (overlayKey: string, handlers: PomodoroWatchHandlers) => { close(): void }

export type PomodoroLoaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export interface PomodoroTimerValue {
  loaded: PomodoroLoaded
  /** いまのタイマー。止めていれば null */
  timer: PomodoroTimer | null
  /** 押し出しを受け取れていない理由（オーバーレイ用キーが無いときを含む）。受け取れていれば null */
  watchNotice: string | null
  /**
   * タイマーを操作し、操作したあとのタイマーを返す（止めたら null）。
   *
   * @throws 断られた・届かなかった場合（今の状態を読み直してから投げる）
   */
  control(command: PomodoroCommand): Promise<PomodoroTimer | null>
}

/** キーが無くて押し出しにつなげないときの知らせ */
const NO_OVERLAY_KEY_NOTICE = 'オーバーレイ用キーが未発行のため、別の窓での操作や配信の終了で止まったことを映せません'

/** 押し出しが切れているときの知らせ */
const DISCONNECTED_NOTICE = 'ポモドーロのタイマーの変化を受け取れていません。つなぎ直しています'

/** そのタイマーで押せる操作。止めていれば始めるだけ、動いていれば一時停止と止める、一時停止中なら再開と止める */
export const commandsOf = (timer: PomodoroTimer | null): PomodoroCommand[] => {
  if (timer === null) return ['start']
  return timer.pausedAt === null ? ['pause', 'stop'] : ['resume', 'stop']
}

const PomodoroTimerContext = createContext<PomodoroTimerValue | null>(null)

export const PomodoroTimerProvider = ({
  api,
  overlayKey,
  connect,
  children,
}: {
  api: PomodoroApi
  /** ログイン中の配信者のオーバーレイ用キー。押し出しの経路はこのキーで守られている。未発行なら null */
  overlayKey: string | null
  connect: PomodoroConnect
  children: React.ReactNode
}) => {
  const [loaded, setLoaded] = useState<PomodoroLoaded>({ status: 'loading' })
  const [timer, setTimer] = useState<PomodoroTimer | null>(null)
  const [watchProblem, setWatchProblem] = useState<string | null>(null)

  /** タイマーの世代（冒頭の注意を参照） */
  const revision = useRef(0)

  /** タイマーを取りに行く直前・押し出しを受けたときに呼ぶ。返した関数は、応答を映してよい（あいだに新しいものが届いていない）かを答える */
  const beginRevision = useCallback((): (() => boolean) => {
    revision.current += 1
    const current = revision.current
    return () => current === revision.current
  }, [])

  /** Worker からタイマーを読み、あいだに新しいものが届いていなければ映す */
  const reload = useCallback(async (): Promise<void> => {
    const isLatest = beginRevision()
    const { timer: next } = await api.read()
    if (isLatest()) setTimer(next)
  }, [api, beginRevision])

  useEffect(() => {
    let cancelled = false
    reload().then(
      () => {
        if (!cancelled) setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [reload])

  // 別の窓での操作・配信していないときの区切りで止めたことを、合成ページと同じ押し出しで受け取る
  useEffect(() => {
    // キーが無ければつなげない（知らせは watchNotice が受け持つ）
    if (overlayKey === null) return
    // 閉じたあと（キーが変わった・枠が消えた）に読み直しの結果が届いても映さない
    let cancelled = false
    const connection = connect(overlayKey, {
      onMessage: (text) => {
        try {
          const next = parsePomodoroSnapshot(text)
          beginRevision()
          setTimer(next)
          setWatchProblem(null)
        } catch (error) {
          setWatchProblem(errorMessage(error))
        }
      },
      onStatus: (status) => {
        if (status === 'disconnected') {
          setWatchProblem(DISCONNECTED_NOTICE)
          return
        }
        // つながっていない間に変わっていたかもしれないので読み直す。開いたときに読めなかった場合も、ここで読めたら立ち直る
        reload().then(
          () => {
            if (cancelled) return
            setLoaded({ status: 'ready' })
            setWatchProblem(null)
          },
          (error: unknown) => {
            if (!cancelled) setWatchProblem(errorMessage(error))
          },
        )
      },
      onWarning: (message) => setWatchProblem(message),
    })
    return () => {
      cancelled = true
      connection.close()
    }
  }, [connect, overlayKey, beginRevision, reload])

  const value = useMemo<PomodoroTimerValue>(
    () => ({
      loaded,
      timer,
      watchNotice: overlayKey === null ? NO_OVERLAY_KEY_NOTICE : watchProblem,
      control: async (command) => {
        const isLatest = beginRevision()
        try {
          const next = await api.control(command)
          if (isLatest()) setTimer(next)
          return next
        } catch (error) {
          // 断られたのは画面の状態が古いためなので、今の状態を読み直してから投げ直す。
          // 読み直しの失敗は、元の理由（断られた理由）を隠さないよう捨てる
          await reload().catch(() => undefined)
          throw error
        }
      },
    }),
    [api, beginRevision, loaded, overlayKey, reload, timer, watchProblem],
  )

  return <PomodoroTimerContext.Provider value={value}>{children}</PomodoroTimerContext.Provider>
}

/** ポモドーロのタイマーを読む。PomodoroTimerProvider の内側で使う */
export const usePomodoroTimer = (): PomodoroTimerValue => {
  const value = useContext(PomodoroTimerContext)
  if (value === null) throw new Error('usePomodoroTimer は PomodoroTimerProvider の内側で使ってください')
  return value
}

/** 残り時間を描き直す間隔（ミリ秒）。秒まで出すので1秒ごと */
const TICK_MS = 1000

/**
 * タイマーが動いているあいだだけ、1秒ごとに描き直させる。
 *
 * 残り時間は描くたびに現在時刻から計算するので、ここは描き直しのきっかけだけを作る。
 */
export const useSecondTick = (timer: PomodoroTimer | null): void => {
  const [, setTick] = useState(0)
  const running = timer !== null && timer.pausedAt === null
  useEffect(() => {
    if (!running) return
    const interval = setInterval(() => setTick((tick) => tick + 1), TICK_MS)
    return () => clearInterval(interval)
  }, [running])
}
