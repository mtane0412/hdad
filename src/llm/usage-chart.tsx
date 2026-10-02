/**
 * LLMの使用状況の棒グラフ
 *
 * すべての箇所を合わせた、日ごと（UTC）の呼び出し回数を1系列の棒で描く。箇所ごとの内訳は
 * LLMのページの表に並べるので、グラフでは色分けしない（系列を分けるとテーマの灰色の段だけでは見分けにくい）。
 *
 * 注意: Recharts（`@/components/ui/chart`）を読み込むので、LLMのページ（llm-page.tsx）から `React.lazy` で
 * 切り離して読み込む（ほかのページを開くときに Recharts を運ばないため。src/stats/time-chart.tsx と同じ約束）。
 * 注意: 色はテーマのトークン（--chart-2）を使い、明暗のどちらでも読める中間の濃さにする。
 * 注意: グラフの絵は1つの図として説明だけを読ませるので、日ごとの値は画面に出さない表（sr-only）として別に持つ。
 */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import type { LlmDailyCalls } from './usage'

const CHART_CONFIG: ChartConfig = {
  calls: { label: '呼び出し回数', color: 'var(--chart-2)' },
}

/** 横軸の目盛りは月日だけにする（YYYY-MM-DD の年を落として M/D にする） */
const formatDay = (day: string): string => {
  const [, month, date] = day.split('-')
  return `${Number(month)}/${Number(date)}`
}

export interface UsageChartProps {
  /** グラフ全体の説明（読み上げに使う） */
  label: string
  /** 古い順の日ごとの回数 */
  points: readonly LlmDailyCalls[]
}

/** 日ごとの呼び出し回数の棒グラフ */
export const UsageChart = ({ label, points }: UsageChartProps) => (
  <>
    {/* グラフの中身（SVG）は読み上げても意味が通らないので、ひとつの図として説明だけを読ませる */}
    <ChartContainer role="img" aria-label={label} config={CHART_CONFIG} className="aspect-auto h-48 w-full">
      <BarChart data={[...points]} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickFormatter={formatDay} tickMargin={8} minTickGap={24} />
        <YAxis width={40} allowDecimals={false} tickMargin={8} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(day) => `${String(day)}（UTC）`} />} />
        <Bar dataKey="calls" fill="var(--color-calls)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
    {/* 日ごとの値は、読み上げのためだけの表として持つ */}
    <table className="sr-only" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">日（UTC）</th>
          <th scope="col">呼び出し回数</th>
        </tr>
      </thead>
      <tbody>
        {points.map(({ day, calls, failures }) => (
          <tr key={day}>
            <th scope="row">{day}</th>
            <td>{`${calls}回${failures > 0 ? `（失敗${failures}回）` : ''}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
)
