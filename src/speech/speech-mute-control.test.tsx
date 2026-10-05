// @vitest-environment jsdom
/**
 * 下部バーの読み上げのミュートのテスト（issue #238）
 *
 * 確かめること:
 * - 開いたときに Worker からミュートしているかを読み、ボタンの押された状態に映すこと
 * - 押すとミュート・解除を Worker に頼み、返ってきた値を映すこと
 * - 読めない・断られたときは理由を出すこと（Fail-Fast。ミュートできたつもりで配信を続けないため）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { SpeechMuteApi } from './api'
import { SpeechMuteControl } from './speech-mute-control'

afterEach(cleanup)

/** 切り替えを記録し、Worker と同じく保存した値を返す代役 */
const createApi = ({ muted = false, failLoad = false, failSave = false } = {}) => {
  const saved: boolean[] = []
  let current = muted
  const api: SpeechMuteApi = {
    load: async () => {
      if (failLoad) throw new Error('Workerにつながりません')
      return current
    },
    save: async (next) => {
      if (failSave) throw new Error('読み上げのミュートを配送先へ送れませんでした（500）')
      saved.push(next)
      current = next
      return current
    },
  }
  return { api, saved }
}

const muteButton = () => screen.getByRole('button', { name: 'チャットの読み上げをミュート' })

describe('SpeechMuteControl', () => {
  test('読み込むまでは押せず、読み込んだらミュートしていないことを映す', async () => {
    const { api } = createApi()

    render(<SpeechMuteControl api={api} />)

    expect(muteButton()).toBeDisabled()
    expect(await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: false })).toBeEnabled()
  })

  test('保存済みのミュートを映す（別の窓でミュートしたまま開いても食い違わない）', async () => {
    const { api } = createApi({ muted: true })

    render(<SpeechMuteControl api={api} />)

    expect(await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: true })).toBeEnabled()
  })

  test('押すとミュートし、もう一度押すと解除する', async () => {
    const user = userEvent.setup()
    const { api, saved } = createApi()
    render(<SpeechMuteControl api={api} />)
    await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: false })

    await user.click(muteButton())
    expect(await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: true })).toBeInTheDocument()

    await user.click(muteButton())
    expect(await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: false })).toBeInTheDocument()
    expect(saved).toEqual([true, false])
  })

  test('読めなければ理由を出し、押せないままにする', async () => {
    const { api } = createApi({ failLoad: true })

    render(<SpeechMuteControl api={api} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerにつながりません')
    expect(muteButton()).toBeDisabled()
  })

  test('切り替えを断られたら理由を出し、押された状態を変えない', async () => {
    const user = userEvent.setup()
    const { api } = createApi({ failSave: true })
    render(<SpeechMuteControl api={api} />)
    await screen.findByRole('button', { name: 'チャットの読み上げをミュート', pressed: false })

    await user.click(muteButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('配送先へ送れませんでした')
    expect(muteButton()).toHaveAttribute('aria-pressed', 'false')
  })
})
