// @vitest-environment jsdom
/**
 * 時系列の折れ線グラフ（time-chart.tsx）のテスト
 *
 * 確かめること:
 * - 視聴者数・フォロワー数のどちらの種類でも、説明（aria-label）を持つひとつの図として出すこと
 *
 * グラフの中身（SVG）は読み上げても意味が通らないため、点の値ではなく図としての出方だけを確かめます。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TimeChart } from './time-chart'

const 視聴者数の点 = [
  { at: Date.parse('2026-09-18T12:05:00.000Z'), viewers: 8 },
  { at: Date.parse('2026-09-18T13:05:00.000Z'), viewers: 31 },
]

const フォロワー数の点 = [
  { at: Date.parse('2026-08-01T00:00:00.000Z'), followers: 90 },
  { at: Date.parse('2026-09-18T15:00:00.000Z'), followers: 104 },
]

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

afterEach(cleanup)

describe('TimeChart', () => {
  it('視聴者数の推移を、説明を持つひとつの図として出す', () => {
    render(<TimeChart label="金曜夜のもくもく配信 の視聴者数の推移" dataKey="viewers" points={視聴者数の点} />)

    expect(screen.getByRole('img', { name: '金曜夜のもくもく配信 の視聴者数の推移' })).toBeInTheDocument()
  })

  it('フォロワー数の推移を、説明を持つひとつの図として出す', () => {
    render(<TimeChart label="直近30日のフォロワー数の推移" dataKey="followers" points={フォロワー数の点} />)

    expect(screen.getByRole('img', { name: '直近30日のフォロワー数の推移' })).toBeInTheDocument()
  })
})
