/**
 * ダッシュボード（配信の記録）
 *
 * ログイン後に最初に出す画面。Workerが貯めた記録（/api/admin/stats/*）を読み、
 * 期間の概要・フォロワー数の推移・配信の一覧を出す。配信を選ぶと、その配信の視聴者数の推移と、
 * 何が話されたか（約30分ごとの章）・最後のあらすじを読み込んで一覧の中に出す。
 * 配信タイトルの候補（試験運用。issue #268）を作るかの設定もここで切り替え、作った候補は章の下に出す。
 * 集計と整形は summary.ts、Workerの呼び出しは api.ts に任せ、ここは表示だけを受け持つ。
 *
 * 注意: 読み込みに失敗したら、記録が無いように見せず理由を出す（Fail-Fast）。
 * 日時は配信者のブラウザのタイムゾーンで出す。
 * グラフ（time-chart.tsx）は Recharts を使うので重い。ここでは React.lazy で切り離して読み込み、
 * ギャラリーや管理画面を開くときに Recharts を読み込まないようにする。
 */
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { FollowerSample, SessionDetail, SessionSummary, StatsApi, StreamTitleSettings } from './api'
import {
  eventTotals,
  followerPoints,
  formatCount,
  formatDateTime,
  formatDelta,
  formatDuration,
  formatProbability,
  formatTimeRange,
  formatWorkTime,
  PERIOD_DAYS,
  sessionDurationMs,
  summarize,
  viewerPoints,
  withinPeriod,
} from './summary'
import type { TimeChartProps } from './time-chart'

/** グラフ本体。Recharts ごと別のファイルに分け、ダッシュボードを開いたときに初めて読み込む */
const TimeChart = lazy(async () => ({ default: (await import('./time-chart')).TimeChart }))

/**
 * グラフを読み込んでいる間のつなぎ。
 *
 * グラフと同じ高さの Skeleton を出し、読み込みの前後で画面の高さが変わらないようにする。
 */
const LazyTimeChart = ({ label, dataKey, points }: TimeChartProps) => (
  <Suspense fallback={<Skeleton className="h-56 w-full" aria-label={`${label}のグラフを読み込んでいます`} />}>
    <TimeChart label={label} dataKey={dataKey} points={points} />
  </Suspense>
)

/** 最初に出す期間（日数） */
const DEFAULT_PERIOD_DAYS = 30
/** 一覧の列の数。配信を選んだときに出す推移のグラフを、一覧の幅いっぱいに広げるのに使う */
const COLUMN_COUNT = 10

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 読み込んだ記録。失敗したら理由を持つ */
type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; sessions: readonly SessionSummary[]; followers: readonly FollowerSample[] }
  | { status: 'failed'; message: string }

/** 選んだ配信の詳細（視聴者数の推移・章・あらすじ・みんなの作業時間） */
type Selected = { id: string; state: { status: 'loading' } | { status: 'ready'; detail: SessionDetail } | { status: 'failed'; message: string } }

/** 概要の数値をひとつ出す枠 */
const StatCard = ({ label, value, note }: { label: string; value: string; note?: string }) => (
  <Card role="group" aria-label={label} className="gap-2 py-4">
    <CardHeader className="px-4">
      <CardDescription>{label}</CardDescription>
    </CardHeader>
    <CardContent className="flex items-baseline gap-2 px-4">
      <strong className="text-2xl font-semibold tabular-nums">{value}</strong>
      {note !== undefined && <span className="text-sm text-muted-foreground tabular-nums">{note}</span>}
    </CardContent>
  </Card>
)

/**
 * 配信で何が話されたか（章）と、最後に作ったあらすじ。
 *
 * 章もあらすじも無いときは、何も出さずに済ませず、記録が無いことを文で伝える（読み込めていないのと見分けるため）。
 */
const SessionTalk = ({ detail, displayTitle }: { detail: SessionDetail; displayTitle: string }) => {
  if (detail.chapters.length === 0 && detail.summary === null) {
    return <p className="text-sm text-muted-foreground">この配信には話されたことの記録がありません。</p>
  }
  return (
    // 一覧のセルは折り返さない（whitespace-nowrap）ので、文章を出すここだけ折り返させる
    <div className="space-y-3 whitespace-normal">
      {detail.chapters.length > 0 && (
        <ol aria-label={`${displayTitle} で話されたこと`} className="space-y-3">
          {detail.chapters.map((chapter) => {
            const titleCandidate = detail.titleCandidates.find((candidate) => candidate.chapterStartedAt === chapter.startedAt)
            return (
              <li key={chapter.startedAt} className="space-y-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm text-muted-foreground tabular-nums">{formatTimeRange(chapter.startedAt, chapter.endedAt)}</span>
                  <strong className="font-medium">{chapter.title}</strong>
                </p>
                <p className="text-sm">{chapter.summary}</p>
                {titleCandidate !== undefined && (
                  // 機械が作った文なので、配信者が書いたものと見分けられる見出しを付ける（docs/principles.md の方針11）
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="text-muted-foreground">タイトルの候補（機械）</span>
                    <span>{titleCandidate.candidate}</span>
                    <span className="text-muted-foreground tabular-nums">公開してよい {formatProbability(titleCandidate.publishable)}</span>
                  </p>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {detail.summary !== null && (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">最後のあらすじ</p>
          <p className="text-sm">{detail.summary}</p>
        </div>
      )}
    </div>
  )
}

/** 設定の読み込みと保存の状態。失敗したら理由を持つ */
type TitleSettingsState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; settings: StreamTitleSettings; saving: boolean; saveError: string | null }

/**
 * 配信タイトルの候補を作るかの設定（試験運用）。
 *
 * 切り替えたらすぐ保存する（保存ボタンを持たない）。保存に失敗したら理由を出し、スイッチは保存されている側に戻す。
 * 読み込みに失敗したら、「作らない」に見せかけずに理由を出す（Fail-Fast）。
 */
const TitleCandidateSetting = ({ api }: { api: StatsApi }) => {
  const switchId = useId()
  const [state, setState] = useState<TitleSettingsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.titleSettings().then(
      (settings) => {
        if (!cancelled) setState({ status: 'ready', settings, saving: false, saveError: null })
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  /** 切り替えを保存する。保存が終わるまでは切り替えた側を出し、失敗したら元の設定に戻す */
  const save = (current: StreamTitleSettings, enabled: boolean): void => {
    setState({ status: 'ready', settings: { enabled }, saving: true, saveError: null })
    api.saveTitleSettings({ enabled }).then(
      (settings) => setState({ status: 'ready', settings, saving: false, saveError: null }),
      (error: unknown) => setState({ status: 'ready', settings: current, saving: false, saveError: errorMessage(error) }),
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>配信タイトルの候補（試験運用）</CardTitle>
        <CardDescription>
          入れると、配信中に章が切り替わるたびに、いま何をしているかを表す短い一言を作り、配信タイトルとして公開してよいかを Jev
          に判定させて、配信の詳細の章の下に出す。Twitch のタイトルは変えない。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === 'loading' && <Skeleton className="h-6 w-48" aria-label="配信タイトルの候補の設定を読み込んでいます" />}
        {state.status === 'failed' && <LoadFailure title="配信タイトルの候補の設定を読み込めませんでした" message={state.message} />}
        {state.status === 'ready' && (
          <>
            <div className="flex items-center gap-3">
              <Switch
                id={switchId}
                checked={state.settings.enabled}
                disabled={state.saving}
                onCheckedChange={(checked) => save(state.settings, checked)}
              />
              <Label htmlFor={switchId}>配信タイトルの候補を作る</Label>
            </div>
            {state.saveError !== null && (
              <Alert variant="destructive">
                <AlertTitle>設定を保存できませんでした</AlertTitle>
                <AlertDescription>{state.saveError}</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** 配信の一覧の1行と、選ばれていればその配信の詳細（視聴者数の推移・話されたこと） */
const SessionRow = ({ session, now, selected, onSelect }: { session: SessionSummary; now: number; selected?: Selected; onSelect(): void }) => {
  const totals = eventTotals(session)
  const isSelected = selected?.id === session.id
  // EventSubの通知で始まった配信は、次の収集までタイトルが空のことがある。表示と読み上げで同じ呼び方にする
  const displayTitle = session.title === '' ? '（タイトルの記録なし）' : session.title

  return (
    <>
      <TableRow>
        <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(session.startedAt)}</TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{session.endedAt === null ? '配信中' : formatDuration(sessionDurationMs(session, now))}</TableCell>
        <TableCell className="max-w-64 truncate">{displayTitle}</TableCell>
        <TableCell className="max-w-48 truncate">{session.categoryName}</TableCell>
        <TableCell className="text-right tabular-nums">{formatCount(session.averageViewers)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatCount(session.peakViewers)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatDelta(session.followerDelta)}</TableCell>
        <TableCell className="text-right tabular-nums">{totals.subscriptions}</TableCell>
        <TableCell className="text-right tabular-nums">{totals.redemptions}</TableCell>
        <TableCell className="text-right tabular-nums">{totals.raids}</TableCell>
        <TableCell className="text-right">
          {/* 画面には短く出し、どの配信のボタンかは読み上げ用の名前（aria-label）で伝える */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={isSelected}
            aria-label={isSelected ? `${displayTitle} の詳細を閉じる` : `${displayTitle} の詳細を見る`}
            onClick={onSelect}
          >
            {isSelected ? '閉じる' : '見る'}
          </Button>
        </TableCell>
      </TableRow>
      {isSelected && selected && (
        <TableRow>
          <TableCell colSpan={COLUMN_COUNT + 1}>
            {selected.state.status === 'loading' && <Skeleton className="h-56 w-full" aria-label={`${displayTitle} の詳細を読み込んでいます`} />}
            {selected.state.status === 'failed' && (
              <Alert variant="destructive">
                <AlertTitle>配信の詳細を読み込めませんでした</AlertTitle>
                <AlertDescription>{selected.state.message}</AlertDescription>
              </Alert>
            )}
            {selected.state.status === 'ready' && (
              <div className="space-y-4">
                {selected.state.detail.samples.length === 0 ? (
                  <p className="text-sm text-muted-foreground">この配信には視聴者数の記録がありません。</p>
                ) : (
                  <LazyTimeChart label={`${displayTitle} の視聴者数の推移`} dataKey="viewers" points={viewerPoints(selected.state.detail.samples)} />
                )}
                <SessionTalk detail={selected.state.detail} displayTitle={displayTitle} />
                <p role="group" aria-label="みんなの作業時間" className="flex items-baseline gap-2 text-sm">
                  <span className="text-muted-foreground">みんなの作業時間</span>
                  <strong className="font-medium tabular-nums">{formatWorkTime(selected.state.detail.workTime)}</strong>
                </p>
              </div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export interface StatsPageProps {
  api: StatsApi
  /** 現在時刻（ミリ秒）。テストで固定するために受け取る。省略したら画面を開いた時刻 */
  now?: number
}

export const StatsPage = ({ api, now }: StatsPageProps) => {
  // 期間の境目が描き直しのたびにずれないよう、画面を開いた時刻を持ち続ける
  const [currentTime] = useState(() => now ?? Date.now())
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [days, setDays] = useState(DEFAULT_PERIOD_DAYS)
  const [selected, setSelected] = useState<Selected>()

  useEffect(() => {
    let cancelled = false
    Promise.all([api.sessions(), api.followers()]).then(
      ([sessions, followers]) => {
        if (!cancelled) setLoaded({ status: 'ready', sessions, followers })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="配信の記録を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <LoadFailure title="配信の記録を読み込めませんでした" message={loaded.message} />
    )
  }

  /** 配信を選ぶ（もう一度選んだら閉じる）。推移はそのつど読み込む */
  const select = (session: SessionSummary): void => {
    if (selected?.id === session.id) {
      setSelected(undefined)
      return
    }
    setSelected({ id: session.id, state: { status: 'loading' } })
    api.session(session.id).then(
      (detail) => setSelected((current) => (current?.id === session.id ? { id: session.id, state: { status: 'ready', detail } } : current)),
      (error: unknown) =>
        setSelected((current) => (current?.id === session.id ? { id: session.id, state: { status: 'failed', message: errorMessage(error) } } : current)),
    )
  }

  const { sessions, followers } = loaded
  if (sessions.length === 0 && followers.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="font-medium">まだ配信の記録がありません</p>
        <p className="text-sm text-muted-foreground">配信を始めると記録が貯まり、ここに視聴者数やフォロワー数の推移が出ます。</p>
        <TitleCandidateSetting api={api} />
      </div>
    )
  }

  const overview = summarize(sessions, followers, days, currentTime)
  const sessionsInPeriod = withinPeriod(sessions, days, currentTime)
  const followerTrend = followerPoints(followers, days, currentTime)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">期間</span>
        {PERIOD_DAYS.map((period) => (
          <Button
            key={period}
            type="button"
            size="sm"
            variant={period === days ? 'default' : 'outline'}
            aria-pressed={period === days}
            onClick={() => setDays(period)}
          >
            {period}日
          </Button>
        ))}
      </div>

      <section aria-labelledby="overview-heading" className="flex flex-col gap-3">
        <h2 id="overview-heading" className="text-lg font-semibold">
          直近{days}日の概要
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard label="配信回数" value={`${overview.streamCount}回`} />
          <StatCard label="配信時間" value={formatDuration(overview.totalDurationMs)} />
          <StatCard label="平均視聴者数" value={formatCount(overview.averageViewers)} note="人" />
          <StatCard label="最大視聴者数" value={formatCount(overview.peakViewers)} note="人" />
          <StatCard label="フォロワー数" value={formatCount(overview.followerTotal)} note={formatDelta(overview.followerDelta)} />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>フォロワー数の推移</CardTitle>
          <CardDescription>数が変わった時点だけを記録している。</CardDescription>
        </CardHeader>
        <CardContent>
          {followerTrend.length === 0 ? (
            <p className="text-sm text-muted-foreground">この期間のフォロワー数の記録がありません。</p>
          ) : (
            <LazyTimeChart label={`直近${days}日のフォロワー数の推移`} dataKey="followers" points={followerTrend} />
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="sessions-heading" className="flex flex-col gap-3">
        <h2 id="sessions-heading" className="text-lg font-semibold">
          配信の一覧
        </h2>
        {sessionsInPeriod.length === 0 ? (
          <p className="text-sm text-muted-foreground">この期間に始まった配信はありません。</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table aria-label="配信の一覧">
              <TableHeader>
                <TableRow>
                  <TableHead>開始日時</TableHead>
                  <TableHead>長さ</TableHead>
                  <TableHead>タイトル</TableHead>
                  <TableHead>カテゴリ</TableHead>
                  <TableHead className="text-right">平均視聴者数</TableHead>
                  <TableHead className="text-right">最大視聴者数</TableHead>
                  <TableHead className="text-right">フォロワー増減</TableHead>
                  <TableHead className="text-right">サブスク</TableHead>
                  <TableHead className="text-right">ポイント交換</TableHead>
                  <TableHead className="text-right">レイド</TableHead>
                  <TableHead className="text-right">視聴者数の推移</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessionsInPeriod.map((session) => (
                  <SessionRow key={session.id} session={session} now={currentTime} selected={selected} onSelect={() => select(session)} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <TitleCandidateSetting api={api} />
    </div>
  )
}
