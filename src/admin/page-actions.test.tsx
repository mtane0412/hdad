// @vitest-environment jsdom
/**
 * 操作の実行と結果の表示（usePageActions）のテスト
 *
 * 確かめること:
 * - 成功のお知らせは、押したボタンから離れたページの先頭ではなく、画面の下に浮かべて出すこと（場所を取らない）
 * - 成功のお知らせは数秒で消えること（失敗の理由は消さない）
 * - 失敗したら理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { NOTICE_VISIBLE_MS, usePageActions } from './page-actions'

const Harness = ({ action }: { action: () => Promise<string> }) => {
  const actions = usePageActions()
  return (
    <div>
      {actions.feedback}
      <button type="button" onClick={() => void actions.run(action)}>
        保存する
      </button>
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('usePageActions', () => {
  test('成功のお知らせを画面の下に浮かべて出し、しばらくすると消す', async () => {
    vi.useFakeTimers()
    render(<Harness action={async () => '設定を保存しました'} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    })

    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('設定を保存しました')
    expect(status.className).toContain('fixed')

    await act(async () => {
      vi.advanceTimersByTime(NOTICE_VISIBLE_MS)
    })
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  test('失敗したら理由を出し、時間が経っても消さない', async () => {
    vi.useFakeTimers()
    render(
      <Harness
        action={async () => {
          throw new Error('Workerに届きませんでした')
        }}
      />,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    })
    await act(async () => {
      vi.advanceTimersByTime(NOTICE_VISIBLE_MS)
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Workerに届きませんでした')
  })
})
