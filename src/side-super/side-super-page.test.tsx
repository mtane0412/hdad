// @vitest-environment jsdom
/**
 * サイドスーパーのページのテスト
 *
 * 確かめること:
 * - OBSに貼るURLに、オーバーレイ用キーが入ること
 * - 出す位置を右上に変えると、URLに書き足されること
 * - オーバーレイ用キーが無ければ、URLを出さずに理由を出すこと
 * - サンプルを流すデモのリンクが、出す位置に合わせて出ること（生成を待たずに見栄えを確かめるため）
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

  test('サンプルを流すデモのリンクを、別のタブで開けるように出す', () => {
    render(<SideSuperPage overlayKey={オーバーレイ用キー} />)

    const リンク = screen.getByRole('link', { name: 'デモを開く' })
    expect(リンク).toHaveAttribute('href', `${window.location.origin}/side-super/overlay/?demo=true`)
    expect(リンク).toHaveAttribute('target', '_blank')
  })

  test('出す位置を右上に変えると、デモのリンクにも書き足す', async () => {
    render(<SideSuperPage overlayKey={オーバーレイ用キー} />)

    await userEvent.selectOptions(screen.getByLabelText('出す位置'), 'right')

    expect(screen.getByRole('link', { name: 'デモを開く' })).toHaveAttribute(
      'href',
      `${window.location.origin}/side-super/overlay/?demo=true&position=right`,
    )
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<SideSuperPage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
