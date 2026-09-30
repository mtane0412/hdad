// @vitest-environment jsdom
/**
 * 文字起こしのページのテスト
 *
 * 確かめること:
 * - OBSに貼るURLに、オーバーレイ用キーが入ること
 * - ポートを既定から変えると、URLに書き足されること
 * - ポートが読めない値なら、URLを出さずに理由を出すこと（既定へ黙って戻さない）
 * - オーバーレイ用キーが無ければ、URLを出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { TranscriptPage } from './transcript-page'

const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const urlInput = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')

describe('文字起こしのページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<TranscriptPage overlayKey={OVERLAY_KEY} />)

    expect(urlInput()).toHaveValue(`${window.location.origin}/transcript/relay/?key=${encodeURIComponent(OVERLAY_KEY)}`)
  })

  test('URLのコピーはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<TranscriptPage overlayKey={OVERLAY_KEY} />)

    const copyButton = screen.getByRole('button', { name: 'URLをコピー' })
    expect(copyButton).toHaveTextContent('')
    expect(copyButton).toHaveAttribute('title', 'URLをコピー')
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    render(<TranscriptPage overlayKey={OVERLAY_KEY} />)

    const portInput = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portInput)
    await userEvent.type(portInput, '20000')

    expect(urlInput()).toHaveValue(
      `${window.location.origin}/transcript/relay/?key=${encodeURIComponent(OVERLAY_KEY)}&port=20000`,
    )
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    render(<TranscriptPage overlayKey={OVERLAY_KEY} />)

    const portInput = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portInput)
    await userEvent.type(portInput, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<TranscriptPage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
