// @vitest-environment jsdom
/**
 * 合成オーバーレイの構成のページ（レイヤーの編集とOBS用URL）のテスト
 *
 * 確かめること:
 * - 保存済みのレイヤーを、重ねる順に一覧へ出すこと
 * - レイヤーを足す・外す・並べ替える・段を変える・位置と大きさを直せること
 * - 素材のパラメータをスキーマの入力欄で調整でき、保存ではクエリ文字列になること
 * - 段ごとのOBS用URLを出すこと
 * - Workerが返した問題点を、レイヤーの名前へ読み替えて並べること
 * - 保存済みの値が読めないレイヤーでも、黙って捨てず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../core/api'
import type { OverlayLayoutAdminApi } from './admin-api'
import type { OverlayLayer } from './layout'
import { OverlayPage } from './overlay-page'

const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

/** 背面いっぱいに敷いた壁紙 */
const 壁紙のレイヤー: OverlayLayer = { kind: 'wallpaper', id: 'contour', params: '', group: 'back', rect: { x: 0, y: 0, width: 100, height: 100 } }

/** 前面の右下に置いた時計 */
const 時計のレイヤー: OverlayLayer = { kind: 'clock', id: 'analog', params: 'size=0.5', group: 'front', rect: { x: 78, y: 70, width: 20, height: 26 } }

const 代役のAPI = (overrides: Partial<OverlayLayoutAdminApi> = {}): OverlayLayoutAdminApi => ({
  load: vi.fn(async () => [壁紙のレイヤー, 時計のレイヤー]),
  save: vi.fn(async (layers: readonly OverlayLayer[]) => [...layers]),
  ...overrides,
})

const 描く = (api: OverlayLayoutAdminApi, overlayKey: string | null = オーバーレイ用キー) =>
  render(<OverlayPage api={api} overlayKey={overlayKey} />)

/** レイヤー1件の領域。呼び名（種類とデザイン名）で探す */
const レイヤーの領域 = (label: string): Promise<HTMLElement> => screen.findByRole('group', { name: label })

/** そのレイヤーを開いて入力欄を出す */
const レイヤーを開く = async (label: string): Promise<HTMLElement> => {
  const 領域 = await レイヤーの領域(label)
  await userEvent.click(within(領域).getByRole('button', { name: `${label}の設定` }))
  return 領域
}

const 保存する = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: '構成を保存する' }))
}

afterEach(cleanup)

describe('レイヤーの一覧', () => {
  test('保存済みのレイヤーを、重ねる順（あとのものが前）に出す', async () => {
    描く(代役のAPI())

    const レイヤー = await screen.findAllByRole('group', { name: /背景|時計/ })
    expect(レイヤー.map((element) => element.getAttribute('aria-label'))).toEqual(['背景（Contour）', '時計（Analog）'])
  })

  test('レイヤーが1件も無ければ、まだ何も置いていないことを知らせる', async () => {
    描く(代役のAPI({ load: vi.fn(async () => []) }))

    expect(await screen.findByText(/まだレイヤーがありません/)).toBeInTheDocument()
  })

  test('読み込みに失敗したら理由を出す（空の構成として出さない）', async () => {
    描く(代役のAPI({ load: vi.fn(async () => Promise.reject(new Error('Workerに届きませんでした'))) }))

    expect(await screen.findByText(/Workerに届きませんでした/)).toBeInTheDocument()
  })
})

describe('レイヤーの編集', () => {
  test('位置と大きさを直して保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーを開く('時計（Analog）')
    const 幅 = within(領域).getByLabelText('幅（％）')
    await userEvent.clear(幅)
    await userEvent.type(幅, '30')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー, { ...時計のレイヤー, rect: { ...時計のレイヤー.rect, width: 30 } }])
  })

  test('位置の欄を空にしたら 0 に丸めず、そのまま送ってWorkerに理由を返させる', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーを開く('時計（Analog）')
    await userEvent.clear(within(領域).getByLabelText('左端の位置（％）'))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー, expect.objectContaining({ rect: expect.objectContaining({ x: Number.NaN }) })])
  })

  test('段を変えて保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーを開く('時計（Analog）')
    await userEvent.selectOptions(within(領域).getByLabelText('段'), 'back')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー, { ...時計のレイヤー, group: 'back' }])
  })

  test('デザインを変えると、そのデザインのパラメータの入力欄になる', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーを開く('背景（Contour）')
    await userEvent.selectOptions(within(領域).getByLabelText('デザイン'), 'grid')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([{ ...壁紙のレイヤー, id: 'grid' }, 時計のレイヤー])
  })

  test('素材のパラメータを調整すると、クエリ文字列にして保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーを開く('時計（Analog）')
    await userEvent.click(within(領域).getByRole('checkbox', { name: '秒針を表示する' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー, { ...時計のレイヤー, params: 'size=0.5&seconds=false' }])
  })

  test('レイヤーを並べ替えると、重ねる順が入れ替わる', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーの領域('背景（Contour）')
    await userEvent.click(within(領域).getByRole('button', { name: '背景（Contour）をひとつ前面へ' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([時計のレイヤー, 壁紙のレイヤー])
  })

  test('レイヤーを外すときは、確かめてから外す', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await レイヤーの領域('時計（Analog）')
    await userEvent.click(within(領域).getByRole('button', { name: '時計（Analog）を外す' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'レイヤーを外す' }))

    expect(screen.queryByRole('group', { name: '時計（Analog）' })).not.toBeInTheDocument()
    await 保存する()
    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー])
  })

  test('レイヤーを足すと、段いっぱいの大きさで末尾（いちばん前）に付く', async () => {
    const api = 代役のAPI()
    描く(api)

    await screen.findByRole('group', { name: '時計（Analog）' })
    await userEvent.selectOptions(screen.getByLabelText('足すレイヤーの種類'), 'alerts')
    await userEvent.click(screen.getByRole('button', { name: 'レイヤーを足す' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([
      壁紙のレイヤー,
      時計のレイヤー,
      { kind: 'alerts', id: '', params: '', group: 'back', rect: { x: 0, y: 0, width: 100, height: 100 } },
    ])
  })
})

describe('段', () => {
  test('段ごとのOBS用URLを出す', async () => {
    描く(代役のAPI())

    expect(await screen.findByLabelText('back の段のOBS用URL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(オーバーレイ用キー)}&group=back`,
    )
    expect(screen.getByLabelText('front の段のOBS用URL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(オーバーレイ用キー)}&group=front`,
    )
  })

  test('段を足すと、レイヤーの段として選べるようになる', async () => {
    const api = 代役のAPI()
    描く(api)

    await userEvent.type(await screen.findByLabelText('足す段の名前'), 'talk')
    await userEvent.click(screen.getByRole('button', { name: '段を足す' }))

    const 領域 = await レイヤーを開く('時計（Analog）')
    await userEvent.selectOptions(within(領域).getByLabelText('段'), 'talk')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([壁紙のレイヤー, { ...時計のレイヤー, group: 'talk' }])
  })

  test('オーバーレイ用キーが無ければ、URLの代わりに理由を出す', async () => {
    描く(代役のAPI(), null)

    expect(await screen.findByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
    expect(screen.queryByLabelText('back の段のOBS用URL')).not.toBeInTheDocument()
  })
})

describe('保存', () => {
  test('入力を変えたら「未保存の変更があります」と添える', async () => {
    描く(代役のAPI())

    const 領域 = await レイヤーを開く('時計（Analog）')
    expect(screen.queryByText(/未保存の変更があります/)).not.toBeInTheDocument()

    await userEvent.selectOptions(within(領域).getByLabelText('段'), 'back')

    expect(screen.getByText(/未保存の変更があります/)).toBeInTheDocument()
  })

  test('Workerが返した問題点は、レイヤーの名前へ読み替えて並べる', async () => {
    const problems = ['layers[1].rect.width: 1〜100 の数（％）で指定してください']
    const api = 代役のAPI({
      save: vi.fn(async () => Promise.reject(new ApiError(400, 'invalid-config', 'オーバーレイの構成に問題があります', problems))),
    })
    描く(api)

    await screen.findByRole('group', { name: '時計（Analog）' })
    await 保存する()

    expect(await screen.findByText(/「時計（Analog）」の 幅: 1〜100 の数（％）で指定してください/)).toBeInTheDocument()
  })
})

describe('保存済みの値が読めないレイヤー', () => {
  test('黙って捨てず、理由を出す', async () => {
    const api = 代役のAPI({ load: vi.fn(async () => [{ ...時計のレイヤー, id: 'sundial' }]) })
    描く(api)

    expect(await screen.findByText(/デザイン「sundial」は登録されていません/)).toBeInTheDocument()
    expect(await レイヤーの領域('時計（sundial）')).toBeInTheDocument()
  })
})
