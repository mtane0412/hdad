/**
 * 音声認識の状態の言い表し方（recognition-label.ts）のテスト
 */
import { describe, expect, it } from 'vitest'
import { describeRecognition, formatDuration } from './recognition-label'
import type { RecognizerState } from './recognizer'

const recognizerIn = (status: RecognizerState['status']): RecognizerState => ({ status, interim: '', restarts: 0, interruptedMs: 0 })

describe('describeRecognition', () => {
  it('このタブが聞いていれば、問題なしとして出す', () => {
    expect(describeRecognition({ phase: 'running', error: null, obsMute: null, recognizer: recognizerIn({ kind: 'listening' }) }, 0)).toEqual({
      label: '聞いています',
      tone: 'ok',
    })
  })

  it('つなぎ直しが一瞬なら問題なしのまま出し、長引いたら途切れていると出す', () => {
    // 黙っているだけでも数秒ごとにつなぎ直すので、そのたびに警告を出すと見慣れてしまう
    const value = { phase: 'running' as const, error: null, obsMute: null, recognizer: recognizerIn({ kind: 'reconnecting', since: 10_000, reason: 'no-speech' }) }

    expect(describeRecognition(value, 11_000)).toEqual({ label: '聞いています', tone: 'ok' })
    expect(describeRecognition(value, 20_000)).toEqual({ label: '途切れています（10秒）', tone: 'warn' })
  })

  it('認識が止まってしまったら、止まっていると出す', () => {
    const value = { phase: 'running' as const, error: null, obsMute: null, recognizer: recognizerIn({ kind: 'failed', message: 'マイクが外れました' }) }
    expect(describeRecognition(value, 0)).toEqual({ label: '止まっています', tone: 'error' })
  })

  it('別のタブが認識していれば、そう出す', () => {
    expect(describeRecognition({ phase: 'waiting', error: null, obsMute: null, recognizer: recognizerIn({ kind: 'stopped' }) }, 0)).toEqual({
      label: '別のタブで認識中',
      tone: 'idle',
    })
  })

  it('音声認識の無いブラウザでは、使えないと出す', () => {
    expect(describeRecognition({ phase: 'unsupported', error: null, obsMute: null, recognizer: recognizerIn({ kind: 'stopped' }) }, 0)).toMatchObject({
      tone: 'error',
    })
  })
})

describe('describeRecognition（OBS のマイクのミュート。issue #270）', () => {
  const listening = { phase: 'running' as const, error: null, recognizer: recognizerIn({ kind: 'listening' }) }

  it('OBS でミュートしているあいだは、ミュート中と出す', () => {
    const value = { phase: 'running' as const, error: null, recognizer: recognizerIn({ kind: 'stopped' }), obsMute: { state: { kind: 'watching' as const, muted: true }, muted: true } }

    expect(describeRecognition(value, 0)).toEqual({ label: 'OBSでミュート中', tone: 'idle' })
  })

  it('ミュートしたまま OBS を見張れなくなったら、解除に気づけないことを警告として出す', () => {
    const value = {
      phase: 'running' as const,
      error: null,
      recognizer: recognizerIn({ kind: 'stopped' }),
      obsMute: { state: { kind: 'failed' as const, message: 'ws://localhost:4455 との接続が切れました' }, muted: true },
    }

    expect(describeRecognition(value, 0)).toEqual({ label: 'OBSでミュート中（OBSを見張れていません）', tone: 'warn' })
  })

  it('聞いているが OBS を見張れていなければ、ミュートが効かないことを警告として出す', () => {
    const value = { ...listening, obsMute: { state: { kind: 'failed' as const, message: 'ws://localhost:4455 につながりませんでした' }, muted: false } }

    expect(describeRecognition(value, 0)).toEqual({ label: '聞いています（OBSのミュートを見張れていません）', tone: 'warn' })
  })

  it('OBS を見張れていて、ミュートしていなければ、ふだんどおり出す', () => {
    const value = { ...listening, obsMute: { state: { kind: 'watching' as const, muted: false }, muted: false } }

    expect(describeRecognition(value, 0)).toEqual({ label: '聞いています', tone: 'ok' })
  })

  it('認識が止まってしまったときは、ミュートより止まっていることを先に出す', () => {
    const value = {
      phase: 'running' as const,
      error: null,
      recognizer: recognizerIn({ kind: 'failed', message: 'マイクが外れました' }),
      obsMute: { state: { kind: 'watching' as const, muted: false }, muted: false },
    }

    expect(describeRecognition(value, 0)).toEqual({ label: '止まっています', tone: 'error' })
  })
})

describe('formatDuration', () => {
  it('1分未満は秒、それ以上は分と秒で表す', () => {
    expect(formatDuration(9_400)).toBe('9秒')
    expect(formatDuration(125_000)).toBe('2分5秒')
  })
})
