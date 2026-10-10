/**
 * 下部バーに置く、漢字クイズの時間切れによる配信の停止の取り消し（issue #302）
 *
 * 漢字クイズが時間切れになると、Worker は猶予（KANJI_QUIZ_STOP_GRACE_MS）ののちに配信を止める。そのあいだ、どのページを見ていても
 * 止めるのをやめられるよう、下部バーに残り秒数つきの取り消しボタンを出す。ふだんは何も出さない。
 *
 * 猶予と取り消しは、合成ページの素材「漢字クイズ」と同じ押し出し（オーバーレイ用キーで /api/overlay/kanji-quiz/socket）で受け取り、
 * 読み取りも同じもの（call.ts の parseKanjiQuizMessage）を通す。取り消しは配信者のセッションで Worker に頼む（api.ts の cancelStop）。
 * 残り秒数は、猶予の知らせが届いた時刻からこの画面の時計で数える（Worker の時計とずれていても数え違えないよう、長さで届く）。
 *
 * 注意: 取り消しを断られた・押し出しを受け取れていないときは、黙らずに理由を出す（Fail-Fast。取り消せたつもりで配信が止まらないように）。
 * 注意: 開き直したときに猶予のあいだだったかは読み直さない（猶予は10秒で、そのあいだに開き直すことはまずない）。
 */
import { OctagonX } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Button } from '@/components/ui/button'
import { parseKanjiQuizMessage } from './call'

/** 残り秒数を数え直す間隔（ミリ秒） */
const TICK_MS = 250
const MS_PER_SECOND = 1000

/** 押し出しが切れているときの知らせ */
const DISCONNECTED_NOTICE = '漢字クイズの配信の停止の知らせを受け取れていません。つなぎ直しています'

/** 押し出しの接続から受け取るもの（src/core/socket.ts の SocketHandlers と同じ形） */
export interface KanjiQuizStopWatchHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** 取り消しに使うもの。テストで差し替えるため、アプリの枠から受け取る */
export interface KanjiQuizStopDeps {
  /** 漢字クイズの押し出しにつなぐ（本番は socket.ts の connectKanjiQuizWatch） */
  connect(overlayKey: string, handlers: KanjiQuizStopWatchHandlers): { close(): void }
  /** 猶予のあいだの停止をすべて取り消し、取り消した出題の識別子を返す（本番は api.ts の cancelStop） */
  cancel(): Promise<string[]>
}

/** 猶予のあいだの停止1つ。stopAt はこの画面の時計で、猶予が尽きる時刻。猶予が重なっても出題ごとに持ち、尽きたものだけを外す */
interface PendingStop {
  readonly quizId: string
  readonly stopAt: number
  readonly rehearsal: boolean
}

/**
 * @param overlayKey ログイン中の配信者のオーバーレイ用キー。未発行（null）ならつながない
 */
export const KanjiQuizStopBar = ({ overlayKey, deps }: { overlayKey: string | null; deps: KanjiQuizStopDeps }) => {
  const [pending, setPending] = useState<readonly PendingStop[]>([])
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  /** 断られた・受け取れていない理由。次の猶予が届いた・つなぎ直したら消す */
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (overlayKey === null) return undefined
    const connection = deps.connect(overlayKey, {
      onMessage: (text) => {
        try {
          const message = parseKanjiQuizMessage(text)
          if (message.type === 'stopping') {
            const at = Date.now()
            setNow(at)
            setProblem(null)
            setPending((current) => [
              ...current.filter(({ quizId }) => quizId !== message.quizId),
              { quizId: message.quizId, stopAt: at + message.graceMs, rehearsal: message.rehearsal },
            ])
          } else if (message.type === 'stopCancelled') {
            setPending((current) => current.filter(({ quizId }) => quizId !== message.quizId))
          }
        } catch (error) {
          setProblem(errorMessage(error))
        }
      },
      onStatus: (status) => setProblem(status === 'disconnected' ? DISCONNECTED_NOTICE : null),
      onWarning: (message) => setProblem(message),
    })
    return () => connection.close()
  }, [overlayKey, deps])

  // 猶予のあいだは残り秒数を数え直し、尽きた猶予だけを外す（残った猶予の取り消しボタンは出し続ける）
  const hasPending = pending.length > 0
  useEffect(() => {
    if (!hasPending) return undefined
    const interval = setInterval(() => {
      const at = Date.now()
      setNow(at)
      setPending((current) => {
        const rest = current.filter(({ stopAt }) => stopAt > at)
        return rest.length === current.length ? current : rest
      })
    }, TICK_MS)
    return () => clearInterval(interval)
  }, [hasPending])

  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      await deps.cancel()
      setPending([])
      setProblem(null)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (!hasPending && problem === null) return null
  // 猶予が重なったら、先に尽きるほうを数える。本番の猶予が1つでもあれば試し再生とは出さない
  const stopAt = Math.min(...pending.map((entry) => entry.stopAt))
  const rehearsal = pending.every((entry) => entry.rehearsal)
  const remainingSeconds = Math.max(0, Math.ceil((stopAt - now) / MS_PER_SECOND))

  return (
    <div className="flex min-w-0 items-center gap-1">
      {hasPending && (
        <Button type="button" variant="destructive" size="sm" className="shrink-0" disabled={busy} onClick={() => void cancel()}>
          <OctagonX aria-hidden="true" />
          配信の停止を取り消す（残り {remainingSeconds}秒{rehearsal ? '・試し再生' : ''}）
        </Button>
      )}
      {problem !== null && (
        <p role="alert" title={problem} className="min-w-0 truncate text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
