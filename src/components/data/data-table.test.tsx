// @vitest-environment jsdom
/**
 * 一覧の表（data-table.tsx）のテスト。
 *
 * 1項目＝1行の一覧を、読み上げソフトでも表として読めること（表・行・見出し・セルの役割）と、
 * 区分の帯に「何件のうち何件か」を添えられることを確かめる。
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { DataTable, DataTableCell, DataTableGroup, DataTableHead, DataTableHeader, DataTableRow } from './data-table'

afterEach(cleanup)

const renderRewardTable = () =>
  render(
    <DataTable label="チャンネルポイント報酬" columns="minmax(0,1fr) 6rem">
      <DataTableHeader>
        <DataTableHead>名前</DataTableHead>
        <DataTableHead align="end">ポイント</DataTableHead>
      </DataTableHeader>
      <DataTableGroup label="HDAD で管理" count="2件">
        <DataTableRow>
          <DataTableCell>チャットで推理: 質問</DataTableCell>
          <DataTableCell align="end">5</DataTableCell>
        </DataTableRow>
        <DataTableRow>
          <DataTableCell>チャットで推理: 解答</DataTableCell>
          <DataTableCell align="end">5</DataTableCell>
        </DataTableRow>
      </DataTableGroup>
    </DataTable>,
  )

describe('DataTable', () => {
  test('名前の付いた表として読める', () => {
    renderRewardTable()
    expect(screen.getByRole('table', { name: 'チャンネルポイント報酬' })).toBeTruthy()
  })

  test('列の見出しと、行ごとのセルを持つ', () => {
    renderRewardTable()
    expect(screen.getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['名前', 'ポイント'])
    // 見出しの行と、データの2行
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['チャットで推理: 質問', '5'])
  })

  test('区分は名前の付いた行のまとまりで、帯に件数を添える', () => {
    renderRewardTable()
    const group = screen.getByRole('rowgroup', { name: 'HDAD で管理' })
    expect(within(group).getByText('2件')).toBeTruthy()
  })

  test('セルは中身を切り取らず折り返す（札が半分で切れたり、フォーカスの印が切れたりしないように）', () => {
    renderRewardTable()
    const cell = screen.getAllByRole('cell')[0] as HTMLElement
    expect(cell.className).not.toMatch(/\btruncate\b|overflow-hidden/)
    expect(cell.className).toMatch(/\bflex-wrap\b/)
  })

  test('列の幅は表に1回だけ渡し、行はそれを共有する', () => {
    renderRewardTable()
    const table = screen.getByRole('table')
    expect(table.style.getPropertyValue('--columns')).toBe('minmax(0,1fr) 6rem')
  })
})
