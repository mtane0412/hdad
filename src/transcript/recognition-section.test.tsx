// @vitest-environment jsdom
/**
 * コネクターのページの Web Speech API の区画（recognition-section.tsx）のテスト
 *
 * 音声認識の文脈の値をそのまま渡し、オン・オフ・始め直し・送った発話の出し方を確かめる。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecognitionContextValue } from './recognition-context'
import { RecognitionSectionView } from './recognition-section'

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
  obsMuteInputName: '',
  setObsMuteInputName: vi.fn(),
  obsMute: null,
  ...overrides,
})

afterEach(() => {
  cleanup()
})

describe('RecognitionSectionView', () => {
  it('スイッチでオンにできる', () => {
    const value = baseValue()
    render(<RecognitionSectionView value={value} />)

    fireEvent.click(screen.getByRole('switch', { name: '文字起こしする' }))

    expect(value.setEnabled).toHaveBeenCalledWith(true)
  })

  it('聞いているあいだは、話している途中の文・つなぎ直した回数・途切れた時間を出す', () => {
    render(
      <RecognitionSectionView
        value={baseValue({
          enabled: true,
          phase: 'running',
          recognizer: { status: { kind: 'listening' }, interim: '今日は雑談', restarts: 12, interruptedMs: 4_200 },
        })}
      />,
    )

    expect(screen.getByText('聞いています')).toBeTruthy()
    expect(screen.getByText('今日は雑談')).toBeTruthy()
    expect(screen.getByText('つなぎ直し 12回・途切れた時間 4秒')).toBeTruthy()
  })

  it('止まってしまったら理由を出し、始め直せる', () => {
    const value = baseValue({
      enabled: true,
      phase: 'running',
      recognizer: { status: { kind: 'failed', message: 'マイクが外れました' }, interim: '', restarts: 0, interruptedMs: 0 },
    })
    render(<RecognitionSectionView value={value} />)

    expect(screen.getByText('マイクが外れました')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度始める' }))

    expect(value.restart).toHaveBeenCalled()
  })

  it('字幕の中継先へ送れていなければ、その理由を出す', () => {
    render(
      <RecognitionSectionView
        value={baseValue({
          enabled: true,
          phase: 'running',
          recognizer: { status: { kind: 'listening' }, interim: '', restarts: 0, interruptedMs: 0 },
          captionWarning: '字幕の中継先につながりません。ログインが切れていないか確かめてください',
        })}
      />,
    )

    expect(screen.getByText('字幕の中継先につながりません。ログインが切れていないか確かめてください')).toBeTruthy()
  })

  it('字幕の翻訳に失敗していれば、その理由を出す', () => {
    render(
      <RecognitionSectionView
        value={baseValue({
          enabled: true,
          phase: 'running',
          recognizer: { status: { kind: 'listening' }, interim: '', restarts: 0, interruptedMs: 0 },
          translationWarning: '字幕の翻訳に失敗しました: DeepL が失敗を返しました（456）',
        })}
      />,
    )

    expect(screen.getByText('字幕の翻訳に失敗しました: DeepL が失敗を返しました（456）')).toBeTruthy()
  })

  it('ミュートを見張る OBS の入力の名前を入れて保存すると、前後の空白を落として覚えさせる', () => {
    const value = baseValue()
    render(<RecognitionSectionView value={value} />)

    fireEvent.change(screen.getByLabelText('ミュートを見張るOBSの入力'), { target: { value: ' マイク ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(value.setObsMuteInputName).toHaveBeenCalledWith('マイク')
  })

  it('入力の名前を変えていなければ、保存ボタンを押せない', () => {
    render(<RecognitionSectionView value={baseValue({ obsMuteInputName: 'マイク' })} />)

    expect(screen.getByLabelText('ミュートを見張るOBSの入力')).toHaveProperty('value', 'マイク')
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true)
  })

  it('OBS のミュートを見張れていなければ、その理由を出す', () => {
    render(
      <RecognitionSectionView
        value={baseValue({
          enabled: true,
          phase: 'running',
          obsMuteInputName: 'マイク',
          recognizer: { status: { kind: 'listening' }, interim: '', restarts: 0, interruptedMs: 0 },
          obsMute: { state: { kind: 'failed', message: 'ws://localhost:4455 につながりませんでした' }, muted: false },
        })}
      />,
    )

    expect(screen.getByText('OBSのミュートを見張れていません: ws://localhost:4455 につながりませんでした')).toBeTruthy()
  })

  it('送った発話を、記録できたかどうかと一緒に新しいものから並べる', () => {
    render(
      <RecognitionSectionView
        value={baseValue({
          enabled: true,
          phase: 'running',
          lines: [
            { id: 'webspeech:2', text: '今日は雑談をします', state: 'failed', error: 'Workerが 503 を返しました' },
            { id: 'webspeech:1', text: 'こんばんは', state: 'recorded' },
          ],
        })}
      />,
    )

    const items = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toEqual(['今日は雑談をします送れませんでした: Workerが 503 を返しました', 'こんばんは記録'])
  })
})
