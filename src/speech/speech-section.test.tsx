// @vitest-environment jsdom
/**
 * コネクターのページの VOICEVOX（チャットの読み上げ）の区画のテスト
 *
 * 確かめること:
 * - 区画の見出しはサービス名（VOICEVOX）であること
 * - 保存済みの設定を読み込んで入力欄に出し、変えて保存できること
 * - Workerが返した問題点を、そのまま画面に並べること（検証はWorkerだけが持つ）
 * - VOICEVOX 側のCORSの設定は、ヘルプボタンを押したときだけ案内すること
 * - 合成先・ホスト・ポートを変えたときは、OBSの再読み込みが要ると知らせること
 * - 合成先にさくらのAI Engine を選ぶと、従量課金であることを知らせること
 * - 設定やbotの接続状態を読めなかったときは、黙って既定に倒さず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { BotStatus } from '@/bot/api'
import { ApiError } from '@/core/api'
import { SpeechSection } from './speech-section'
import type { SpeechApi, SpeechSettings } from './api'

afterEach(cleanup)

/** 前提: botアカウント「hdad_bot」が接続されている */
const connectedBot: BotStatus = { userId: '123456789', login: 'hdad_bot', missingScopes: [], isModerator: true }

/** 前提: Workerに保存されている、既定のままの設定 */
const savedConfig: SpeechSettings = {
  engine: 'local',
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
const speechApi = (settings: SpeechSettings = savedConfig): SpeechApi & { saved: SpeechSettings[] } => {
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

const renderPage = (overrides: { api?: SpeechApi; bot?: BotStatus | null } = {}) =>
  render(<SpeechSection api={overrides.api ?? speechApi()} botApi={botApi(overrides.bot ?? null)} />)

/** 設定が読み込まれて、入力欄が出るまで待つ */
const waitForLoad = async () => {
  await waitFor(() => expect(screen.getByLabelText('話者ID')).toBeInTheDocument())
}

const save = async () => userEvent.click(screen.getByRole('button', { name: 'VOICEVOXの設定を保存' }))

describe('VOICEVOX の区画', () => {
  test('見出しはサービス名（VOICEVOX）にする', async () => {
    renderPage()
    await waitForLoad()

    expect(screen.getByRole('heading', { name: 'VOICEVOX' })).toBeInTheDocument()
  })

  test('VOICEVOX 側のCORSの設定は、ヘルプボタンを押したときだけ案内する', async () => {
    renderPage()
    await waitForLoad()
    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'VOICEVOXの説明' }))

    expect(await screen.findByText(window.location.origin)).toBeInTheDocument()
    expect(screen.getByText('http://localhost:50021/setting')).toBeInTheDocument()
  })

  test('保存済みの設定を読み込んで入力欄に出す', async () => {
    const api = speechApi({ ...savedConfig, speaker: 8, volume: 0.5, readName: true, ignoreLogins: ['hdad_bot', 'nightbot'] })
    renderPage({ api })

    await waitForLoad()

    expect(screen.getByLabelText('話者ID')).toHaveValue(8)
    expect(screen.getByLabelText('音量')).toHaveValue(0.5)
    expect(screen.getByRole('checkbox', { name: '発言者の名前も読む' })).toBeChecked()
    expect(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）')).toHaveValue('hdad_bot, nightbot')
  })


  test('変えた設定をWorkerへ保存し、保存できたことを知らせる', async () => {
    const api = speechApi()
    renderPage({ api })
    await waitForLoad()

    await userEvent.clear(screen.getByLabelText('話者ID'))
    await userEvent.type(screen.getByLabelText('話者ID'), '8')
    await userEvent.click(screen.getByRole('checkbox', { name: '発言者の名前も読む' }))
    await save()

    await waitFor(() => expect(api.saved).toEqual([{ ...savedConfig, speaker: 8, readName: true }]))
    expect(screen.getByRole('status')).toHaveTextContent('読み上げの設定を保存しました')
  })

  test('読み上げない人はカンマで区切って送る（まわりの空白は落とす）', async () => {
    const api = speechApi()
    renderPage({ api })
    await waitForLoad()

    await userEvent.type(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）'), 'hdad_bot, nightbot')
    await save()

    await waitFor(() => expect(api.saved[0]?.ignoreLogins).toEqual(['hdad_bot', 'nightbot']))
  })

  test('Workerが問題点を返したら、その理由をそのまま並べる（検証はWorkerだけが持つ）', async () => {
    const api = {
      ...speechApi(),
      save: () =>
        Promise.reject(new ApiError(400, 'invalid-config', '読み上げの設定に問題があります', ['port: 1〜65535 の整数で指定してください'])),
    }
    renderPage({ api })
    await waitForLoad()

    await save()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('port: 1〜65535 の整数で指定してください'))
  })


  test('ホストかポートを変えたら、OBSの再読み込みが要ることを知らせる', async () => {
    renderPage()
    await waitForLoad()
    expect(screen.queryByText('OBSの再読み込みが必要です')).not.toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText('ポート番号'))
    await userEvent.type(screen.getByLabelText('ポート番号'), '50022')

    expect(screen.getByText('OBSの再読み込みが必要です')).toBeInTheDocument()
  })

  test('合成先にさくらのAI Engine を選んで保存できる', async () => {
    const api = speechApi()
    renderPage({ api })
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('合成先'), 'sakura')
    await save()

    await waitFor(() => expect(api.saved).toEqual([{ ...savedConfig, engine: 'sakura' }]))
  })

  test('さくらのAI Engine を選ぶと、従量課金であることを知らせる（費用がかかることに気づけるようにする）', async () => {
    renderPage()
    await waitForLoad()
    expect(screen.queryByText(/3円\/1万モーラ/)).not.toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('合成先'), 'sakura')

    expect(screen.getByText(/3円\/1万モーラ/)).toBeInTheDocument()
  })

  test('さくらのAI Engine を選んでいるあいだは、ホストとポートの欄を出さない（さくらでは使わないため）', async () => {
    renderPage({ api: speechApi({ ...savedConfig, engine: 'sakura' }) })
    await waitForLoad()

    expect(screen.queryByLabelText('ホスト')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('ポート番号')).not.toBeInTheDocument()
  })

  test('合成先を変えたら、OBSの再読み込みが要ることを知らせる', async () => {
    renderPage()
    await waitForLoad()

    await userEvent.selectOptions(screen.getByLabelText('合成先'), 'sakura')

    expect(screen.getByText('OBSの再読み込みが必要です')).toBeInTheDocument()
  })

  test('botが接続されていれば、読み上げない人に追加するボタンを出す（botの応答を読み上げさせないため）', async () => {
    const api = speechApi()
    renderPage({ api, bot: connectedBot })
    await waitForLoad()

    await userEvent.click(await screen.findByRole('button', { name: 'hdad_bot を読み上げない人に追加する' }))

    expect(screen.getByLabelText('読み上げない人（ログイン名をカンマ区切り）')).toHaveValue('hdad_bot')
  })

  test('botがすでに読み上げない人に入っていれば、追加するボタンは出さない', async () => {
    renderPage({ api: speechApi({ ...savedConfig, ignoreLogins: ['hdad_bot'] }), bot: connectedBot })
    await waitForLoad()

    await waitFor(() => expect(screen.queryByRole('button', { name: /読み上げない人に追加する/ })).not.toBeInTheDocument())
  })

  test('設定を読めなければ、入力欄を出さずに理由を出す（黙って既定に倒さない）', async () => {
    renderPage({ api: { load: () => Promise.reject(new Error('セッションが切れています')), save: () => Promise.reject(new Error('保存できません')) } })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('セッションが切れています'))
    expect(screen.queryByLabelText('話者ID')).not.toBeInTheDocument()
  })

  test('botの接続状態を読めなくても、設定は出して理由を添える（未接続と取り違えないため）', async () => {
    render(
      <SpeechSection api={speechApi()} botApi={{ status: () => Promise.reject(new Error('セッションが切れています')) }} />,
    )

    await waitFor(() => expect(screen.getByText(/セッションが切れています/)).toBeInTheDocument())
    expect(screen.getByLabelText('話者ID')).toBeInTheDocument()
  })

})
