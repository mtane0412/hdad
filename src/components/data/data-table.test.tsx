// @vitest-environment jsdom
/**
 * 一覧の表（data-table.tsx）のテスト。
 *
 * 1項目＝1行の一覧を、名前の付いたリストとして読めること、列の見出しは見た目だけにすること、
 * 行を押すとその場で下に詳細が開くこと（aria-expanded・開いているときだけ aria-controls）、
 * 区分の帯に件数を添えられることを確かめる。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { DataTable, DataTableCell, DataTableGroup, DataTableRow } from './data-table'

afterEach(cleanup)

const HEADINGS = [{ label: '名前' }, { label: 'ポイント', align: 'end' }] as const

/** 開閉できる行を1つ持つ一覧。開いているかは呼び出し側が持つ（ページが「開くのは1件ずつ」を決めるため） */
const ExpandableTable = () => {
  const [open, setOpen] = useState(false)
  return (
    <DataTable label="チャンネルポイント報酬" columns="minmax(0,1fr) 6rem" headings={HEADINGS}>
      <DataTableRow label="乾杯する" expand={{ open, onToggle: () => setOpen(!open), detail: <p>乾杯する の入力欄</p> }}>
        <DataTableCell>乾杯する</DataTableCell>
        <DataTableCell align="end">100</DataTableCell>
      </DataTableRow>
      <DataTableRow label="水を飲む" dimmed>
        <DataTableCell>水を飲む</DataTableCell>
        <DataTableCell align="end">50</DataTableCell>
      </DataTableRow>
    </DataTable>
  )
}

describe('DataTable', () => {
  test('名前の付いたリストとして読め、行は名前の付いた項目になる', () => {
    render(<ExpandableTable />)

    const list = screen.getByRole('list', { name: 'チャンネルポイント報酬' })
    expect(within(list).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual(['乾杯する', '水を飲む'])
  })

  test('列の見出しは見た目だけにする（読み上げでは行の中身がそのまま読まれるため）', () => {
    const { container } = render(<ExpandableTable />)

    const header = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(header.textContent).toBe('名前ポイント')
  })

  test('列の幅は表に1回だけ渡し、見出しと行はそれを共有する', () => {
    const { container } = render(<ExpandableTable />)

    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--columns')).toBe('minmax(0,1fr) 6rem')
  })

  test('開ける行は名前から始まるボタンで、押すとその場で下に詳細が開き、もう一度押すと閉じる', async () => {
    render(<ExpandableTable />)

    const row = screen.getByRole('button', { name: /^乾杯する/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    // 閉じているあいだは詳細が無いので、無い要素を指さない
    expect(row).not.toHaveAttribute('aria-controls')
    expect(screen.queryByText('乾杯する の入力欄')).not.toBeInTheDocument()

    await userEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByText('乾杯する の入力欄').parentElement as HTMLElement
    expect(row.getAttribute('aria-controls')).toBe(detail.id)

    await userEvent.click(row)
    expect(screen.queryByText('乾杯する の入力欄')).not.toBeInTheDocument()
  })

  test('開けない行はボタンにしない（押せるのに何も起きない行を置かない）', () => {
    render(<ExpandableTable />)

    const item = screen.getByRole('listitem', { name: '水を飲む' })
    expect(within(item).queryByRole('button')).not.toBeInTheDocument()
  })

  test('薄く出す行は、開ける行でも薄いままにする（指しても通常の色に戻さない）', () => {
    render(
      <DataTable label="トリガー" columns="minmax(0,1fr)" headings={[{ label: '出来事' }]}>
        <DataTableRow label="すべての発言" dimmed expand={{ open: false, onToggle: () => undefined, detail: null }}>
          <DataTableCell>すべての発言</DataTableCell>
        </DataTableRow>
      </DataTable>,
    )

    expect(screen.getByRole('button', { name: /^すべての発言/ }).className).toMatch(/\btext-muted-foreground\b.*\bhover:text-muted-foreground\b/)
  })

  test('どの行も、指すと地の色を変える（開けない行でも、どの行を見ているか追えるように）', () => {
    render(<ExpandableTable />)

    for (const item of screen.getAllByRole('listitem')) expect((item.firstElementChild as HTMLElement).className).toMatch(/\bhover:bg-muted\/50\b/)
  })

  test('セルは中身を切り取らず折り返す（札が半分で切れたり、フォーカスの印が切れたりしないように）', () => {
    render(<ExpandableTable />)

    const cell = screen.getByText('水を飲む', { selector: 'span' })
    expect(cell.className).not.toMatch(/\btruncate\b|overflow-hidden/)
    expect(cell.className).toMatch(/\bflex-wrap\b/)
  })

  test('区分は名前の付いたリストで、帯に件数を添える', () => {
    render(
      <DataTable label="トリガー" columns="minmax(0,1fr)" headings={[{ label: '出来事' }]}>
        <DataTableGroup label="チャット" count="1 / 2">
          <DataTableRow label="決まった人の発言">
            <DataTableCell>決まった人の発言</DataTableCell>
          </DataTableRow>
        </DataTableGroup>
      </DataTable>,
    )

    const group = screen.getByRole('list', { name: 'チャット' })
    expect(within(group).getByRole('listitem', { name: '決まった人の発言' })).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })
})
