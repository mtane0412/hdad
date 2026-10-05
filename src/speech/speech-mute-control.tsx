/**
 * 下部バーに置く、チャットの読み上げのミュート（issue #238）
 *
 * どのページを見ていても、チャットの読み上げをその場で黙らせ・戻せるようにする。切り替えは Worker が保存し、
 * 読み上げのページ（speech/reader/・裏方のページ）へ押し出すので、30秒の設定の読み直しを待たずにすぐ効く。
 * ミュート中に届いたコメントは、戻したあとも読まない（溜めて一気に読まない。読み上げのページ src/speech/task.ts が捨てる）。
 *
 * ボタンは下部バーのほかの操作に合わせ、文字を出さずアイコンだけにする（名前は読み上げとホバーで出す）。
 * ミュートしているあいだはボタンが押された状態になり、アイコンも変わる。
 *
 * 注意: 読めない・断られたときは、黙らずに理由を出す（Fail-Fast。ミュートできたつもりで配信を続けないため）。
 * 注意: 開いたときに一度読むだけで、別の窓での切り替えは追わない（押すと、映っている状態の逆を保存する）。
 */
import { MessageSquareOff, MessageSquareText } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Toggle } from '@/components/ui/toggle'
import { iconButtonName } from '@/core/icon-button'
import { createSpeechMuteApi, type SpeechMuteApi } from './api'

/** 下部バーの切り替えボタンの見た目。押されているときは背景ではなくアイコンの色で示す（文字起こしの切り替えと同じ） */
const PLAYER_TOGGLE_CLASS =
  'size-9 rounded-full text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-primary hover:aria-pressed:bg-muted'

const defaultApi = createSpeechMuteApi((input, init) => fetch(input, init))

/**
 * @param api ミュートの読み書き。テストで差し替えるために受け取る
 */
export const SpeechMuteControl = ({ api = defaultApi }: { api?: SpeechMuteApi }) => {
  /** ミュートしているか。読み込むまでは null */
  const [muted, setMuted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  /** 読めなかった・断られた理由。次の切り替えが通ったら消す */
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.load().then(
      (loaded) => {
        if (!cancelled) setMuted(loaded)
      },
      (error: unknown) => {
        if (!cancelled) setProblem(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    try {
      setMuted(await api.save(next))
      setProblem(null)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Toggle
        className={PLAYER_TOGGLE_CLASS}
        pressed={muted === true}
        disabled={muted === null || busy}
        onPressedChange={(pressed) => void toggle(pressed)}
        {...iconButtonName('チャットの読み上げをミュート')}
      >
        {muted === true ? <MessageSquareOff aria-hidden="true" className="size-5" /> : <MessageSquareText aria-hidden="true" className="size-5" />}
      </Toggle>
      {problem !== null && (
        <p role="alert" title={problem} className="min-w-0 truncate text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
