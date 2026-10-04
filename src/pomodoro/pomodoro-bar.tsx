/**
 * 下部バーに置く、ポモドーロの残り時間と操作（issue #237）
 *
 * どのページを見ていても、ポモドーロの区間（作業・休憩）と残り時間が見え、始める・一時停止・再開・止めるができるようにする。
 * 区間と残り時間を押すとポモドーロのページ（/pomodoro/）へ移る。休憩の曲の選択はバーを狭く保つために置かず、ページだけに残す。
 *
 * タイマーはアプリの枠の PomodoroTimerProvider（timer-context.tsx）から読むので、ポモドーロのページと同じものを映す。
 * 区間と残り時間は合成ページの札・ページと同じく phase.ts の phaseAt・formatRemaining で現在時刻から計算する。
 * ボタンは下部バーのほかの操作に合わせ、文字を出さずアイコンだけにする（名前は読み上げとホバーで出す）。
 *
 * 注意: 読めない・押し出しを受け取れていない・操作が断られたときは、黙らずに理由を出す（Fail-Fast）。
 *   成功のお知らせは出さない（ボタンと残り時間が変わることで分かるため）。
 */
import { Pause, Play, Square, Timer, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { Button } from '@/components/ui/button'
import { iconButtonName } from '@/core/icon-button'
import type { PomodoroCommand } from './api'
import { formatRemaining, phaseAt } from './phase'
import { commandsOf, usePomodoroTimer, useSecondTick } from './timer-context'

/** 休憩の曲の選択と、詳しい説明があるページ */
const POMODORO_PAGE_PATH = '/pomodoro/'

/** 操作ごとのボタンの名前とアイコン */
const COMMAND_BUTTONS: Readonly<Record<PomodoroCommand, { name: string; icon: LucideIcon }>> = {
  start: { name: 'ポモドーロを始める', icon: Timer },
  pause: { name: 'ポモドーロを一時停止', icon: Pause },
  resume: { name: 'ポモドーロを再開', icon: Play },
  stop: { name: 'ポモドーロを止める', icon: Square },
}

/**
 * @param now 現在時刻（ミリ秒）を返す。テストで時刻を決めるために受け取る
 */
export const PomodoroBar = ({ now = Date.now }: { now?: () => number }) => {
  const pomodoro = usePomodoroTimer()
  const [busy, setBusy] = useState(false)
  /** 直前の操作が断られた理由。次の操作が通ったら消す */
  const [failure, setFailure] = useState<string | null>(null)
  useSecondTick(pomodoro.timer)

  const control = async (command: PomodoroCommand): Promise<void> => {
    setBusy(true)
    try {
      await pomodoro.control(command)
      setFailure(null)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const { timer } = pomodoro
  const phase = timer === null ? null : phaseAt(timer, now())
  const state = timer === null || phase === null ? null : timer.pausedAt !== null ? '一時停止中' : phase.kind === 'work' ? '作業中' : '休憩中'
  /** 出す理由。何も問題がなければ null */
  const problem = failure ?? (pomodoro.loaded.status === 'failed' ? pomodoro.loaded.message : pomodoro.watchNotice)

  return (
    <div className="flex min-w-0 items-center gap-1">
      {phase !== null && state !== null && (
        <Link
          href={POMODORO_PAGE_PATH}
          aria-label={`ポモドーロ: ${state} ${phase.round}本目 残り${formatRemaining(phase.remainingMs)}`}
          className="flex shrink-0 items-baseline gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {/* 狭い画面では残り時間を優先する（区間は読み上げの名前で伝わる） */}
          <span className="hidden sm:inline">{state}</span>
          <span className="font-mono text-sm font-semibold text-foreground tabular-nums">{formatRemaining(phase.remainingMs)}</span>
        </Link>
      )}
      {commandsOf(timer).map((command) => {
        const { name, icon: Icon } = COMMAND_BUTTONS[command]
        return (
          <Button
            key={command}
            type="button"
            variant="ghost"
            className="size-9 shrink-0 rounded-full text-muted-foreground"
            disabled={busy || pomodoro.loaded.status !== 'ready'}
            onClick={() => void control(command)}
            {...iconButtonName(name)}
          >
            <Icon aria-hidden="true" className="size-5" />
          </Button>
        )
      })}
      {problem !== null && (
        <p role="alert" title={problem} className="min-w-0 truncate text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
