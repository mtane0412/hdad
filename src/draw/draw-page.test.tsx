// @vitest-environment jsdom
/**
 * 描く画面のテスト
 *
 * 描いた線そのものは canvas に描くので目では確かめられない。ここで確かめるのは、描く場所が名前を持って
 * 置かれること、中継先とのやりとりの具合が画面に出ること、そしてポインタの動きが線として送られることである。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawPage } from './draw-page'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID } from './tools'
import type { DrawSocketHandlers, DrawWriter } from './socket'
import type { DrawMessage } from './stroke'

/** 送られた線を覚えておく、テスト用の中継先 */
const 中継先を作る = () => {
  const 送られたもの: DrawMessage[] = []
  let ハンドラ: DrawSocketHandlers | null = null
  let 閉じた回数 = 0
  const connect = (handlers: DrawSocketHandlers): DrawWriter => {
    ハンドラ = handlers
    return {
      send: (message) => {
        送られたもの.push(message)
        return true
      },
      close: () => {
        閉じた回数 += 1
      },
    }
  }
  return {
    送られたもの,
    connect,
    閉じた回数: () => 閉じた回数,
    切れたことにする: () => ハンドラ?.onStatus('disconnected'),
    つなぎ直したことにする: () => ハンドラ?.onStatus('reconnected'),
    知らせる: (message: string) => ハンドラ?.onWarning(message),
  }
}

/** jsdom は canvas の描画を持たないので、描画先だけ差し替える */
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    arc: () => {},
    fill: () => {},
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** 描く場所を取り出す。jsdom は要素の大きさを持たないので、測った結果だけ差し替える */
const 描く場所を得る = (): HTMLElement => {
  const キャンバス = screen.getByLabelText('配信画面に描く場所')
  vi.spyOn(キャンバス, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 400, height: 200 } as DOMRect)
  return キャンバス
}

describe('DrawPage', () => {
  it('描く場所を、名前を付けて置く', () => {
    render(<DrawPage connect={中継先を作る().connect} />)

    expect(screen.getByLabelText('配信画面に描く場所')).toBeTruthy()
  })

  it('接続が切れたら、その旨を出す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)

    act(() => 中継先.切れたことにする())

    expect(screen.getByRole('status').textContent).toContain('接続が切れました')
  })

  it('つなぎ直したら、知らせを消す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)

    act(() => 中継先.切れたことにする())
    act(() => 中継先.つなぎ直したことにする())

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('待てば直るかもしれない失敗は、理由を添えて出す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)

    act(() => 中継先.知らせる('ログインが切れていないか確かめてください'))

    expect(screen.getByRole('status').textContent).toContain('ログインが切れていないか確かめてください')
  })

  it('画面を離れたら、接続を閉じる', () => {
    // 閉じないと、ページを行き来するたびに接続が増えていく
    const 中継先 = 中継先を作る()
    const { unmount } = render(<DrawPage connect={中継先.connect} />)

    unmount()

    expect(中継先.閉じた回数()).toBe(1)
  })

  it('ポインタを押した場所から、線を描き始めたことを送る', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)
    const キャンバス = 描く場所を得る()

    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([
      { type: 'start', id: expect.any(String), point: { x: 0.25, y: 0.5 }, color: DEFAULT_COLOR_ID, width: DEFAULT_WIDTH_ID },
    ])
  })

  it('選んだ色と太さで、線を描き始める', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)
    const キャンバス = 描く場所を得る()

    await userEvent.click(screen.getByRole('radio', { name: '赤' }))
    await userEvent.click(screen.getByRole('radio', { name: '太い' }))
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([{ type: 'start', id: expect.any(String), point: { x: 0.25, y: 0.5 }, color: 'red', width: 'bold' }])
  })

  it('全消しを押したら、消したことを送る', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    await userEvent.click(screen.getByRole('button', { name: '全部消す' }))

    expect(中継先.送られたもの.at(-1)).toEqual({ type: 'clear' })
  })

  it('押していないあいだの動きは送らない', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} />)
    const キャンバス = 描く場所を得る()

    キャンバス.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([])
  })
})
