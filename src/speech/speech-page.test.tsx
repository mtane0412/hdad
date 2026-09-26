// @vitest-environment jsdom
/**
 * チャットの読み上げのページのテスト
 *
 * 確かめること:
 * - 保存済みの設定を読み込んで入力欄に出し、変えて保存できること
 * - Workerが返した問題点を、そのまま画面に並べること（検証はWorkerだけが持つ）
 * - OBSに貼るURLにはオーバーレイ用キーしか入らないこと
 * - ホスト・ポートを変えたときは、OBSの再読み込みが要ると知らせること
 * - 設定やbotの接続状態を読めなかったときは、黙って既定に倒さず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { BotStatus } from '@/bot/api'
import { ApiError } from '@/core/api'
import { SpeechPage } from './speech-page'
import type { SpeechApi, SpeechSettings } from './api'

afterEach(cleanup)

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

/** 前提: botアカウント「hdad_bot」が接続されている */
const 接続済みのbot: BotStatus = { userId: '123456789', login: 'hdad_bot', missingScopes: [], isModerator: true }

/** 前提: Workerに保存されている、既定のままの設定 */
const 保存済みの設定: SpeechSettings = {
  host: 'localhost',
  port: 50021,
  speaker: 3,
  speed: 1,
  volume: 1,
  maxLength: 60,
  readName: false,
  ignoreLogins: [],
}

/** botの接続状態を返すだけのAPI */
const botApi = (status: BotStatus | null) => ({ status: () => Promise.resolve(status) })

/** 読み書きを記録する、読み上げの設定のAPI */
const speechApi = (settings: SpeechSettings = 保存済みの設定): SpeechApi & { saved: SpeechSettings[] } => {
  const saved: SpeechSettings[] = []
  return {
    saved,
    load: () => Promise.resolve(settings),
    save: (next) => {
      saved.push(next)
      return Promise.resolve(next)
    },
  }
}

const 描く = (overrides: { api?: SpeechApi; bot?: BotStatus | null; key?: string | null } = {}) =>
  render(
    <SpeechPage
      api={overrides.api ?? speechApi()}
      botApi={botApi(overrides.bot ?? null)}
      overlayKey={overrides.key === undefined ? オーバーレイ用キー : overrides.key}
    />,
  )

/** 設定が読み込まれて、入力欄が出るまで待つ */
const 読み込みを待つ = async () => {
  await waitFor(() => expect(screen.getByLabelText('話者ID')).toBeInTheDocument())
}

const 保存する = async () => userEvent.click(screen.getByRole('button', { name: '設定を保存' }))

describe('チャットの読み上げのページ', () => {
  test('保存済みの設定を読み込んで入力欄に出す', async () => {
    const api = speechApi({ ...保存済みの設定, speaker: 8, volume: 0.5, readName: true, ignoreLogins: ['hdad_bot', 'nightbot'] })
    描く({ api })

    await 読み込みを待つ()

    expect(screen.getByLabelText('話者ID')).toHaveValue(8)
    expect(screen.getByLabelText('音量')).toHaveValue(0.5)
    expect(screen.getByRole('checkbox', { name: '発言者の名前も読む' })).toBeChecked()
    expect(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）')).toHaveValue('hdad_bot, nightbot')
  })

  test('変えた設定をWorkerへ保存し、保存できたことを知らせる', async () => {
    const api = speechApi()
    描く({ api })
    await 読み込みを待つ()

    await userEvent.clear(screen.getByLabelText('話者ID'))
    await userEvent.type(screen.getByLabelText('話者ID'), '8')
    await userEvent.click(screen.getByRole('checkbox', { name: '発言者の名前も読む' }))
    await 保存する()

    await waitFor(() => expect(api.saved).toEqual([{ ...保存済みの設定, speaker: 8, readName: true }]))
    expect(screen.getByRole('status')).toHaveTextContent('読み上げの設定を保存しました')
  })

  test('読み上げない人はカンマで区切って送る（まわりの空白は落とす）', async () => {
    const api = speechApi()
    描く({ api })
    await 読み込みを待つ()

    await userEvent.type(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）'), 'hdad_bot, nightbot')
    await 保存する()

    await waitFor(() => expect(api.saved[0]?.ignoreLogins).toEqual(['hdad_bot', 'nightbot']))
  })

  test('Workerが問題点を返したら、その理由をそのまま並べる（検証はWorkerだけが持つ）', async () => {
    const api = {
      ...speechApi(),
      save: () =>
        Promise.reject(new ApiError(400, 'invalid-config', '読み上げの設定に問題があります', ['port: 1〜65535 の整数で指定してください'])),
    }
    描く({ api })
    await 読み込みを待つ()

    await 保存する()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('port: 1〜65535 の整数で指定してください'))
  })

  test('OBSに貼るURLには、オーバーレイ用キーだけが入る', async () => {
    描く()
    await 読み込みを待つ()

    expect(screen.getByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(
      `${window.location.origin}/speech/reader/?key=${オーバーレイ用キー}`,
    )
  })

  test('ホストかポートを変えたら、OBSの再読み込みが要ることを知らせる', async () => {
    描く()
    await 読み込みを待つ()
    expect(screen.queryByText('OBSの再読み込みが必要です')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText('VOICEVOX のポート番号'))
    await userEvent.type(screen.getByLabelText('VOICEVOX のポート番号'), '50022')

    expect(screen.getByText('OBSの再読み込みが必要です')).toBeInTheDocument()
  })

  test('botが接続されていれば、読み上げない人に足すボタンを出す（botの応答を読み上げさせないため）', async () => {
    const api = speechApi()
    描く({ api, bot: 接続済みのbot })
    await 読み込みを待つ()

    await userEvent.click(await screen.findByRole('button', { name: 'hdad_bot を読み上げない人に足す' }))

    expect(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）')).toHaveValue('hdad_bot')
  })

  test('botがすでに読み上げない人に入っていれば、足すボタンは出さない', async () => {
    描く({ api: speechApi({ ...保存済みの設定, ignoreLogins: ['hdad_bot'] }), bot: 接続済みのbot })
    await 読み込みを待つ()

    await waitFor(() => expect(screen.queryByRole('button', { name: /読み上げない人に足す/ })).not.toBeInTheDocument())
  })

  test('設定を読めなければ、入力欄を出さずに理由を出す（黙って既定に倒さない）', async () => {
    描く({ api: { load: () => Promise.reject(new Error('セッションが切れています')), save: () => Promise.reject(new Error('保存できません')) } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('セッションが切れています'))
    expect(screen.queryByLabelText('話者ID')).not.toBeInTheDocument()
  })

  test('botの接続状態を読めなくても、設定は出して理由を添える（未接続と取り違えないため）', async () => {
    render(
      <SpeechPage api={speechApi()} botApi={{ status: () => Promise.reject(new Error('セッションが切れています')) }} overlayKey={オーバーレイ用キー} />,
    )

    await waitFor(() => expect(screen.getByText(/セッションが切れています/)).toBeInTheDocument())
    expect(screen.getByLabelText('話者ID')).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLの代わりに理由を出す', async () => {
    描く({ key: null })
    await 読み込みを待つ()

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
