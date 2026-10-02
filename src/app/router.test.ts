// @vitest-environment jsdom
/**
 * アプリ内のページ移動のテスト
 *
 * 確かめること:
 * - 別のページへ移ったら、前のページのスクロール位置を持ち越さず先頭から見せること
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { navigate } from './router'

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

describe('navigate', () => {
  test('移った先のページを先頭から見せる', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    navigate('/triggers/')

    expect(window.location.pathname).toBe('/triggers/')
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })
})
