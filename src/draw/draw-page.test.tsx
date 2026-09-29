// @vitest-environment jsdom
/**
 * 描く画面のテスト
 *
 * 描いた線そのものは canvas に描くので目では確かめられない。ここで確かめるのは、描く場所が名前を持って
 * 置かれること、中継先とのやりとりの具合が画面に出ること、ポインタの動きが線として送られること、そして
 * 描いたものの保存と読み出し（issue #133）が通ることである。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawPage } from './draw-page'
import { BACKGROUND_POLL_MS } from './use-background'
import { SAVE_DELAY_MS } from './save'
import { DEFAULT_COLOR_ID, DEFAULT_WIDTH_ID } from './tools'
import type { DrawBackgroundResult } from './api'
import type { DrawSocketHandlers, DrawWriter } from './socket'
import type { DrawMessage } from './stroke'
import type { Strokes } from './strokes'

/** 書き込まれた内容を覚えておく、テスト用の保存先。読み出しの応答を保留できるようにしてある */
const 保存先を作る = (保存されているもの: Strokes = { strokes: [] }, 背景: DrawBackgroundResult = { kind: 'none' }) => {
  const 書かれたもの: Strokes[] = []
  /** 背景を読みに来たときに添えられた印（読みに来た回数も分かる） */
  const 背景を読んだ印: (string | null)[] = []
  let 読み出しを解く: (() => void) | null = null
  let 保留する = false
  return {
    書かれたもの,
    背景を読んだ印,
    読み出しを保留する: () => {
      保留する = true
    },
    読み出しを解く: () => 読み出しを解く?.(),
    api: {
      load: async () => {
        if (保留する) await new Promise<void>((resolve) => (読み出しを解く = resolve))
        return 保存されているもの
      },
      save: async (strokes: Strokes) => {
        書かれたもの.push(strokes)
      },
      loadBackground: async (etag: string | null) => {
        背景を読んだ印.push(etag)
        // 2回目からは、手元と同じ1枚として扱う
        return 背景を読んだ印.length > 1 && 背景.kind === 'image' ? { kind: 'unchanged' as const } : 背景
      },
    },
  }
}

/** 読み書きのどちらも失敗する保存先 */
const 失敗する保存先 = (理由: string) => ({
  load: async (): Promise<Strokes> => {
    throw new Error(理由)
  },
  save: async (): Promise<void> => {
    throw new Error(理由)
  },
  loadBackground: async (): Promise<DrawBackgroundResult> => {
    throw new Error(理由)
  },
})

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
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る().api} />)

    expect(screen.getByLabelText('配信画面に描く場所')).toBeTruthy()
  })

  it('接続が切れたら、その旨を出す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)

    act(() => 中継先.切れたことにする())

    expect(screen.getByRole('status').textContent).toContain('接続が切れました')
  })

  it('つなぎ直したら、知らせを消す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)

    act(() => 中継先.切れたことにする())
    act(() => 中継先.つなぎ直したことにする())

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('待てば直るかもしれない失敗は、理由を添えて出す', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)

    act(() => 中継先.知らせる('ログインが切れていないか確かめてください'))

    expect(screen.getByRole('status').textContent).toContain('ログインが切れていないか確かめてください')
  })

  it('画面を離れたら、接続を閉じる', () => {
    // 閉じないと、ページを行き来するたびに接続が増えていく
    const 中継先 = 中継先を作る()
    const { unmount } = render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)

    unmount()

    expect(中継先.閉じた回数()).toBe(1)
  })

  it('ポインタを押した場所から、線を描き始めたことを送る', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()

    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([
      { type: 'start', id: expect.any(String), point: { x: 0.25, y: 0.5 }, color: DEFAULT_COLOR_ID, width: DEFAULT_WIDTH_ID },
    ])
  })

  it('選んだ色と太さで、線を描き始める', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()

    // 色と太さは、アイコンを押して開いた選択肢から選ぶ
    await userEvent.click(screen.getByRole('button', { name: '線の色' }))
    await userEvent.click(screen.getByRole('radio', { name: '赤' }))
    await userEvent.click(screen.getByRole('button', { name: '線の太さ' }))
    await userEvent.click(screen.getByRole('radio', { name: '太い' }))
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([{ type: 'start', id: expect.any(String), point: { x: 0.25, y: 0.5 }, color: 'red', width: 'bold' }])
  })

  it('色を選んだら、選択肢を閉じる', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る().api} />)

    await userEvent.click(screen.getByRole('button', { name: '線の色' }))
    await userEvent.click(screen.getByRole('radio', { name: '赤' }))

    await waitFor(() => expect(screen.queryByRole('radio', { name: '赤' })).toBeNull())
  })

  it('仕様の説明は、iボタンを押したときだけ出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る().api} />)
    expect(screen.queryByText(/触れた線を1本消す/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '手書きについて' }))

    expect(screen.getByText(/触れた線を1本消す/)).toBeInTheDocument()
  })

  it('全消しを押したら、消したことを送る', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    await userEvent.click(screen.getByRole('button', { name: '全部消す' }))

    expect(中継先.送られたもの.at(-1)).toEqual({ type: 'clear' })
  })

  it('消しゴムで線に触れたら、その線を消したことを送る', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
    キャンバス.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 100, bubbles: true }))
    キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 300, clientY: 100, bubbles: true }))
    const 引いた線 = 中継先.送られたもの[0]

    await userEvent.click(screen.getByRole('radio', { name: '消しゴム' }))
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 100, bubbles: true }))

    expect(引いた線?.type).toBe('start')
    expect(中継先.送られたもの.at(-1)).toEqual({ type: 'erase', id: 引いた線?.type === 'start' ? 引いた線.id : '' })
  })

  it('消しゴムを選んでいるあいだは、線を描かない', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()

    await userEvent.click(screen.getByRole('radio', { name: '消しゴム' }))
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
    キャンバス.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([])
  })

  it('消しゴムで消した線は、同じ消しゴムの動きで二度は送らない', async () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
    キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))

    await userEvent.click(screen.getByRole('radio', { name: '消しゴム' }))
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
    キャンバス.dispatchEvent(new PointerEvent('pointermove', { clientX: 101, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの.filter(({ type }) => type === 'erase')).toHaveLength(1)
  })

  it('押していないあいだの動きは送らない', () => {
    const 中継先 = 中継先を作る()
    render(<DrawPage connect={中継先.connect} api={保存先を作る().api} />)
    const キャンバス = 描く場所を得る()

    キャンバス.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }))

    expect(中継先.送られたもの).toEqual([])
  })
})

describe('DrawPage の保存（issue #133）', () => {
  it('線を引き終えたら、数秒待ってから描いたものを保存する', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る()
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      // 保存されているものを読めてから書き始めるので、読み出しの応答を待つ
      await act(() => vi.advanceTimersByTimeAsync(0))

      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 120, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)?.strokes.map(({ points }) => points.length)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('全消しを押したら、待たずに「線が無い状態」を保存する', async () => {
    const 保存先 = 保存先を作る()
    render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    await userEvent.click(screen.getByRole('button', { name: '全部消す' }))

    expect(保存先.書かれたもの.at(-1)).toEqual({ strokes: [] })
  })

  it('消しゴムで消したら、数秒待ってから消したあとの状態を保存する', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る({ strokes: [{ id: '前に引いた線', points: [{ x: 0.5, y: 0.5 }], color: 'red', width: 'bold' }] })
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      await act(() => vi.advanceTimersByTimeAsync(0))

      // userEvent は偽の時計のもとでは進まないので、押す操作だけを直接起こす
      act(() => screen.getByRole('radio', { name: '消しゴム' }).click())
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)).toEqual({ strokes: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('開き直したときは、保存されている線の続きから描ける', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る({ strokes: [{ id: '前に引いた線', points: [{ x: 0.5, y: 0.5 }], color: 'red', width: 'bold' }] })
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      // 読み出しの応答を待ってから描く
      await act(() => vi.advanceTimersByTimeAsync(0))

      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)?.strokes.map(({ id }) => id)).toEqual(['前に引いた線', expect.any(String)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('保存されている線を読めなかったら、その旨を出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={失敗する保存先('ログインが切れています')} />)

    expect((await screen.findByRole('status')).textContent).toContain('ログインが切れています')
  })

  it('保存に失敗したら、その旨を出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={失敗する保存先('ログインが切れています')} />)
    const キャンバス = 描く場所を得る()
    キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))

    await userEvent.click(screen.getByRole('button', { name: '全部消す' }))

    expect((await screen.findByRole('status')).textContent).toContain('ログインが切れています')
  })
})

describe('DrawPage の保存と、保存されている図の守り', () => {
  /** 前の配信で描いて保存されている図 */
  const 保存されている図: Strokes = { strokes: [{ id: '前に引いた線', points: [{ x: 0.5, y: 0.5 }], color: 'red', width: 'bold' }] }

  it('保存されているものを読み終える前に引き終えた線は、まだ保存しない', async () => {
    // 読む前に書くと、保存されている図を消してしまう
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る(保存されている図)
      保存先.読み出しを保留する()
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()

      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('読み終える前に引いた線は、読めた時点でまとめて保存する', async () => {
    // 読めるまで書けずにいた線が、次の線を引くまで保存されないままにならないようにする
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る(保存されている図)
      保存先.読み出しを保留する()
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))

      await act(async () => {
        保存先.読み出しを解く()
      })
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)?.strokes.map(({ id }) => id)).toEqual(['前に引いた線', expect.any(String)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('読み終えたあとは、保存されているものと合わせて保存する', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る(保存されている図)
      保存先.読み出しを保留する()
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))

      await act(async () => {
        保存先.読み出しを解く()
      })
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 200, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)?.strokes.map(({ id }) => id)).toEqual(['前に引いた線', expect.any(String), expect.any(String)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('読み出しに失敗したら、描いたものを保存せず、その旨を出す', async () => {
    // 読めなかったものを上書きしない（保存されている図を、見えないまま消してしまわない）
    vi.useFakeTimers()
    try {
      const 書かれたもの: Strokes[] = []
      render(
        <DrawPage
          connect={中継先を作る().connect}
          api={{
            load: async () => {
              throw new Error('ログインが切れています')
            },
            loadBackground: async () => ({ kind: 'none' }),
            save: async (strokes) => {
              書かれたもの.push(strokes)
            },
          }}
        />,
      )
      const キャンバス = 描く場所を得る()
      await act(() => vi.advanceTimersByTimeAsync(0))

      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(書かれたもの).toEqual([])
      expect(screen.getByRole('status').textContent).toContain('保存されません')
    } finally {
      vi.useRealTimers()
    }
  })

  it('読み終える前に全消しを押したら、あとから届いた保存ぶんを描き直さない', async () => {
    // 消したのに、読み出しの応答で図が戻ってきてはいけない
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る(保存されている図)
      保存先.読み出しを保留する()
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()

      await act(async () => {
        screen.getByRole('button', { name: '全部消す' }).click()
      })
      await act(async () => {
        保存先.読み出しを解く()
      })
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))
      await act(() => vi.advanceTimersByTimeAsync(SAVE_DELAY_MS))

      expect(保存先.書かれたもの.at(-1)?.strokes.map(({ id }) => id)).toEqual([expect.any(String)])
    } finally {
      vi.useRealTimers()
    }
  })

  it('画面を離れるときは、待っている保存を書き切る', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る()
      const { unmount } = render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)
      const キャンバス = 描く場所を得る()
      await act(() => vi.advanceTimersByTimeAsync(0))
      キャンバス.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }))
      キャンバス.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, clientY: 100, bubbles: true }))

      unmount()
      await act(() => vi.advanceTimersByTimeAsync(0))

      expect(保存先.書かれたもの.map(({ strokes }) => strokes.length)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DrawPage の背景（配信画面を撮った最新の1枚）', () => {
  /** 2026-09-29 21:05（日本時間）に撮った1枚 */
  const 撮った時刻 = Date.parse('2026-09-29T12:05:00Z')
  const 画像のURL = 'https://i.gyazo.com/abcdef0123456789abcdef0123456789.png'
  const 配信画面: DrawBackgroundResult = { kind: 'image', url: 画像のURL, etag: '"abcdef0123456789abcdef0123456789"', capturedAt: 撮った時刻 }

  /** 背景を敷くかを切り替えるアイコン（押すたびに入と切が入れ替わる） */
  const スイッチ = (): HTMLElement => screen.getByRole('button', { name: '配信画面を背景に敷く' })

  it('既定では背景を敷かず、読みにも行かない', () => {
    const 保存先 = 保存先を作る(undefined, 配信画面)
    render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)

    expect(screen.queryByRole('img', { name: '背景に敷いた配信画面' })).toBeNull()
    expect(保存先.背景を読んだ印).toEqual([])
  })

  it('スイッチを入れると押された見た目になり、配信画面の1枚を少し薄くして敷く', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)
    expect(スイッチ()).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(スイッチ())

    const 背景 = await screen.findByRole('img', { name: '背景に敷いた配信画面' })
    expect(背景).toHaveAttribute('src', 画像のURL)
    expect(背景.style.opacity).toBe('0.6')
    expect(スイッチ()).toHaveAttribute('aria-pressed', 'true')
  })

  it('いつ撮った画面かは、iボタンの説明に出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)
    await userEvent.click(スイッチ())
    await screen.findByRole('img', { name: '背景に敷いた配信画面' })
    expect(screen.queryByText(/に撮影/)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '手書きについて' }))

    expect(screen.getByText(/に撮影/)).toBeInTheDocument()
  })

  it('背景を敷いていないあいだは、濃さを変えるアイコンを出さない', () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)

    expect(screen.queryByRole('button', { name: '背景の濃さを変える' })).toBeNull()
  })

  it('濃さを変えると、背景の濃さが変わる', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)
    await userEvent.click(スイッチ())
    const 背景 = await screen.findByRole('img', { name: '背景に敷いた配信画面' })
    await userEvent.click(screen.getByRole('button', { name: '背景の濃さを変える' }))

    // jsdom では Base UI の Slider のつまみが隠れたままなので、外枠の名前から入力要素を探す
    fireEvent.change(within(screen.getByRole('group', { name: '背景の濃さ' })).getByRole('slider', { hidden: true }), { target: { value: '30' } })

    expect(背景.style.opacity).toBe('0.3')
  })

  it('スイッチを切ると、背景を外す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)
    await userEvent.click(スイッチ())
    await screen.findByRole('img', { name: '背景に敷いた配信画面' })

    await userEvent.click(スイッチ())

    expect(screen.queryByRole('img', { name: '背景に敷いた配信画面' })).toBeNull()
  })

  it('画像を読み込めなければ、その旨を出す', async () => {
    // 公開範囲を「自分だけ」にしていたころに上げた画像は、ブラウザから読めない
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る(undefined, 配信画面).api} />)
    await userEvent.click(スイッチ())
    const 背景 = await screen.findByRole('img', { name: '背景に敷いた配信画面' })

    fireEvent.error(背景)

    expect(screen.getByText(/背景の画像を読み込めませんでした/)).toBeInTheDocument()
  })

  it('まだ1枚も無ければ、その旨を出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={保存先を作る().api} />)

    await userEvent.click(スイッチ())

    expect(await screen.findByText(/背景にできる配信画面がまだありません/)).toBeInTheDocument()
  })

  it('読めなければ、理由を添えて出す', async () => {
    render(<DrawPage connect={中継先を作る().connect} api={失敗する保存先('ログインしてください')} />)

    await userEvent.click(スイッチ())

    expect(await screen.findByText(/背景を読めませんでした: ログインしてください/)).toBeInTheDocument()
  })

  it('敷いているあいだは読みに来続け、手元の1枚の印を添える', async () => {
    vi.useFakeTimers()
    try {
      const 保存先 = 保存先を作る(undefined, 配信画面)
      render(<DrawPage connect={中継先を作る().connect} api={保存先.api} />)

      // userEvent は偽の時計のもとでは進まないので、押す操作だけを直接起こす
      act(() => スイッチ().click())
      await act(() => vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS))

      expect(保存先.背景を読んだ印).toEqual([null, '"abcdef0123456789abcdef0123456789"'])
    } finally {
      vi.useRealTimers()
    }
  })
})
