// @vitest-environment jsdom
/**
 * 合成オーバーレイの構成のページ（オーバーレイと素材の編集、OBS用URL）のテスト
 *
 * 確かめること:
 * - 保存済みのオーバーレイと、その中の素材を前に出るものから出すこと（一覧の上が前）
 * - 素材を足す・外す・並べ替える・別のオーバーレイへ移す・位置と大きさを直せること
 * - オーバーレイ同士を一覧の中で並べ替えられること
 * - 素材のパラメータをスキーマの入力欄で調整でき、保存ではクエリ文字列になること
 * - オーバーレイを足せること・オーバーレイごとのOBS用URLを出すこと
 * - 素材を1つも持たないオーバーレイは送らないこと
 * - Workerが返した問題点を、オーバーレイと素材の名前へ読み替えて並べること
 * - 保存済みの値が読めない素材でも、黙って捨てず理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../core/api'
import type { OverlayLayoutAdminApi } from './admin-api'
import type { Overlay, OverlayItem } from './layout'
import { OverlayPage } from './overlay-page'

const オーバーレイ用キー = 'issued-overlay-key-0123456789abcdefghij'

/** 背面いっぱいに敷いた壁紙 */
const 壁紙: OverlayItem = { kind: 'wallpaper', id: 'contour', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

/** 前面の右下に置いた時計 */
const 時計: OverlayItem = { kind: 'clock', id: 'analog', params: 'size=0.5', rect: { x: 78, y: 70, width: 20, height: 26 } }

/** アバターより後ろに置くオーバーレイ */
const 背面: Overlay = { name: 'back', items: [壁紙] }

/** アバターより前に置くオーバーレイ */
const 前面: Overlay = { name: 'front', items: [時計] }

const 代役のAPI = (overrides: Partial<OverlayLayoutAdminApi> = {}): OverlayLayoutAdminApi => ({
  load: vi.fn(async () => [背面, 前面]),
  save: vi.fn(async (overlays: readonly Overlay[]) => [...overlays]),
  ...overrides,
})

const 描く = (api: OverlayLayoutAdminApi, overlayKey: string | null = オーバーレイ用キー) => render(<OverlayPage api={api} overlayKey={overlayKey} />)

/** オーバーレイ1つの領域（OBSのブラウザソース1つぶん） */
const オーバーレイの領域 = (name: string): Promise<HTMLElement> => screen.findByRole('group', { name: `オーバーレイ「${name}」` })

/** 素材1件の領域。呼び名（種類とデザイン名）で探す */
const 素材の領域 = async (overlayName: string, label: string): Promise<HTMLElement> =>
  within(await オーバーレイの領域(overlayName)).getByRole('group', { name: label })

/** その素材を開いて入力欄を出す */
const 素材を開く = async (overlayName: string, label: string): Promise<HTMLElement> => {
  const 領域 = await 素材の領域(overlayName, label)
  await userEvent.click(within(領域).getByRole('button', { name: `${label}の設定` }))
  return 領域
}

const 保存する = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: '構成を保存する' }))
}

afterEach(cleanup)

describe('オーバーレイと素材の一覧', () => {
  test('保存済みのオーバーレイを、その中の素材とともに出す', async () => {
    描く(代役のAPI())

    expect(within(await オーバーレイの領域('back')).getByRole('group', { name: '背景（Contour）' })).toBeInTheDocument()
    expect(within(await オーバーレイの領域('front')).getByRole('group', { name: '時計（Analog）' })).toBeInTheDocument()
  })

  test('素材は前に出るものから並べる（一覧の上にあるものが前）', async () => {
    const api = 代役のAPI({ load: vi.fn(async () => [{ name: 'front', items: [時計, { ...壁紙, id: 'grid' }] }]) })
    描く(api)

    // 構成では「あとのものが前」なので、一覧では並びを逆にして出す（上が前）
    const 素材 = within(await オーバーレイの領域('front')).getAllByRole('group')
    expect(素材.map((element) => element.getAttribute('aria-label'))).toEqual(['背景（Grid）', '時計（Analog）'])
  })

  test('オーバーレイが1つも無ければ、まだ何も置いていないことを知らせる', async () => {
    描く(代役のAPI({ load: vi.fn(async () => []) }))

    expect(await screen.findByText(/まだオーバーレイがありません/)).toBeInTheDocument()
  })

  test('読み込みに失敗したら理由を出す（空の構成として出さない）', async () => {
    描く(代役のAPI({ load: vi.fn(async () => Promise.reject(new Error('Workerに届きませんでした'))) }))

    expect(await screen.findByText(/Workerに届きませんでした/)).toBeInTheDocument()
  })
})

describe('素材の編集', () => {
  test('位置と大きさを直して保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材を開く('front', '時計（Analog）')
    const 幅 = within(領域).getByLabelText('幅（％）')
    await userEvent.clear(幅)
    await userEvent.type(幅, '30')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([背面, { name: 'front', items: [{ ...時計, rect: { ...時計.rect, width: 30 } }] }])
  })

  test('位置の欄を空にしたら 0 に丸めず、そのまま送ってWorkerに理由を返させる', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材を開く('front', '時計（Analog）')
    await userEvent.clear(within(領域).getByLabelText('左端の位置（％）'))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([
      背面,
      { name: 'front', items: [expect.objectContaining({ rect: expect.objectContaining({ x: Number.NaN }) })] },
    ])
  })

  test('デザインを変えると、そのデザインの素材として保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材を開く('back', '背景（Contour）')
    await userEvent.selectOptions(within(領域).getByLabelText('デザイン'), 'grid')
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([{ name: 'back', items: [{ ...壁紙, id: 'grid' }] }, 前面])
  })

  test('素材のパラメータを調整すると、クエリ文字列にして保存する', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材を開く('front', '時計（Analog）')
    await userEvent.click(within(領域).getByRole('checkbox', { name: '秒針を表示する' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([背面, { name: 'front', items: [{ ...時計, params: 'size=0.5&seconds=false' }] }])
  })

  test('素材を並べ替えると、重ねる順が入れ替わる', async () => {
    const api = 代役のAPI({ load: vi.fn(async () => [{ name: 'front', items: [時計, 壁紙] }]) })
    描く(api)

    const 領域 = await 素材の領域('front', '時計（Analog）')
    await userEvent.click(within(領域).getByRole('button', { name: '時計（Analog）をひとつ前面へ' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([{ name: 'front', items: [壁紙, 時計] }])
  })

  test('素材を別のオーバーレイへ移せる', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材を開く('front', '時計（Analog）')
    await userEvent.selectOptions(within(領域).getByLabelText('置くオーバーレイ'), 'back')
    await 保存する()

    // 移したあとの front は素材を持たなくなるので送らない
    expect(api.save).toHaveBeenCalledWith([{ name: 'back', items: [壁紙, 時計] }])
  })

  test('素材を外すときは、確かめてから外す', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await 素材の領域('front', '時計（Analog）')
    await userEvent.click(within(領域).getByRole('button', { name: '時計（Analog）を外す' }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '素材を外す' }))

    expect(within(await オーバーレイの領域('front')).queryByRole('group', { name: '時計（Analog）' })).not.toBeInTheDocument()
    await 保存する()
    expect(api.save).toHaveBeenCalledWith([背面])
  })

  test('素材を足すと、一覧のいちばん上（いちばん前）に付く', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await オーバーレイの領域('front')
    await userEvent.selectOptions(within(領域).getByLabelText('足す素材の種類'), 'alerts')
    await userEvent.click(within(領域).getByRole('button', { name: '素材を足す' }))

    const 素材 = within(await オーバーレイの領域('front')).getAllByRole('group')
    expect(素材.map((element) => element.getAttribute('aria-label'))).toEqual(['アラート', '時計（Analog）'])
  })

  test('素材を足すと、そのオーバーレイのいちばん前に、いっぱいの大きさで付く', async () => {
    const api = 代役のAPI()
    描く(api)

    const 領域 = await オーバーレイの領域('front')
    await userEvent.selectOptions(within(領域).getByLabelText('足す素材の種類'), 'alerts')
    await userEvent.click(within(領域).getByRole('button', { name: '素材を足す' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([
      背面,
      { name: 'front', items: [時計, { kind: 'alerts', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
    ])
  })
})

describe('オーバーレイ', () => {
  test('オーバーレイごとのOBS用URLを出す', async () => {
    描く(代役のAPI())

    expect(within(await オーバーレイの領域('back')).getByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(オーバーレイ用キー)}&overlay=back`,
    )
    expect(within(await オーバーレイの領域('front')).getByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(
      `${window.location.origin}/overlay/stage/?key=${encodeURIComponent(オーバーレイ用キー)}&overlay=front`,
    )
  })

  test('オーバーレイを足して素材を置くと、保存に入る', async () => {
    const api = 代役のAPI()
    描く(api)

    await userEvent.type(await screen.findByLabelText('足すオーバーレイの名前'), 'talk')
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを足す' }))

    const 領域 = await オーバーレイの領域('talk')
    await userEvent.selectOptions(within(領域).getByLabelText('足す素材の種類'), 'focus')
    await userEvent.click(within(領域).getByRole('button', { name: '素材を足す' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([
      背面,
      前面,
      { name: 'talk', items: [{ kind: 'focus', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }] },
    ])
  })

  test('素材を1つも持たないオーバーレイは送らない（貼っても何も映らないURLを作らせない）', async () => {
    const api = 代役のAPI()
    描く(api)

    await userEvent.type(await screen.findByLabelText('足すオーバーレイの名前'), 'talk')
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを足す' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([背面, 前面])
  })

  test('オーバーレイを並べ替えられる', async () => {
    const api = 代役のAPI()
    描く(api)

    await userEvent.click(within(await オーバーレイの領域('front')).getByRole('button', { name: 'オーバーレイ「front」をひとつ上へ' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([前面, 背面])
  })

  test('端のオーバーレイは、その向きへは動かせない', async () => {
    描く(代役のAPI())

    expect(within(await オーバーレイの領域('back')).getByRole('button', { name: 'オーバーレイ「back」をひとつ上へ' })).toBeDisabled()
    expect(within(await オーバーレイの領域('front')).getByRole('button', { name: 'オーバーレイ「front」をひとつ下へ' })).toBeDisabled()
  })

  test('オーバーレイを外すときは、確かめてから外す', async () => {
    const api = 代役のAPI()
    描く(api)

    await userEvent.click(within(await オーバーレイの領域('front')).getByRole('button', { name: 'オーバーレイ「front」を外す' }))
    await userEvent.click(screen.getByRole('button', { name: 'オーバーレイを外す' }))
    await 保存する()

    expect(api.save).toHaveBeenCalledWith([背面])
  })

  test('オーバーレイ用キーが無ければ、URLの代わりに理由を出す', async () => {
    描く(代役のAPI(), null)

    expect(await screen.findByText(/オーバーレイ用キーが発行されていません/)).toBeInTheDocument()
    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
  })
})

describe('保存', () => {
  test('入力を変えたら「未保存の変更があります」と添える', async () => {
    描く(代役のAPI())

    const 領域 = await 素材を開く('front', '時計（Analog）')
    expect(screen.queryByText(/未保存の変更があります/)).not.toBeInTheDocument()

    await userEvent.click(within(領域).getByRole('checkbox', { name: '秒針を表示する' }))

    expect(screen.getByText(/未保存の変更があります/)).toBeInTheDocument()
  })

  test('Workerが返した問題点は、オーバーレイと素材の名前へ読み替えて並べる', async () => {
    const problems = ['overlays[1].items[0].rect.width: 1〜100 の数（％）で指定してください']
    const api = 代役のAPI({
      save: vi.fn(async () => Promise.reject(new ApiError(400, 'invalid-config', 'オーバーレイの構成に問題があります', problems))),
    })
    描く(api)

    await オーバーレイの領域('front')
    await 保存する()

    expect(await screen.findByText(/「front」の「時計（Analog）」の 幅: 1〜100 の数（％）で指定してください/)).toBeInTheDocument()
  })
})

describe('保存済みの値が読めない素材', () => {
  test('黙って捨てず、理由を出す', async () => {
    const api = 代役のAPI({ load: vi.fn(async () => [{ name: 'front', items: [{ ...時計, id: 'sundial' }] }]) })
    描く(api)

    expect(await screen.findByText(/デザイン「sundial」は登録されていません/)).toBeInTheDocument()
    expect(await 素材の領域('front', '時計（sundial）')).toBeInTheDocument()
  })
})
