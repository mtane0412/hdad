// @vitest-environment jsdom
/**
 * 部品の見本ページ（/design/）のテスト。
 *
 * 見本ページは配信者が配信中に開くページではないので、サイドバーとページを探す窓には出さず、URLで開いたときだけ出す。
 * 中身は、データの型ごとの表示部品をすべての状態で並べたものになっていることを確かめる。
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { DesignPage } from './design-page'
import { findPage, PAGE_GROUPS } from './pages'

afterEach(cleanup)

describe('見本ページの登録', () => {
  test('/design/ で開ける', () => {
    expect(findPage('/design/')?.name).toBe('部品の見本')
  })

  test('サイドバー（PAGE_GROUPS）には並ばない', () => {
    const paths = PAGE_GROUPS.flatMap((group) => group.pages.map((page) => page.path))
    expect(paths).not.toContain('/design/')
  })
})

describe('見本ページの中身', () => {
  test('状態の点をすべての種類で並べる', () => {
    const { container } = render(<DesignPage />)
    const tones = [...container.querySelectorAll('[data-tone]')].map((element) => element.getAttribute('data-tone'))
    for (const tone of ['positive', 'attention', 'negative', 'neutral']) expect(tones).toContain(tone)
  })

  test('種類の札を10色すべて並べる', () => {
    const { container } = render(<DesignPage />)
    const tones = new Set([...container.querySelectorAll('[data-tone]')].map((element) => element.getAttribute('data-tone')))
    for (const tone of ['orange', 'blue', 'purple', 'teal', 'pink', 'green', 'red', 'yellow', 'indigo', 'gray']) expect(tones).toContain(tone)
  })

  test('数量は値があるとき・0のとき・無いときを並べる', () => {
    render(<DesignPage />)
    expect(screen.getByText('1,500')).toBeTruthy()
    expect(screen.getByText('制限なし')).toBeTruthy()
  })

  test('一覧の表の見本を出し、開ける行を押すとその場で下に詳細が開く', async () => {
    render(<DesignPage />)
    expect(screen.getByRole('list', { name: '一覧の見本' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /^決まった人の発言/ }))

    // 開くと、行のボタンは開いた状態になり、下に保存のボタン（名前は「決まった人の発言 を保存する」）が出る
    expect(screen.getByRole('button', { name: /^決まった人の発言/, expanded: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: '決まった人の発言 を保存する' })).toBeTruthy()
  })

  test('集計の数のタイルの見本を出す', () => {
    render(<DesignPage />)
    expect(screen.getByRole('group', { name: '平均視聴者数' }).textContent).toContain('12')
  })

  test('保存のバーの見本は、未保存の印がある状態と無い状態を並べる', () => {
    render(<DesignPage />)
    expect(screen.getByText('未保存の変更があります').closest('[data-tone]')?.getAttribute('data-tone')).toBe('attention')
    expect(screen.getByRole('button', { name: '設定を保存する' })).toBeTruthy()
    expect(screen.getAllByText('未保存の変更があります')).toHaveLength(1)
  })
})
