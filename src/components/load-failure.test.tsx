// @vitest-environment jsdom
/**
 * ページの中身を読み込めなかったときの表示（LoadFailure）のテスト
 *
 * 確かめること:
 * - 何を読めなかったかと、その理由を出すこと
 * - その場でもう一度読み込むボタンを出し、押したら読み込み直すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LoadFailure } from './load-failure'

afterEach(cleanup)

describe('LoadFailure', () => {
  test('読めなかったものと理由を出し、「もう一度読み込む」で読み込み直す', async () => {
    const retry = vi.fn()
    render(<LoadFailure title="読み上げの設定を読み込めませんでした" message="Workerが 500 を返しました" onRetry={retry} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('読み上げの設定を読み込めませんでした')
    expect(alert).toHaveTextContent('Workerが 500 を返しました')

    await userEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
