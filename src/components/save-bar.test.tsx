// @vitest-environment jsdom
/**
 * 保存のバー（save-bar.tsx）のテスト。
 *
 * どのページでも保存ボタンを同じ形で出すこと（文言は「〜を保存する」、未保存の印は「点＋語」、
 * 押せないのは保存の最中だけ、ページ全体を保存するときは下に貼り付ける）を確かめる。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SaveBar } from './save-bar'

afterEach(cleanup)

describe('SaveBar', () => {
  test('押すと保存する', async () => {
    const onSave = vi.fn()
    render(<SaveBar label="音を保存する" busy={false} onSave={onSave} />)

    await userEvent.click(screen.getByRole('button', { name: '音を保存する' }))

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  test('保存の最中は押せない（二重に送らないため）', () => {
    render(<SaveBar label="音を保存する" busy={true} onSave={vi.fn()} />)

    expect(screen.getByRole('button', { name: '音を保存する' })).toBeDisabled()
  })

  test('未保存の変更があれば、対応待ちの色の点と語で知らせる', () => {
    render(<SaveBar label="音を保存する" busy={false} unsaved={true} onSave={vi.fn()} />)

    expect(screen.getByText('未保存の変更があります').closest('[data-tone]')).toHaveAttribute('data-tone', 'attention')
    expect(screen.getByRole('button', { name: '音を保存する' })).toBeEnabled()
  })

  test('変更が無いあいだは印を出さないが、押せる（読み込んだ値をそのまま保存し直すことにも意味があるため）', () => {
    render(<SaveBar label="音を保存する" busy={false} unsaved={false} onSave={vi.fn()} />)

    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '音を保存する' })).toBeEnabled()
  })

  test('行の中では「保存する」と見せ、読み上げの名前に何を保存するかを含める', () => {
    render(<SaveBar label="保存する" name="乾杯する を保存する" busy={false} onSave={vi.fn()} />)

    expect(screen.getByRole('button', { name: '乾杯する を保存する' })).toHaveTextContent('保存する')
  })

  test('ページ全体を保存するバーは、画面の下に貼り付ける', () => {
    const { container } = render(<SaveBar label="構成を保存する" busy={false} sticky onSave={vi.fn()} />)

    expect((container.firstElementChild as HTMLElement).className).toMatch(/\bsticky\b/)
  })

  test('ほかのボタン（消すなど）を保存のボタンの横に並べられる', () => {
    render(
      <SaveBar label="保存する" busy={false} onSave={vi.fn()}>
        <button type="button">消す</button>
      </SaveBar>,
    )

    expect(screen.getByRole('button', { name: '消す' })).toBeInTheDocument()
  })
})
