/**
 * ダッシュボードの時系列の折れ線グラフ
 *
 * 視聴者数・フォロワー数の推移を描く。横軸は時刻（ミリ秒）で、目盛りはブラウザのタイムゾーンで出す。
 *
 * 注意: このファイルだけが Recharts（`@/components/ui/chart`）を読み込みます。
 * ダッシュボード（stats-page.tsx）から `React.lazy` で切り離して読み込むため、
 * ギャラリーや管理画面を開いたときに Recharts を読み込まずに済みます。
 * この約束を守るため、ここ以外から Recharts を読み込まないでください。
 * グラフの色はテーマのトークン（--chart-2）を使い、明暗のどちらでも読める中間の濃さにします。
 */
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatShortTime } from './summary'

/** グラフに渡す点。値の列の名前（viewers・followers）は dataKey で選ぶ */
export interface TimePoint {
  /** 時刻（ミリ秒） */
  at: number
}

/** 描ける値の種類 */
export type TimeChartKey = 'viewers' | 'followers'

const CHART_CONFIG: Record<TimeChartKey, ChartConfig> = {
  viewers: { viewers: { label: '視聴者数', color: 'var(--chart-2)' } },
  followers: { followers: { label: 'フォロワー数', color: 'var(--chart-2)' } },
}

export interface TimeChartProps {
  /** グラフ全体の説明（読み上げに使う） */
  label: string
  dataKey: TimeChartKey
  points: readonly TimePoint[]
}

/** 時系列の折れ線グラフ。横軸は時刻（ミリ秒）で、目盛りはブラウザのタイムゾーンで出す */
export const TimeChart = ({ label, dataKey, points }: TimeChartProps) => (
  // グラフの中身（SVG）は読み上げても意味が通らないので、ひとつの図として説明だけを読ませる
  <ChartContainer role="img" aria-label={label} config={CHART_CONFIG[dataKey]} className="aspect-auto h-56 w-full">
    <LineChart data={[...points]} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={formatShortTime} tickMargin={8} minTickGap={32} />
      <YAxis width={40} allowDecimals={false} tickMargin={8} />
      <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => formatShortTime(Number(payload[0]?.payload.at))} />} />
      <Line dataKey={dataKey} type="monotone" stroke={`var(--color-${dataKey})`} strokeWidth={2} dot={false} isAnimationActive={false} />
    </LineChart>
  </ChartContainer>
)
