/**
 * OBS のマイクのミュートの見張り
 *
 * 電話などで OBS のマイクをミュートしたときに、文字起こしも一緒に止めるため（OBSと文字起こしの2か所を
 * 切り替えなくて済むようにする）、指定した OBS の入力がミュートかどうかを知らせ続ける。止めるのは呼び出し側
 * （recognition-context.tsx）が受け持ち、ここは見張るだけである。
 *
 * - つないだら GetInputMute でいまのミュートを問い合わせ、そのあとは InputMuteStateChanged で切り替わりを知る
 * - つながらない・入力が無い・切れたときは理由を知らせ、OBS_MUTE_RETRY_MS を置いてつなぎ直す。
 *   OBS を起動する前にアプリを開くことも多いので、1回の失敗で諦めない
 *
 * 注意: OBS への接続（設定の読み出しと WebSocket）は connect で受け取る。テストで差し替えるためである。
 * 注意: 見張れていないあいだ（つなぐ途中・失敗）は、ミュートかどうかを決めつけない。どう扱うかは呼び出し側が決める。
 */
import type { ObsConnection } from '../screen/connection'

/** つなぎ直すまでの間（ミリ秒）。OBS を起動したら、この間のうちに見張りが始まる */
export const OBS_MUTE_RETRY_MS = 10_000

/**
 * 見張りの状態。
 * - connecting: はじめてつなぎに行っている
 * - watching: つながっていて、指定した入力のミュートが分かっている
 * - failed: 見張れていない（message に理由）。間を置いてつなぎ直している
 */
export type ObsMuteState = { kind: 'connecting' } | { kind: 'watching'; muted: boolean } | { kind: 'failed'; message: string }

/** つなぐときに渡す受け口 */
export interface ObsMuteConnectHandlers {
  /** つながったあとに OBS で起きた出来事 */
  onEvent(eventType: string, data: Record<string, unknown>): void
  /** つながったあとに切れた */
  onClose(error: Error): void
}

export interface ObsMuteWatcherOptions {
  /** 見張る OBS の入力の名前（音声ミキサーに出ている名前） */
  inputName: string
  /** OBS へつなぐ。設定の読み出しも含む */
  connect(handlers: ObsMuteConnectHandlers): Promise<ObsConnection>
  onChange(state: ObsMuteState): void
}

export interface ObsMuteWatcher {
  /** 見張りをやめ、接続を閉じる。そのあとは何も知らせない */
  stop(): void
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * OBS の出来事が、指定した入力のミュートの切り替えかどうかを読む。
 *
 * @returns 指定した入力の切り替えならミュートかどうか。関係のない出来事なら null
 * @throws 指定した入力の切り替えなのに、ミュートかどうかが読めない場合
 */
export const mutedOfEvent = (eventType: string, data: Record<string, unknown>, inputName: string): boolean | null => {
  if (eventType !== 'InputMuteStateChanged' || data.inputName !== inputName) return null
  if (typeof data.inputMuted !== 'boolean') throw new Error(`OBS の「${inputName}」のミュートの切り替えに inputMuted がありません`)
  return data.inputMuted
}

/** 見張りを始める */
export const watchObsMute = ({ inputName, connect, onChange }: ObsMuteWatcherOptions): ObsMuteWatcher => {
  let stopped = false
  let connection: ObsConnection | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** つなぎに行った回数。古い接続から遅れて届いた知らせを見分けるために使う */
  let attempt = 0

  /** 見張れていないことを知らせ、間を置いてつなぎ直す */
  const failAndRetry = (message: string): void => {
    connection?.close()
    connection = null
    onChange({ kind: 'failed', message })
    retryTimer = setTimeout(() => {
      retryTimer = null
      void tryConnect()
    }, OBS_MUTE_RETRY_MS)
  }

  const tryConnect = async (): Promise<void> => {
    attempt += 1
    const current = attempt
    /** この回の接続から届いた知らせを、まだ受け取ってよいか */
    const isCurrent = (): boolean => !stopped && current === attempt
    try {
      const opened = await connect({
        onEvent: (eventType, data) => {
          if (!isCurrent()) return
          try {
            const muted = mutedOfEvent(eventType, data, inputName)
            if (muted !== null) onChange({ kind: 'watching', muted })
          } catch (error) {
            // 読めない切り替えを無視すると、ミュートしたのに文字起こしが続いていることに気づけない
            attempt += 1
            failAndRetry(errorMessage(error))
          }
        },
        onClose: (error) => {
          if (!isCurrent()) return
          // 切れた接続から先は届かないので、この回はここで終える（遅れて届く知らせを受け取らない）
          attempt += 1
          failAndRetry(error.message)
        },
      })
      if (!isCurrent()) {
        opened.close()
        return
      }
      connection = opened
      const data = await opened.request('GetInputMute', { inputName })
      if (!isCurrent()) return
      if (typeof data.inputMuted !== 'boolean') throw new Error('GetInputMute の応答に inputMuted がありません')
      onChange({ kind: 'watching', muted: data.inputMuted })
    } catch (error) {
      if (!isCurrent()) return
      attempt += 1
      const prefix = connection === null ? '' : `OBS の「${inputName}」のミュートを読めませんでした。入力の名前が OBS の音声ミキサーと同じかを確かめてください: `
      failAndRetry(`${prefix}${errorMessage(error)}`)
    }
  }

  onChange({ kind: 'connecting' })
  void tryConnect()

  return {
    stop() {
      stopped = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      connection?.close()
      connection = null
    },
  }
}
