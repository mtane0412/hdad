// @vitest-environment jsdom
/**
 * アプリ内のページ移動のテスト
 *
 * 確かめること:
 * - 別のページへ移ったら、前のページのスクロール位置を持ち越さず先頭から見せること
 * - 未保存の変更があるページからは、移動（navigate・戻る）をすぐには行わず、確認を待つこと
 * - 確認で「移る」を選べば移り、「留まる」を選べば同じページに留まること
 * - 未保存の変更がなければ、確認を待たずにすぐ移ること
 * - 未保存の変更があるあいだだけ、再読み込みやタブを閉じる操作をブラウザに止めてもらうこと
 * - 未保存の変更があるかを、フックの外（WebMCP のツール）からも読めること
 * - 今のページを作り直させる（保存済みの中身を読み直させる）印を進められること
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasUnsavedChanges, navigate, reloadPage, usePageReloads, usePathname, usePendingNavigation, useUnsavedChanges } from './router'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

/** 開いているページと、そのページが未保存かどうかを渡して描く。返り値で現在のパスと確認待ちの移動を読める */
const renderPage = (path: string, unsaved: boolean) => {
  window.history.replaceState(null, '', path)
  return renderHook(
    ({ unsaved }: { unsaved: boolean }) => {
      useUnsavedChanges(unsaved)
      return { pathname: usePathname(), pending: usePendingNavigation() }
    },
    { initialProps: { unsaved } },
  )
}

describe('navigate', () => {
  test('移った先のページを先頭から見せる', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    navigate('/triggers/')

    expect(window.location.pathname).toBe('/triggers/')
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })

  test('未保存の変更がなければ、確認を待たずにすぐ移る', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { result } = renderPage('/bot/', false)

    act(() => navigate('/triggers/'))

    expect(result.current.pathname).toBe('/triggers/')
    expect(result.current.pending).toBeNull()
  })

  test('未保存の変更があると移らずに確認を待ち、「留まる」を選べば同じページに留まる', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { result } = renderPage('/bot/', true)

    act(() => navigate('/triggers/'))

    expect(result.current.pathname).toBe('/bot/')
    expect(window.location.pathname).toBe('/bot/')
    expect(result.current.pending).not.toBeNull()

    act(() => result.current.pending?.stay())

    expect(result.current.pending).toBeNull()
    expect(result.current.pathname).toBe('/bot/')
  })

  test('未保存の変更があっても、確認で「移る」を選べば移る', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { result } = renderPage('/bot/', true)

    act(() => navigate('/triggers/'))
    act(() => result.current.pending?.proceed())

    expect(result.current.pending).toBeNull()
    expect(result.current.pathname).toBe('/triggers/')
    expect(window.location.pathname).toBe('/triggers/')
  })

  test('保存して未保存の変更がなくなれば、確認を待たずに移る', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { result, rerender } = renderPage('/bot/', true)

    rerender({ unsaved: false })
    act(() => navigate('/triggers/'))

    expect(result.current.pathname).toBe('/triggers/')
    expect(result.current.pending).toBeNull()
  })

  test('いま開いているページへのリンクは、未保存でも確認を出さない（編集中の内容は消えないため）', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const { result } = renderPage('/bot/', true)

    act(() => navigate('/bot/'))

    expect(result.current.pending).toBeNull()
    expect(result.current.pathname).toBe('/bot/')
  })
})

describe('ブラウザの「戻る」', () => {
  test('未保存の変更があると、戻らずに確認を待ち、「留まる」を選べばURLも元に戻る', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    window.history.replaceState(null, '', '/')
    navigate('/bot/')
    const { result } = renderHook(() => {
      useUnsavedChanges(true)
      return { pathname: usePathname(), pending: usePendingNavigation() }
    })

    act(() => window.history.back())

    await waitFor(() => expect(result.current.pending).not.toBeNull())
    await waitFor(() => expect(window.location.pathname).toBe('/bot/'))
    expect(result.current.pathname).toBe('/bot/')

    act(() => result.current.pending?.stay())

    expect(result.current.pending).toBeNull()
    expect(result.current.pathname).toBe('/bot/')
  })

  test('未保存の変更があっても、確認で「移る」を選べば前のページに戻る', async () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    window.history.replaceState(null, '', '/')
    navigate('/bot/')
    const { result } = renderHook(() => {
      useUnsavedChanges(true)
      return { pathname: usePathname(), pending: usePendingNavigation() }
    })

    act(() => window.history.back())
    await waitFor(() => expect(result.current.pending).not.toBeNull())
    await waitFor(() => expect(window.location.pathname).toBe('/bot/'))

    act(() => result.current.pending?.proceed())

    await waitFor(() => expect(result.current.pathname).toBe('/'))
    expect(window.location.pathname).toBe('/')
    expect(result.current.pending).toBeNull()
  })
})

describe('再読み込み・タブを閉じる操作', () => {
  /** ブラウザが再読み込みの前に送る知らせを真似る。止めてもらったかどうかを返す */
  const dispatchBeforeUnload = (): boolean => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  test('未保存の変更があるあいだは、ブラウザに止めてもらう', () => {
    renderPage('/bot/', true)
    expect(dispatchBeforeUnload()).toBe(true)
  })

  test('未保存の変更がなければ、止めない', () => {
    const { rerender } = renderPage('/bot/', true)
    rerender({ unsaved: false })
    expect(dispatchBeforeUnload()).toBe(false)
  })
})

describe('フックの外から読む・作り直させる', () => {
  test('未保存の変更があるあいだだけ hasUnsavedChanges が true になる', () => {
    const { rerender } = renderPage('/triggers/', true)
    expect(hasUnsavedChanges()).toBe(true)

    // 保存して未保存の変更がなくなった
    rerender({ unsaved: false })
    expect(hasUnsavedChanges()).toBe(false)
  })

  test('reloadPage を呼ぶと、ページを作り直すための印が進む', () => {
    const { result } = renderHook(() => usePageReloads())
    const before = result.current

    act(() => reloadPage())

    expect(result.current).toBe(before + 1)
  })
})
