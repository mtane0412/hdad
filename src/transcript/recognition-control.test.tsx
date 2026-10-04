// @vitest-environment jsdom
/**
 * 下部バーに置く文字起こしの項目（recognition-control.tsx）のテスト
 *
 * 音声認識の文脈の値をそのまま渡し、オン・オフのボタンと、オンのあいだの状態の出し方を確かめる。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecognitionContextValue } from './recognition-context'
import { RecognitionControlView } from './recognition-control'

const baseValue = (overrides: Partial<RecognitionContextValue> = {}): RecognitionContextValue => ({
  enabled: false,
  setEnabled: vi.fn(),
  restart: vi.fn(),
  phase: 'off',
  error: null,
  recognizer: { status: { kind: 'stopped' }, interim: '', restarts: 0, interruptedMs: 0 },
  lines: [],
  captionWarning: null,
  translationWarning: null,
  ...overrides,
})

afterEach(() => {
  cleanup()
})

describe('RecognitionControlView', () => {
  it('オフのときは押されていないボタンを出し、押すとオンにする', () => {
    const value = baseValue()
    render(<RecognitionControlView value={value} />)

    const button = screen.getByRole('button', { name: '文字起こし' })
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)

    expect(value.setEnabled).toHaveBeenCalledWith(true)
  })

  it('プレーヤーの操作と同じく、ボタンは文字を出さずアイコンだけにする（名前は読み上げとホバーで分かる）', () => {
    render(<RecognitionControlView value={baseValue()} />)

    const button = screen.getByRole('button', { name: '文字起こし' })
    expect(button).toHaveTextContent(/^$/)
    expect(button).toHaveAttribute('title', '文字起こし')
  })

  it('オフのときは状態を出さない', () => {
    render(<RecognitionControlView value={baseValue()} />)

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('オンのときは押されたボタンを出し、押すとオフにする', () => {
    const value = baseValue({ enabled: true, phase: 'running', recognizer: { status: { kind: 'listening' }, interim: '', restarts: 0, interruptedMs: 0 } })
    render(<RecognitionControlView value={value} />)

    const button = screen.getByRole('button', { name: '文字起こし' })
    expect(button).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(button)

    expect(value.setEnabled).toHaveBeenCalledWith(false)
  })

  it('オンのあいだは状態を出し、押すと詳しい様子があるコネクターのページへ移る', () => {
    render(
      <RecognitionControlView
        value={baseValue({ enabled: true, phase: 'running', recognizer: { status: { kind: 'listening' }, interim: '', restarts: 0, interruptedMs: 0 } })}
      />,
    )

    expect(screen.getByRole('link', { name: '文字起こしの様子: 聞いています' })).toHaveAttribute('href', '/connectors/')
  })

  it('止まってしまったときも、止まっていると分かる状態を出す', () => {
    render(<RecognitionControlView value={baseValue({ enabled: true, phase: 'failed', error: '鍵を取れませんでした' })} />)

    expect(screen.getByRole('link', { name: '文字起こしの様子: 止まっています' })).toBeInTheDocument()
  })
})
