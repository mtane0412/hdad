// @vitest-environment jsdom
/**
 * 部品の見本ページ（/design/）のテスト。
 *
 * 見本ページは配信者が配信中に開くページではないので、サイドバーとページを探す窓には出さず、URLで開いたときだけ出す。
 * 中身は、データの型ごとの表示部品をすべての状態で並べたものになっていることを確かめる。
 */
import { cleanup, render, screen } from '@testing-library/react'
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

  test('一覧の表の見本を出す', () => {
    render(<DesignPage />)
    expect(screen.getByRole('table', { name: '一覧の見本' })).toBeTruthy()
  })
})
