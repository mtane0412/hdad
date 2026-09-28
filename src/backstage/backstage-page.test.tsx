// @vitest-environment jsdom
/**
 * 裏方のページのテスト
 *
 * 確かめること:
 * - OBSに貼るURLに、オーバーレイ用キーが入ること
 * - 動かす裏方を外すと、URLに書き足されること
 * - 文字起こしを動かすときだけ、ポートの入力欄を出すこと
 * - ポートが読めない値なら、URLを出さずに理由を出すこと（既定へ黙って戻さない）
 * - 裏方をひとつも選んでいなければ、URLを出さずに理由を出すこと
 * - オーバーレイ用キーが無ければ、URLを出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { BackstagePage } from './backstage-page'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const URLの欄 = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')
const 読み上げのスイッチ = () => screen.getByRole('checkbox', { name: 'チャットの読み上げ' })
const 文字起こしのスイッチ = () => screen.getByRole('checkbox', { name: '文字起こしの中継' })

describe('裏方のページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  test('URLのコピーはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const コピーのボタン = screen.getByRole('button', { name: 'URLをコピー' })
    expect(コピーのボタン).toHaveTextContent('')
    expect(コピーのボタン).toHaveAttribute('title', 'URLをコピー')
  })

  test('読み上げを外すと、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    await userEvent.click(読み上げのスイッチ())

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&speech=false`)
  })

  test('文字起こしを動かすときだけ、ポートの入力欄を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(screen.getByLabelText('ゆかコネNEO のポート番号')).toBeInTheDocument()

    await userEvent.click(文字起こしのスイッチ())

    expect(screen.queryByLabelText('ゆかコネNEO のポート番号')).not.toBeInTheDocument()
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, '20000')

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&port=20000`)
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('裏方をひとつも選んでいなければ、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    await userEvent.click(読み上げのスイッチ())
    await userEvent.click(文字起こしのスイッチ())

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/1つ以上選んでください/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<BackstagePage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
