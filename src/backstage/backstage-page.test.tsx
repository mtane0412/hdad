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

const オーバーレイ用キー = 'overlay-key_0123456789abcdefghij'

afterEach(cleanup)

/** URLの入力欄（伏せ字で出しているので、ラベルから引く） */
const URLの欄 = () => screen.getByLabelText('OBSのブラウザソースに貼るURL')
/** URLの中身（toHaveValue は部分一致を受け取れないので、値そのものを取り出して調べる） */
const URLの値 = () => (URLの欄() as HTMLInputElement).value
const 読み上げのスイッチ = () => screen.getByRole('checkbox', { name: 'チャットの読み上げ' })
const 文字起こしのスイッチ = () => screen.getByRole('checkbox', { name: '文字起こしの中継' })
const 画面の取り込みのスイッチ = () => screen.getByRole('checkbox', { name: '配信画面の取り込み' })
const BGMのスイッチ = () => screen.getByRole('checkbox', { name: 'BGM' })

describe('裏方のページ', () => {
  test('OBSに貼るURLに、オーバーレイ用キーを入れて出す', () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}`)
  })

  test('画面の取り込みは既定で外れている（OBSとGyazoの用意が要るため）', () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(画面の取り込みのスイッチ()).not.toBeChecked()
    expect(URLの値()).not.toContain('screen=')
  })

  test('画面の取り込みを入れると、URLに書き足される', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    await userEvent.click(画面の取り込みのスイッチ())

    expect(URLの値()).toContain('screen=true')
  })

  test('BGMは既定で外れていて、入れるとURLに書き足される（貼ってあるブラウザソースが黙って鳴り出さないように）', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(BGMのスイッチ()).not.toBeChecked()
    expect(URLの値()).not.toContain('bgm=')

    await userEvent.click(BGMのスイッチ())

    expect(URLの値()).toContain('bgm=true')
  })

  test('URLのコピーはアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const コピーのボタン = screen.getByRole('button', { name: 'URLをコピー' })
    expect(コピーのボタン).toHaveTextContent('')
    expect(コピーのボタン).toHaveAttribute('title', 'URLをコピー')
  })

  test('読み上げを外すと、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    await userEvent.click(読み上げのスイッチ())

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&speech=false`)
  })

  test('文字起こしを動かすときだけ、ポートの入力欄を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    expect(screen.getByLabelText('ゆかコネNEO のポート番号')).toBeInTheDocument()

    await userEvent.click(文字起こしのスイッチ())

    expect(screen.queryByLabelText('ゆかコネNEO のポート番号')).not.toBeInTheDocument()
  })

  test('ポートを既定から変えると、URLに書き足す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, '20000')

    expect(URLの欄()).toHaveValue(`${window.location.origin}/overlay/backstage/?key=${encodeURIComponent(オーバーレイ用キー)}&port=20000`)
  })

  test('ポートが読めない値なら、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    const ポートの欄 = screen.getByLabelText('ゆかコネNEO のポート番号')
    await userEvent.clear(ポートの欄)
    await userEvent.type(ポートの欄, 'ななまんばん')

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/ポート番号は/)).toBeInTheDocument()
  })

  test('裏方をひとつも選んでいなければ、URLを出さずに理由を出す', async () => {
    render(<BackstagePage overlayKey={オーバーレイ用キー} />)

    await userEvent.click(読み上げのスイッチ())
    await userEvent.click(文字起こしのスイッチ())

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/1つ以上選んでください/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければ、URLを出さずに理由を出す', () => {
    render(<BackstagePage overlayKey={null} />)

    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
    expect(screen.getByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
  })
})
