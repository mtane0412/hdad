/**
 * アプリの枠の状態を WebMCP のツールへ渡し、登録する部品（issue #279）
 *
 * ログインしているあいだ（アプリの枠が出ているあいだ）だけツールを登録し、枠が消える（ログアウトする）ときに
 * AbortSignal で止めてまとめて消す。ツールは画面のボタンと同じ BgmPlayerProvider・PomodoroTimerProvider・
 * RecognitionProvider を通して操作するので、エージェントの操作は下部バーにもそのまま映る。
 *
 * 普段は何も描かない。登録を断られたときだけ、置かれた場所（下部バー）に理由を出す（Fail-Fast。
 * エージェントから呼べないことに気づけるようにするため）。WebMCP に対応していないブラウザでは何も出さない。
 *
 * 注意: BgmPlayerProvider・PomodoroTimerProvider・RecognitionProvider の内側で使う。
 * 注意: ツールは登録し直さず、最新の状態を ref から読む（状態が変わるたびに登録し直すと、エージェントへ
 *   ツールの一覧が変わったという知らせが出続けるため）。
 * 注意: 読み上げのミュートは下部バーのボタン（src/speech/speech-mute-control.tsx）と状態を共有していない。
 *   ツールで切り替えても、ボタンの見た目はページを開き直すまで変わらない。
 */
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { navigate, usePathname } from '@/app/router'
import { useBgmPlayer } from '@/bgm/player-context'
import { usePomodoroTimer } from '@/pomodoro/timer-context'
import { createSpeechMuteApi, type SpeechMuteApi } from '@/speech/api'
import { useRecognition } from '@/transcript/recognition-context'
import { registerTools, type ToolRegistry } from './register'
import { buildTools, type PageEntry, type WebMcpDeps } from './tools'

const defaultSpeechMuteApi = createSpeechMuteApi((input, init) => fetch(input, init))

/**
 * @param pages エージェントに見せるページ（サイドバーの項目）
 * @param speechMuteApi 読み上げのミュートの読み書き。テストで差し替えるために受け取る
 */
export const WebMcpTools = ({ pages, speechMuteApi = defaultSpeechMuteApi }: { pages: readonly PageEntry[]; speechMuteApi?: SpeechMuteApi }) => {
  const bgm = useBgmPlayer()
  const pomodoro = usePomodoroTimer()
  const recognition = useRecognition()
  const pathname = usePathname()
  const latest = useRef({ bgm, pomodoro, recognition, pathname })
  /** 登録を断られた理由。登録できているか、対応していないブラウザなら null */
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    latest.current = { bgm, pomodoro, recognition, pathname }
  })

  useEffect(() => {
    const controller = new AbortController()
    const deps: WebMcpDeps = {
      pages,
      currentPath: () => latest.current.pathname,
      openPage: (path) => {
        navigate(path)
        // 未保存の変更があるページからは確認を出すだけで、URLはまだ変わらない（src/app/router.tsx の navigate）
        return window.location.pathname === path ? 'moved' : 'confirming'
      },
      bgm: () => latest.current.bgm,
      pomodoro: () => latest.current.pomodoro,
      now: () => Date.now(),
      speechMute: speechMuteApi,
      recognition: () => latest.current.recognition,
    }
    const modelContext: ToolRegistry | undefined = document.modelContext
    registerTools(modelContext, buildTools(deps), controller.signal).then(
      () => {
        if (!controller.signal.aborted) setProblem(null)
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setProblem(errorMessage(error))
      },
    )
    return () => controller.abort()
  }, [pages, speechMuteApi])

  if (problem === null) return null
  return (
    <p role="alert" title={problem} className="min-w-0 truncate text-xs text-destructive">
      {problem}
    </p>
  )
}
