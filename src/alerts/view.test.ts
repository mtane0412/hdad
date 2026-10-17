// @vitest-environment jsdom
/**
 * アラートの表示（view.ts）のテスト
 *
 * 下部バーの「演出を消す」にかかわる点だけを確かめる。
 * - 決まった秒数を待たずに、再生中のアラートを消えさせ、消え終わったら show が解決すること（次のアラートへ進めるため）
 * - 何も再生していなければ何もしないこと
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Alert } from './alert'
import { createAlertView } from './view'

/** 10秒出すフォローのアラート */
const followAlert: Alert = {
  media: { kind: 'image', url: 'https://hdad.example.com/media/follow.png' },
  text: '山田太郎さん、フォローありがとう！',
  durationSeconds: 10,
  volume: 0.8,
}

let root: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

afterEach(() => {
  vi.useRealTimers()
})

const alertsOf = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.alert')]

describe('createAlertView の dismiss', () => {
  it('決まった秒数を待たずに再生中のアラートを消えさせ、消え終わったら show が解決する', async () => {
    const view = createAlertView(root)
    const finished = vi.fn()
    void view.show(followAlert).then(finished)

    // 1秒たったところで「演出を消す」を受けた
    vi.advanceTimersByTime(1000)
    view.dismiss()

    expect(alertsOf()[0]?.classList.contains('alert--leaving')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(alertsOf()).toEqual([])
    expect(finished).toHaveBeenCalledOnce()

    // もとの10秒の予約が残っていても、二度は片付けない
    await vi.advanceTimersByTimeAsync(10_000)
    expect(finished).toHaveBeenCalledOnce()
  })

  it('何も再生していなければ何もしない', () => {
    const view = createAlertView(root)

    expect(() => view.dismiss()).not.toThrow()
    expect(alertsOf()).toEqual([])
  })
})
