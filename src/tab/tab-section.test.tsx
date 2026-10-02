// @vitest-environment jsdom
/**
 * コネクターのページの HDAD-tab（タブの映像の Chrome 拡張）の区画のテスト
 *
 * 取り込みと送信は拡張（extension/）の中で行い、映さないサイトの管理も拡張の設定ページで行うので、この区画は
 * 拡張を配り、入れ方と使い方をヘルプボタンの中で案内するだけである。次を確かめる。
 * - 区画の見出しは拡張の名前（HDAD-tab）であること
 * - Chrome 拡張をこの置き場所用にダウンロードできる
 * - 入れ方・映し方と止め方・映さないサイト・映す範囲は、ヘルプボタンを押したときだけ案内する（issue #165・#166）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TabSection } from './tab-section'

afterEach(cleanup)

/** ヘルプボタンを押して、使い方の説明を開く */
const openHelp = async () => userEvent.click(screen.getByRole('button', { name: 'HDAD-tabの説明' }))

describe('HDAD-tab の区画', () => {
  it('見出しは拡張の名前（HDAD-tab）にする', () => {
    render(<TabSection />)

    expect(screen.getByRole('heading', { name: 'HDAD-tab' })).toBeInTheDocument()
  })

  it('Chrome 拡張をダウンロードできる', () => {
    // 拡張には、ダウンロードしたときの置き場所が書き込まれる（worker/tab-extension.ts）
    render(<TabSection />)

    expect(screen.getByRole('link', { name: '拡張をダウンロード' })).toHaveAttribute('href', '/api/admin/tab/extension.zip')
  })

  it('使い方は、ヘルプボタンを押すまで出さない', () => {
    render(<TabSection />)

    expect(screen.queryByText(/chrome:\/\/extensions/)).not.toBeInTheDocument()
  })

  it('入れ方と、映し方・止め方を案内する', async () => {
    render(<TabSection />)
    await openHelp()

    expect(await screen.findByText(/chrome:\/\/extensions/)).toBeInTheDocument()
    expect(screen.getByText(/映しているタブでもう一度押すと止まります/)).toBeInTheDocument()
  })

  it('映さないサイトの登録・解除の仕方を案内する', async () => {
    render(<TabSection />)
    await openHelp()

    expect(await screen.findByText(/右クリックして「このサイトを映さない」/)).toBeInTheDocument()
    expect(screen.getByText(/右クリックの「オプション」/)).toBeInTheDocument()
  })

  it('映す範囲の選び方と外し方を案内する', async () => {
    render(<TabSection />)
    await openHelp()

    expect(await screen.findByText(/右クリックして「映す範囲を選ぶ」/)).toBeInTheDocument()
    expect(screen.getByText(/「範囲を外す（タブ全体を映す）」/)).toBeInTheDocument()
  })
})
