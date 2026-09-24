// @vitest-environment jsdom
/**
 * サイドスーパーのページのテスト
 *
 * 確かめること:
 * - OBSに貼るURLに、オーバーレイ用キーが入ること
 * - 出す位置を右上に変えると、URLに書き足されること
 * - オーバーレイ用キーが無ければ、URLを出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { SideSuperPage } from './side-super-page'

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const URLの欄 = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')

describe('サイドスーパーのページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<SideSuperPage overlayKey={オーバーレイ用キー} />)

    expect(URLの欄()).toHaveValue(`${window.location.origin}/side-super/overlay/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  test('出す位置を右上に変えると、URLに書き足す', async () => {
    render(<SideSuperPage overlayKey={オーバーレイ用キー} />)

    await userEvent.selectOptions(screen.getByLabelText('出す位置'), 'right')

    expect(URLの欄()).toHaveValue(`${window.location.origin}/side-super/overlay/?key=${encodeURIComponent(オーバーレイ用キー)}&position=right`)
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<SideSuperPage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
