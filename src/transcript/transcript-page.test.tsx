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

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const URLの欄 = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')

describe('文字起こしのページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<TranscriptPage overlayKey={オーバーレイ用キー} />)

    expect(URLの欄()).toHaveValue(`${window.location.origin}/transcript/relay/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    render(<TranscriptPage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO の WebSocket のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, '20000')

    expect(URLの欄()).toHaveValue(
      `${window.location.origin}/transcript/relay/?key=${encodeURIComponent(オーバーレイ用キー)}&port=20000`,
    )
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    render(<TranscriptPage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO の WebSocket のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<TranscriptPage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
