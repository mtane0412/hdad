// @vitest-environment jsdom
/**
 * コネクターのページ（/connectors/）のテスト
 *
 * 外部のサービスとつなぐ裏方（VOICEVOX・ゆかコネNEO・Gyazo・BGM）を1つのブラウザソースで動かすURLを出し、
 * 各サービスの設定の区画（VOICEVOX・Gyazo・HDAD-tab）を並べる。各区画の中身はそれぞれのテストで確かめる。
 *
 * 確かめること:
 * - 動かす裏方はサービスの名前で選び、各サービスの区画を同じページに並べること
 * - OBSに貼るURLに、オーバーレイ用キーが入ること
 * - 動かす裏方を外すと、URLに書き足されること
 * - 画面の取り込みは既定で外れていて、入れるとURLに書き足されること
 * - 文字起こしを動かすときだけ、ポートの入力欄を出すこと
 * - ポートが読めない値なら、URLを出さずに理由を出すこと（既定へ黙って戻さない）
 * - 裏方をひとつも選んでいなければ、URLを出さずに理由を出すこと
 * - オーバーレイ用キーが無ければ、URLを出さずに理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { ScreenAdminApi, ScreenSettings } from '@/screen/api'
import type { SpeechApi, SpeechSettings } from '@/speech/api'
import { RecognitionProvider, type RecognitionDeps } from '@/transcript/recognition-context'
import { BackstagePage } from './backstage-page'

const overlayKey = 'overlay-key_0123456789abcdefghij'

/** 前提: Workerに保存されている、既定のままの読み上げの設定 */
const speechSettings: SpeechSettings = {
  host: 'localhost',
  port: 50021,
  speaker: 3,
  speed: 1,
  volume: 1,
  maxLength: 60,
  readName: false,
  ignoreLogins: [],
}

/** 前提: Workerに保存されている、既定のままの画面の取り込みの設定 */
const screenSettings: ScreenSettings = { host: 'localhost', port: 4455, password: '', intervalSeconds: 60, collectionId: '' }

const speechApi: SpeechApi = { load: () => Promise.resolve(speechSettings), save: (next) => Promise.resolve(next) }
const screenApi: ScreenAdminApi = { load: () => Promise.resolve(screenSettings), save: (next) => Promise.resolve(next) }
/** botは未接続 */
const botApi = { status: () => Promise.resolve(null) }

/** 音声認識はこのページでは動かさない（オフのまま。動かし方は recognition-context.test.tsx で確かめる） */
const recognitionDeps: RecognitionDeps = {
  api: { send: () => Promise.resolve(true) },
  createRecognition: null,
  openMicrophone: () => Promise.reject(new Error('このテストではマイクを開きません')),
  locks: { request: () => Promise.reject(new Error('このテストでは鍵を取りません')) },
  storage: { getItem: () => null, setItem: () => {} },
  connectCaption: () => ({ send: () => true, close: () => {} }),
}

const renderPage = (key: string | null = overlayKey) =>
  render(
    <RecognitionProvider deps={recognitionDeps}>
      <BackstagePage overlayKey={key} speechApi={speechApi} screenApi={screenApi} botApi={botApi} />
    </RecognitionProvider>,
  )

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const urlField = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')
/** URLの中身（toHaveValue は部分一致を受け取れないので、値そのものを取り出して調べる） */
const urlValue = () => (urlField() as HTMLInputElement).value
const speechSwitch = () => screen.getByRole('checkbox', { name: 'VOICEVOX' })
const transcriptSwitch = () => screen.getByRole('checkbox', { name: 'ゆかコネNEO' })
const screenSwitch = () => screen.getByRole('checkbox', { name: 'Gyazo' })
const bgmSwitch = () => screen.getByRole('checkbox', { name: 'BGM' })

describe('コネクターのページ', () => {
  test('VOICEVOX・Gyazo・HDAD-tab・Web Speech API の区画を同じページに並べる', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: 'VOICEVOX' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Web Speech API' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Gyazo' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'HDAD-tab' })).toBeInTheDocument()
  })

  test('ブラウザソースの置き方（推奨の大きさなど）は、ヘルプボタンを押したときだけ案内する', async () => {
    renderPage()
    expect(screen.queryByText(/600 × 600 px/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'OBS用のURLの説明' }))

    expect(await screen.findByText(/600 × 600 px/)).toBeInTheDocument()
  })

  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    renderPage()

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}`)
  })

  test('画面の取り込みは既定で外れている（OBSとGyazoの用意が要るため）', () => {
    renderPage()

    expect(screenSwitch()).not.toBeChecked()
    expect(urlValue()).not.toContain('screen=')
  })

  test('画面の取り込みを入れると、URLに書き足される', async () => {
    renderPage()

    await userEvent.click(screenSwitch())

    expect(urlValue()).toContain('screen=true')
  })

  test('BGMは既定で外れていて、入れるとURLに書き足される（貼ってあるブラウザソースが黙って鳴り出さないように）', async () => {
    renderPage()

    expect(bgmSwitch()).not.toBeChecked()
    expect(urlValue()).not.toContain('bgm=')

    await userEvent.click(bgmSwitch())

    expect(urlValue()).toContain('bgm=true')
  })

  test('URLのコピーはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    renderPage()

    const copyButton = screen.getByRole('button', { name: 'URLをコピー' })
    expect(copyButton).toHaveTextContent('')
    expect(copyButton).toHaveAttribute('title', 'URLをコピー')
  })

  test('読み上げを外すと、URLに書き足す', async () => {
    renderPage()

    await userEvent.click(speechSwitch())

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&speech=false`)
  })

  test('文字起こしを動かすときだけ、ポートの入力欄を出す', async () => {
    renderPage()

    expect(screen.getByLabelText('ゆかコネNEO のポート番号')).toBeInTheDocument()

    await userEvent.click(transcriptSwitch())

    expect(screen.queryByLabelText('ゆかコネNEO のポート番号')).not.toBeInTheDocument()
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    renderPage()

    const portField = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portField)
    await userEvent.type(portField, '20000')

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&port=20000`)
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    renderPage()

    const portField = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portField)
    await userEvent.type(portField, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('裏方をひとつも選んでいなければ、URLを出さずに理由を出す', async () => {
    renderPage()

    await userEvent.click(speechSwitch())
    await userEvent.click(transcriptSwitch())

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/1つ以上選んでください/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    renderPage(null)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
