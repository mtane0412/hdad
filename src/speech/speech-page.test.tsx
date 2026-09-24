// @vitest-environment jsdom
/**
 * チャットの読み上げのページのテスト
 *
 * 確かめること:
 * - OBSに貼るURLを出し、設定を変えるとURLに反映されること
 * - 接続しているbotのログイン名が、読み上げない人としてURLに入ること（botの応答を読み上げさせないため）
 * - botの接続状態を読めなかったときも、URLは出して理由を添えること
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { BotStatus } from '@/bot/api'
import { SpeechPage } from './speech-page'

afterEach(cleanup)

/** 前提: botアカウント「hdad_bot」が接続されている */
const 接続済みのbot: BotStatus = { userId: '123456789', login: 'hdad_bot', missingScopes: [], isModerator: true }

/** botの接続状態を返すだけのAPI */
const botApi = (status: BotStatus | null) => ({ status: () => Promise.resolve(status) })

const URLの欄 = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')

describe('チャットの読み上げのページ', () => {
  test('既定の設定なら、パラメータの付かないURLを出す', async () => {
    render(<SpeechPage botApi={botApi(null)} />)

    await waitFor(() => expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/`))
  })

  test('話者IDを変えると、URLに反映する', async () => {
    render(<SpeechPage botApi={botApi(null)} />)
    await waitFor(() => expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/`))

    await userEvent.clear(screen.getByLabelText('話者ID'))
    await userEvent.type(screen.getByLabelText('話者ID'), '8')

    expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/?speaker=8`)
  })

  test('名前も読む設定にすると、URLに書き足す', async () => {
    render(<SpeechPage botApi={botApi(null)} />)
    await waitFor(() => expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/`))

    // Base UI のチェックボックスは span[role=checkbox] と隠しinputの2つになるため、役割で探す
    await userEvent.click(screen.getByRole('checkbox', { name: '発言者の名前も読む' }))

    expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/?readName=true`)
  })

  test('botが接続されていれば、そのログイン名を読み上げない人としてURLに入れる', async () => {
    render(<SpeechPage botApi={botApi(接続済みのbot)} />)

    await waitFor(() => expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/?ignore=hdad_bot`))
  })

  test('話者IDに数を入れないと、URLの代わりに理由を出す', async () => {
    render(<SpeechPage botApi={botApi(null)} />)
    await waitFor(() => expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/`))

    await userEvent.clear(screen.getByLabelText('話者ID'))

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    // 「話者ID」はラベルにもあるので、理由を出す知らせ（role=alert）の中身で確かめる
    expect(screen.getByRole('alert')).toHaveTextContent('話者IDは0〜100000の整数で入力してください')
  })

  test('botの接続状態を読めなくても、URLは出して理由を添える（未接続と取り違えないため）', async () => {
    render(<SpeechPage botApi={{ status: () => Promise.reject(new Error('セッションが切れています')) }} />)

    await waitFor(() => expect(screen.getByText(/セッションが切れています/)).toBeInTheDocument())
    expect(URLの欄()).toHaveValue(`${window.location.origin}/speech/reader/`)
  })
})
