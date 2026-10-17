// @vitest-environment jsdom
/**
 * 下部バーの「演出を消す」のテスト
 *
 * 確かめること:
 * - 押すと Worker に演出を消すよう頼むこと（確かめのダイアログを挟まない。配信中にすぐ消したいため）
 * - 頼んでいるあいだは押せないこと（続けて押して二重に送らない）
 * - 断られたときは理由を出し、次に通ったら消すこと（Fail-Fast。消せたつもりで配信を続けないため）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { OverlayDismissApi } from './dismiss'
import { DismissControl } from './dismiss-control'

afterEach(cleanup)

const dismissButton = () => screen.getByRole('button', { name: '演出を消す' })

describe('DismissControl', () => {
  test('押すと、演出を消すよう Worker に頼む', async () => {
    const user = userEvent.setup()
    let calls = 0
    const api: OverlayDismissApi = {
      dismiss: async () => {
        calls += 1
      },
    }
    render(<DismissControl api={api} />)

    await user.click(dismissButton())

    expect(calls).toBe(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('頼んでいるあいだは押せない', async () => {
    const user = userEvent.setup()
    let finish = (): void => {}
    const api: OverlayDismissApi = { dismiss: () => new Promise<void>((resolve) => (finish = resolve)) }
    render(<DismissControl api={api} />)

    await user.click(dismissButton())
    expect(dismissButton()).toBeDisabled()

    finish()
    expect(await screen.findByRole('button', { name: '演出を消す' })).toBeEnabled()
  })

  test('断られたら理由を出し、次に通ったら理由を消す', async () => {
    const user = userEvent.setup()
    let fail = true
    const api: OverlayDismissApi = {
      dismiss: async () => {
        if (fail) throw new Error('合成ページへ演出を消す合図を送れませんでした')
      },
    }
    render(<DismissControl api={api} />)

    await user.click(dismissButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('合成ページへ演出を消す合図を送れませんでした')

    fail = false
    await user.click(dismissButton())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
