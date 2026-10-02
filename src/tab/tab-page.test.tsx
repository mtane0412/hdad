// @vitest-environment jsdom
/**
 * タブの映像のページ（/tab/）のテスト
 *
 * 取り込みと送信は拡張（extension/）の中で行い、映さないサイトの管理も拡張の設定ページで行うので、このページは
 * 拡張の入れ方と使い方を案内するだけである。次を確かめる。
 * - Chrome 拡張をこの置き場所用にダウンロードできる
 * - 映しているタブでもう一度押すと止まることを案内する（このページを開いたままにする必要がないことも）
 * - 映さないサイトの登録・解除の仕方（右クリックと拡張の設定）を案内する
 * - 映す範囲の選び方と外し方（右クリック）を案内する（issue #166）
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TabPage } from './tab-page'

afterEach(cleanup)

describe('TabPage', () => {
  it('Chrome 拡張をダウンロードできる', () => {
    // 拡張には、ダウンロードしたときの置き場所が書き込まれる（worker/tab-extension.ts）
    render(<TabPage />)

    expect(screen.getByRole('link', { name: '拡張をダウンロード' }).getAttribute('href')).toBe('/api/admin/tab/extension.zip')
  })

  it('映し方と止め方を案内する', () => {
    render(<TabPage />)

    expect(screen.getByText('映しているタブでもう一度押すと、映すのをやめます')).toBeTruthy()
    expect(screen.getByText(/このページは開いておかなくてかまいません/)).toBeTruthy()
  })

  it('映さないサイトの登録・解除の仕方を案内する', () => {
    render(<TabPage />)

    expect(screen.getByText(/拡張のボタンを右クリックして「このサイトを映さない」/)).toBeTruthy()
    expect(screen.getByText(/右クリックの「オプション」/)).toBeTruthy()
  })

  it('映す範囲の選び方と外し方を案内する', () => {
    render(<TabPage />)

    expect(screen.getByText(/拡張のボタンを右クリックして「映す範囲を選ぶ」/)).toBeTruthy()
    expect(screen.getByText(/「範囲を外す（タブ全体を映す）」/)).toBeTruthy()
  })
})
