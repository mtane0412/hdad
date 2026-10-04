/**
 * ポモドーロのページ（/pomodoro/）
 *
 * 配信中に、ポモドーロのタイマー（25分の作業と5分の休憩。issue #208）を始める・一時停止する・再開する・止める画面である。
 * 区切りで何をするか（botの書き込み・アラートなど）はトリガーのページの区分「ポモドーロ」で決め、ここでは休憩中に流す曲だけを選ぶ。
 *
 * タイマーの状態は Worker（Durable Object）が持つ。画面はアプリの枠の PomodoroTimerProvider（timer-context.tsx）から
 * タイマー（始めた時刻・一時停止の時刻）を受け取り、現在時刻から区間と残り時間を1秒ごとに計算して出す
 * （src/pomodoro/phase.ts。合成ページの札と同じ計算）。枠から読むので、下部バーや別の窓での操作もそのまま映る（issue #237）。
 *
 * 注意: 休憩の曲は選んだらすぐ保存する（BGMのプレーヤーの操作と同じく、配信中に切り替えるもので保存ボタンを持たない）。
 * 注意: 読み込めなかったとき・操作が断られたときは、黙らずに理由を出す（Fail-Fast）。操作が断られたときの読み直しは枠が受け持つ。
 */
import { useEffect, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link } from '@/app/router'
import type { BgmApi, BgmTrack } from '@/bgm/api'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { PomodoroApi, PomodoroCommand, PomodoroSettings } from './api'
import { formatRemaining, phaseAt } from './phase'
import { commandsOf, usePomodoroTimer, useSecondTick } from './timer-context'

/** 休憩の曲を選ばない（休憩中も曲を変えない）ことを表す選択肢の値。Workerへは null として送る */
const NO_BREAK_TRACK = ''
const BREAK_TRACK_SELECT_ID = 'pomodoro-break-track'

/** 操作ごとのボタンの文言と、成功したときのお知らせ */
const COMMAND_LABELS: Readonly<Record<PomodoroCommand, { label: string; notice: string }>> = {
  start: { label: '始める', notice: 'ポモドーロを始めました' },
  pause: { label: '一時停止', notice: '一時停止しました' },
  resume: { label: '再開', notice: '再開しました' },
  stop: { label: '止める', notice: 'ポモドーロを止めました' },
}

interface Loaded {
  settings: PomodoroSettings
  tracks: BgmTrack[]
}

/**
 * @param now 現在時刻（ミリ秒）を返す。テストで時刻を決めるために受け取る
 */
export const PomodoroPage = ({ api, bgmApi, now = Date.now }: { api: PomodoroApi; bgmApi: BgmApi; now?: () => number }) => {
  const [loaded, setLoaded] = useState<Loaded>()
  const [loadError, setLoadError] = useState<string>()
  const pomodoro = usePomodoroTimer()
  const actions = usePageActions()
  useSecondTick(pomodoro.timer)

  // タイマーは枠が読むので、ここでは休憩の曲の設定と BGM の一覧だけを読む
  useEffect(() => {
    Promise.all([api.read(), bgmApi.load()]).then(
      ([{ settings }, { tracks }]) => setLoaded({ settings, tracks }),
      (error: unknown) => setLoadError(errorMessage(error)),
    )
  }, [api, bgmApi])

  const failure = loadError ?? (pomodoro.loaded.status === 'failed' ? pomodoro.loaded.message : undefined)
  if (failure !== undefined) return <LoadFailure title="ポモドーロのタイマーを読み込めませんでした" message={failure} />
  if (loaded === undefined || pomodoro.loaded.status === 'loading') return <Skeleton className="h-48 w-full" />

  const control = (command: PomodoroCommand): Promise<void> =>
    actions.run(async () => {
      await pomodoro.control(command)
      return COMMAND_LABELS[command].notice
    })

  const saveBreakTrack = (value: string): Promise<void> =>
    actions.run(async () => {
      const settings = await api.saveSettings({ breakMediaId: value === NO_BREAK_TRACK ? null : value })
      setLoaded((previous) => (previous === undefined ? previous : { ...previous, settings }))
      return '休憩中に流す曲を保存しました'
    })

  const { settings, tracks } = loaded
  const { timer } = pomodoro
  const phase = timer === null ? null : phaseAt(timer, now())

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}
      <Card>
        <CardHeader>
          <CardTitle>タイマー</CardTitle>
          <CardDescription>
            25分の作業と5分の休憩を繰り返します。区切りで動かすものは<Link href="/triggers/" className="underline underline-offset-4">トリガー</Link>の「ポモドーロ」で決めます。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {timer === null || phase === null ? (
            <p className="text-muted-foreground">止めています</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="flex items-baseline gap-3 text-lg">
                <span className="font-semibold">{timer.pausedAt !== null ? '一時停止中' : phase.kind === 'work' ? '作業中' : '休憩中'}</span>
                <span className="text-muted-foreground">{phase.round}本目</span>
              </p>
              <p className="font-mono text-5xl font-bold tabular-nums">{formatRemaining(phase.remainingMs)}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {commandsOf(timer).map((command) => (
              <Button
                key={command}
                type="button"
                variant={command === 'stop' ? 'outline' : 'default'}
                disabled={actions.busy}
                onClick={() => void control(command)}
              >
                {COMMAND_LABELS[command].label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>休憩中の BGM</CardTitle>
          <CardDescription>
            休憩のあいだだけ流す曲です。休憩が明けたら、休憩の前に流していた曲へ戻します。曲は<Link href="/bgm/" className="underline underline-offset-4">BGM</Link>で追加します。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Label htmlFor={BREAK_TRACK_SELECT_ID}>休憩中に流す曲</Label>
          <NativeSelect
            id={BREAK_TRACK_SELECT_ID}
            value={settings.breakMediaId ?? NO_BREAK_TRACK}
            disabled={actions.busy}
            onChange={(event) => void saveBreakTrack(event.target.value)}
          >
            <NativeSelectOption value={NO_BREAK_TRACK}>曲を変えない</NativeSelectOption>
            {tracks.map((track) => (
              <NativeSelectOption key={track.mediaId} value={track.mediaId}>
                {track.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </CardContent>
      </Card>
    </div>
  )
}
