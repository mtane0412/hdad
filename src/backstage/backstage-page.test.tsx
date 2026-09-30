// @vitest-environment jsdom
/**
 * 裏方のページのテスト
 *
 * 確かめること:
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
import { BackstagePage } from './backstage-page'

const overlayKey = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const urlField = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')
/** URLの中身（toHaveValue は部分一致を受け取れないので、値そのものを取り出して調べる） */
const urlValue = () => (urlField() as HTMLInputElement).value
const speechSwitch = () => screen.getByRole('checkbox', { name: 'チャットの読み上げ' })
const transcriptSwitch = () => screen.getByRole('checkbox', { name: '文字起こしの中継' })
const screenSwitch = () => screen.getByRole('checkbox', { name: '配信画面の取り込み' })
const bgmSwitch = () => screen.getByRole('checkbox', { name: 'BGM' })

describe('裏方のページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}`)
  })

  test('画面の取り込みは既定で外れている（OBSとGyazoの用意が要るため）', () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    expect(screenSwitch()).not.toBeChecked()
    expect(urlValue()).not.toContain('screen=')
  })

  test('画面の取り込みを入れると、URLに書き足される', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    await userEvent.click(screenSwitch())

    expect(urlValue()).toContain('screen=true')
  })

  test('BGMは既定で外れていて、入れるとURLに書き足される（貼ってあるブラウザソースが黙って鳴り出さないように）', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    expect(bgmSwitch()).not.toBeChecked()
    expect(urlValue()).not.toContain('bgm=')

    await userEvent.click(bgmSwitch())

    expect(urlValue()).toContain('bgm=true')
  })

  test('URLのコピーはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    const copyButton = screen.getByRole('button', { name: 'URLをコピー' })
    expect(copyButton).toHaveTextContent('')
    expect(copyButton).toHaveAttribute('title', 'URLをコピー')
  })

  test('読み上げを外すと、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    await userEvent.click(speechSwitch())

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&speech=false`)
  })

  test('文字起こしを動かすときだけ、ポートの入力欄を出す', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    expect(screen.getByLabelText('ゆかコネNEO のポート番号')).toBeInTheDocument()

    await userEvent.click(transcriptSwitch())

    expect(screen.queryByLabelText('ゆかコネNEO のポート番号')).not.toBeInTheDocument()
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    const portField = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portField)
    await userEvent.type(portField, '20000')

    expect(urlField()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(overlayKey)}&port=20000`)
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    const portField = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(portField)
    await userEvent.type(portField, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('裏方をひとつも選んでいなければ、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={overlayKey} />)

    await userEvent.click(speechSwitch())
    await userEvent.click(transcriptSwitch())

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/1つ以上選んでください/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<BackstagePage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
