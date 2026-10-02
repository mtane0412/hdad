// @vitest-environment jsdom
/**
 * 使用状況の棒グラフ（usage-chart.tsx）のテスト
 *
 * 確かめること:
 * - グラフの絵（SVG）とは別に、日ごとの値（UTCの日と呼び出し回数・失敗の回数）を読み上げで読める表として持つこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { UsageChart } from './usage-chart'

afterEach(cleanup)

beforeAll(() => {
  // jsdom には ResizeObserver がない。グラフが大きさを測るのに使うので、何もしない代役を置く
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  )
})

describe('UsageChart', () => {
  test('日ごとの値を、読み上げで読める表としても持つ', () => {
    render(
      <UsageChart
        label="直近2日の呼び出し回数の推移"
        points={[
          { day: '2026-09-26', calls: 0, failures: 0 },
          { day: '2026-09-27', calls: 6, failures: 1 },
        ]}
      />,
    )

    const table = screen.getByRole('table', { name: '直近2日の呼び出し回数の推移' })
    expect(within(table).getByRole('row', { name: /2026-09-26/ })).toHaveTextContent('0回')
    expect(within(table).getByRole('row', { name: /2026-09-27/ })).toHaveTextContent('6回（失敗1回）')
  })
})
