/**
 * 配信の詳細に出す、意見ボードの振り返り（issue #309）
 *
 * その配信の時間に開いたテーマ（Worker が時刻で結ぶ）を、テーマごとの区切りで出す。区切りの中に、全論点・全意見（札の種類・
 * 人数・もとのコメントの原文）と、コメントの件数の内訳を置く。合成ページには出さない人数も、振り返りでは出してよい。
 * 隠した意見は「隠しています」と分かる形で残し、意見にならなかったコメントは件数の内訳だけを出す。
 * 締め切ったテーマには、締め切ったときに作った機械のまとめを、意見の一覧とは別の「AIのまとめ」の枠（src/opinions/summary-card.tsx）で
 * 出す。ここは読むだけの場所なので作り直しの操作は置かない（作り直しは /opinions/ で行う）。
 *
 * 注意: 読み込みに失敗したら、テーマが無いように見せず理由を出す（Fail-Fast）。日時はブラウザのタイムゾーンで出す。
 */
import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { StatusDot } from '@/components/data/data-display'
import { Skeleton } from '@/components/ui/skeleton'
import type { AdminOpinion, AdminTopic, OpinionCommentCounts } from '@/opinions/api'
import { OpinionKindTag } from '@/opinions/kind-tag'
import { SummaryCard } from '@/opinions/summary-card'
import type { OpinionThemeReview, StatsApi } from './api'
import { formatClockTime } from './summary'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 読み込んだ振り返り。失敗したら理由を持つ */
type Loaded = { status: 'loading' } | { status: 'ready'; themes: readonly OpinionThemeReview[] } | { status: 'failed'; message: string }

/** 規則で落としたコメントの数（コマンド・エモートだけ・短い反応の合計） */
const droppedTotal = (counts: OpinionCommentCounts): number => counts.dropped.command + counts.dropped.emote + counts.dropped.reaction

/** コメントの内訳。意見にならなかったコメントの原文は並べず、件数だけを出す */
const CommentBreakdown = ({ themeTitle, counts }: { themeTitle: string; counts: OpinionCommentCounts }) => (
  <p role="group" aria-label={`コメントの内訳（${themeTitle}）`} className="flex flex-wrap items-baseline gap-x-3 text-sm text-muted-foreground">
    <span>
      受け取ったコメント<strong className="font-medium tabular-nums">{counts.received}件</strong>
    </span>
    <span>意見になった{counts.used}件</span>
    <span>規則で落とした{droppedTotal(counts)}件</span>
    <span>Jevが意見ではないとみた{counts.filtered}件</span>
    <span>無関係とした{counts.ignored}件</span>
    {counts.pending > 0 && <span>振り分け待ち{counts.pending}件</span>}
    {counts.failed > 0 && <span>振り分けに失敗した{counts.failed}件</span>}
  </p>
)

/** 意見1件。札の種類・人数・もとのコメントの原文を持つ。隠した意見は隠していると分かるようにする */
const ReviewOpinion = ({ opinion }: { opinion: AdminOpinion }) => (
  <li role="group" aria-label={`意見「${opinion.text}」`} className={`space-y-1 rounded-lg border p-3 ${opinion.hidden ? 'opacity-60' : ''}`}>
    <p className="flex flex-wrap items-center gap-2">
      <OpinionKindTag kind={opinion.kind} />
      <span className="font-medium">{opinion.text}</span>
      <span className="text-sm text-muted-foreground tabular-nums">{opinion.people}人</span>
      {opinion.hidden && <StatusDot tone="neutral">隠しています</StatusDot>}
    </p>
    <ul className="text-sm text-muted-foreground">
      {opinion.sources.map((source, index) => (
        // 同じ人が同じ文を2回書くこともあるので、並び順を鍵に含める
        <li key={`${index}-${source.userName}`}>{`${source.userName}: ${source.text}`}</li>
      ))}
    </ul>
  </li>
)

/** 論点1つと、その中の意見 */
const ReviewTopic = ({ topic }: { topic: AdminTopic }) => (
  <div role="group" aria-label={`論点「${topic.title}」`} className="space-y-2">
    <h5 className="text-sm font-semibold">{topic.title}</h5>
    {topic.opinions.length === 0 ? (
      <p className="text-sm text-muted-foreground">意見はありません。</p>
    ) : (
      <ul className="space-y-2">
        {topic.opinions.map((opinion) => (
          <ReviewOpinion key={opinion.id} opinion={opinion} />
        ))}
      </ul>
    )}
  </div>
)

/** テーマ1つぶんの区切り。時間・コメントの内訳・機械のまとめ（締め切ったテーマだけ）・論点の順に出す */
const ReviewTheme = ({ review }: { review: OpinionThemeReview }) => {
  const { theme } = review
  return (
    <section role="group" aria-label={`テーマ「${theme.title}」の振り返り`} className="space-y-3 rounded-lg border p-3">
      <h4 className="flex flex-wrap items-baseline gap-x-2">
        <strong className="font-medium">{theme.title}</strong>
        <span className="text-sm font-normal text-muted-foreground tabular-nums">
          {theme.closedAt === null ? `${formatClockTime(theme.openedAt)}〜` : `${formatClockTime(theme.openedAt)}〜${formatClockTime(theme.closedAt)}`}
        </span>
        {theme.closedAt === null && <span className="text-sm font-normal text-muted-foreground">締め切っていません</span>}
      </h4>
      <CommentBreakdown themeTitle={theme.title} counts={review.counts} />
      {theme.closedAt !== null && <SummaryCard summary={review.summary} />}
      {review.topics.map((topic) => (
        <ReviewTopic key={topic.id} topic={topic} />
      ))}
    </section>
  )
}

export interface SessionOpinionsProps {
  api: Pick<StatsApi, 'sessionOpinions'>
  /** 振り返る配信のID */
  sessionId: string
}

/** 配信の時間に開いた意見ボードのテーマを読み込んで、テーマごとに出す */
export const SessionOpinions = ({ api, sessionId }: SessionOpinionsProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.sessionOpinions(sessionId).then(
      (themes) => {
        if (!cancelled) setLoaded({ status: 'ready', themes })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, sessionId])

  return (
    // 一覧のセルは折り返さない（whitespace-nowrap）ので、文章を出すここだけ折り返させる
    <div className="space-y-3 whitespace-normal">
      <h3 className="text-sm font-semibold">意見ボードの振り返り</h3>
      {loaded.status === 'loading' && <Skeleton className="h-24 w-full" aria-label="意見ボードの振り返りを読み込んでいます" />}
      {loaded.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>意見ボードの振り返りを読み込めませんでした</AlertTitle>
          <AlertDescription>{loaded.message}</AlertDescription>
        </Alert>
      )}
      {loaded.status === 'ready' &&
        (loaded.themes.length === 0 ? (
          <p className="text-sm text-muted-foreground">この配信では意見ボードのテーマを開いていません。</p>
        ) : (
          loaded.themes.map((review) => <ReviewTheme key={review.theme.id} review={review} />)
        ))}
    </div>
  )
}
