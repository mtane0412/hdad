/**
 * アプリのページの音声認識が確定した発話を Worker へ送り、どうなったかを残す
 *
 * 発話ごとに新しいメッセージID（webspeech: の後ろに一意の識別子）を振る。Worker は同じIDの2件目を記録しない
 * （transcripts.message_id が主キー）ので、送り直しは同じIDで送り、二重に記録しない。
 * 「webspeech:」の印は、ゆかコネNEO の MsgID（中継ページから届くもの）と重ならないためである（issue #189）。
 *
 * ゆかコネNEO の中継と違い、同じ1件を押し出し直してくれる相手がいないので、送り直しはここで行う。
 * 送り直すのは通信の失敗と Worker 側の不具合（5xx）だけで、本文の誤りなど同じ答えになる失敗は送り直さない（api.ts の isRetryable）。
 *
 * 注意: 待ちと識別子の作り方は引数で受け取る。テストで実際に待たず、IDを決めて確かめるためである。
 */
import { isRetryable, type TranscriptApi } from './api'

/** 1件の発話が、いまどうなっているか */
export type DeliveryState =
  /** Worker へ送っている最中（送り直しを待っているあいだを含む） */
  | 'sending'
  /** Worker が記録した */
  | 'recorded'
  /** 配信していなかったので Worker が捨てた */
  | 'discarded'
  /** 送れなかった */
  | 'failed'

export interface DeliveredLine {
  /** Worker へ送ったメッセージID */
  id: string
  text: string
  state: DeliveryState
  /** 送れなかった理由（state が failed のときだけ） */
  error?: string
}

export interface TranscriptDeliveryOptions {
  api: TranscriptApi
  /** 発話ごとに一意の識別子を作る（ブラウザでは crypto.randomUUID） */
  createId(): string
  wait(milliseconds: number): Promise<void>
  /** 残している発話（新しいものが先頭）が変わった */
  onChange(lines: readonly DeliveredLine[]): void
}

export interface TranscriptDelivery {
  /** 確定した発話を1件送る。送り終えるか、あきらめるまで待つ */
  deliver(text: string): Promise<void>
}

const MESSAGE_ID_PREFIX = 'webspeech:'

/** 送り直すまでの待ち時間（ミリ秒）。この回数を送り直してもだめならあきらめる */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const

/** 残す発話の件数の上限。長い配信で画面が伸び続けないよう、古いものから落とす */
const MAX_LINES = 50

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const createTranscriptDelivery = (options: TranscriptDeliveryOptions): TranscriptDelivery => {
  const { api, wait, onChange } = options
  let lines: readonly DeliveredLine[] = []

  const setLine = (line: DeliveredLine): void => {
    // 送っているあいだに後の発話が先頭に来ていても、並びは送り始めた順のまま変えない
    const exists = lines.some((existing) => existing.id === line.id)
    lines = exists ? lines.map((existing) => (existing.id === line.id ? line : existing)) : [line, ...lines].slice(0, MAX_LINES)
    onChange(lines)
  }

  return {
    async deliver(text) {
      const id = `${MESSAGE_ID_PREFIX}${options.createId()}`
      setLine({ id, text, state: 'sending' })
      for (let attempt = 0; ; attempt += 1) {
        try {
          const recorded = await api.send(id, text)
          setLine({ id, text, state: recorded ? 'recorded' : 'discarded' })
          return
        } catch (error) {
          const delay = RETRY_DELAYS_MS[attempt]
          if (delay === undefined || !isRetryable(error)) {
            setLine({ id, text, state: 'failed', error: errorMessage(error) })
            return
          }
          await wait(delay)
        }
      }
    },
  }
}
